import { randomUUID } from 'node:crypto'
import { decodeEventLog,encodeFunctionData,getAddress,isAddress,zeroAddress,type Address,type Hex } from 'viem'
import { MAINNET_ADDRESSES } from 'hoodchain'
import type { Market } from '../framework/market.js'
import type { Journal,ExternalEventRecord,WalletActivityRecord } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import type { Asset } from './types.js'
import { HubError } from './manual-swaps.js'
import { launchFactoryV2Abi,launchTokenAbi,saleV2Abi,tokenFactoryAbi } from './launchpad-v2-abi.js'

export type LaunchV2Action='create'|'contribute'|'claim'|'refund'|'withdrawProceeds'|'withdrawRemainder'|'finalizeLiquidity'|'withdrawLiquidityDust'
export interface LaunchV2Terms {
  name:string;symbol:string;wholeSaleSupply:string;wholeLiquidityTokens:string;metadataURI:string
  softCapWei:string;hardCapWei:string;durationSeconds:string;liquidityBps:number;liquidityFee:number;liquidityRecipient:Address
}
export interface LaunchpadV2Status {
  chainId:number;configured:boolean;factory:Address|null;deploymentBlock:string|null
  status:'not-configured'|'configuration-error'|'ready'|'unavailable';message:string;killed:boolean
  version:'v2';amm:{weth:Address;uniswapV3Factory:Address;positionManager:Address}
}
export interface PreparedLaunchV2 {
  kind:'launchpad-v2-plan';signing:'user-wallet';planId:string;chainId:number;account:Address;action:LaunchV2Action
  factory:Address;sale?:Address;launchId?:string;terms?:LaunchV2Terms;amount:string;expiresAt:number
  transaction:{to:Address;data:Hex;value:string};simulation:'passed';gasEstimate:string;estimatedNetworkFeeWei:string;gasReserveWei:string
  poolAtCreation:boolean;permissionlessFinalize:boolean
}
export interface SaleV2Snapshot {
  launchId:string;sale:Address;token:Address;creator:Address;pool:Address;name:string;symbol:string;metadataURI:string
  saleSupply:string;liquidityTokenReserve:string;totalRaised:string;softCap:string;hardCap:string;deadline:string;participants:string
  status:'active'|'successful'|'failed';contribution:string|null;allocation:string|null
  proceedsWithdrawn:boolean;remainderWithdrawn:boolean;liquidityFinalized:boolean;liquidityRecipient:Address
  liquidityBps:number;liquidityFee:number;liquidityEthReserve:string;remainderAvailable?:string
  blockNumber:string;observedAt:number;creationTxHash:string;version:'v2'
}

interface Options {chainId:number;factory?:string;deploymentBlock?:string;isKilled:()=>boolean;journal:Journal;registry:AssetRegistry}
const source='hub-launchpad-v2'
const SNAPSHOT_LIMIT=100n
const FEE_TIERS=new Set([100,500,3000,10000])
const eventAbi=launchFactoryV2Abi.find(x=>x.type==='event'&&x.name==='LaunchCreatedV2')!
const actionTitles:Record<LaunchV2Action,string>={
  create:'Create V2 token, sale, and empty pool',contribute:'Contribute ETH',claim:'Claim tokens',refund:'Refund contribution',
  withdrawProceeds:'Withdraw creator proceeds (raised minus liquidity reserve)',withdrawRemainder:'Withdraw remaining sale tokens',
  finalizeLiquidity:'Finalize Uniswap v3 liquidity (permissionless)',withdrawLiquidityDust:'Withdraw unused liquidity dust',
}
const actionKinds={create:'launch-v2-create',contribute:'launch-v2-contribute',claim:'launch-v2-claim',refund:'launch-v2-refund',
  withdrawProceeds:'launch-v2-proceeds',withdrawRemainder:'launch-v2-remainder',finalizeLiquidity:'launch-v2-finalize',withdrawLiquidityDust:'launch-v2-dust'} as const

function account(v:unknown):Address {if(typeof v!=='string'||!isAddress(v)||v.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ADDRESS','Enter a valid wallet address.');return getAddress(v)}
function integer(v:unknown,min:bigint,max:bigint,label:string):bigint {if(typeof v!=='string'||!/^\d{1,78}$/.test(v)||BigInt(v)<min||BigInt(v)>max)throw new HubError(400,'INVALID_TERMS','Invalid '+label+'.');return BigInt(v)}
function fields(input:Record<string,unknown>,allowed:string[]){if(Object.keys(input).some(k=>!allowed.includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Unsupported V2 launch field.')}

export class LaunchpadV2Service {
  readonly factory:Address|null
  readonly deploymentBlock:bigint|null
  readonly amm={weth:MAINNET_ADDRESSES.weth as Address,uniswapV3Factory:MAINNET_ADDRESSES.uniswapV3Factory as Address,positionManager:MAINNET_ADDRESSES.nonfungiblePositionManager as Address}
  private error=''
  private lastScan=0
  private scanning:Promise<void>|null=null
  private timer:ReturnType<typeof setInterval>|null=null
  private running:Promise<void>|null=null
  constructor(private market:Market,private options:Options){
    if(market.client.wallet||market.client.account)throw new Error('LaunchpadV2Service requires a signer-free Market')
    this.factory=options.factory&&isAddress(options.factory)&&options.factory.toLowerCase()!==zeroAddress?getAddress(options.factory):null
    this.deploymentBlock=options.deploymentBlock&&/^\d{1,20}$/.test(options.deploymentBlock)?BigInt(options.deploymentBlock):null
    if((options.factory||options.deploymentBlock)&&(!this.factory||this.deploymentBlock===null))this.error='Configure both HUB_LAUNCH_FACTORY_V2 and HUB_LAUNCH_FACTORY_V2_BLOCK.'
    if(this.factory&&!this.error)for(const e of this.records())if(e.status==='confirmed'&&e.data.asset)options.registry.registerDiscovered(e.data.asset as Asset)
  }
  private records(){return this.options.journal.externalEvents('launch',200,this.options.chainId).filter(e=>e.source===source&&e.data.factory===this.factory)}
  private requireFactory():Address {if(this.error)throw new HubError(503,'LAUNCH_V2_CONFIGURATION',this.error);if(!this.factory||this.deploymentBlock===null)throw new HubError(503,'LAUNCH_V2_NOT_CONFIGURED','LaunchFactoryV2 is not configured. Set HUB_LAUNCH_FACTORY_V2 after a reviewed deploy.');return this.factory}
  private guard(){if(this.options.isKilled())throw new HubError(409,'KILLED','New wallet preparations are halted.')}
  private async network(){if(await this.market.client.public.getChainId()!==this.options.chainId)throw new HubError(409,'CHAIN_MISMATCH','Launch V2 RPC network mismatch.')}
  private async checkFactory(){
    const factory=this.requireFactory(),rpc=this.market.client.public
    await this.network()
    const [code,head,weth,uni,pm]=await Promise.all([
      rpc.getCode({address:factory}),rpc.getBlockNumber(),
      rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'weth'}),
      rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'uniswapV3Factory'}),
      rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'positionManager'}),
    ])
    if(head<this.deploymentBlock!)throw new HubError(503,'DEPLOYMENT_BLOCK','Configured V2 deployment block is ahead of the RPC.')
    if(!code||code==='0x')throw new HubError(503,'FACTORY_UNAVAILABLE','No contract exists at HUB_LAUNCH_FACTORY_V2.')
    if(weth.toLowerCase()!==this.amm.weth.toLowerCase()||uni.toLowerCase()!==this.amm.uniswapV3Factory.toLowerCase()||pm.toLowerCase()!==this.amm.positionManager.toLowerCase())
      throw new HubError(503,'AMM_MISMATCH','Configured LaunchFactoryV2 is not pinned to the reviewed Uniswap v3 / WETH addresses.')
    const tokenFactory=await rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'tokenFactory'})
    const parent=await rpc.readContract({address:tokenFactory,abi:tokenFactoryAbi,functionName:'launchFactory'})
    if(parent.toLowerCase()!==factory.toLowerCase())throw new HubError(503,'FACTORY_MISMATCH','The V2 token factory is not bound to this LaunchFactoryV2.')
    return factory
  }
  async status():Promise<LaunchpadV2Status>{
    const base={chainId:this.options.chainId,configured:!!this.factory&&this.deploymentBlock!==null&&!this.error,factory:this.factory,deploymentBlock:this.deploymentBlock?.toString()??null,killed:this.options.isKilled(),version:'v2' as const,amm:this.amm}
    if(this.error)return {...base,status:'configuration-error',message:this.error}
    if(!base.configured)return {...base,status:'not-configured',message:'LaunchFactoryV2 is undeployed by default. Deploy via the browser V2 adapter, then set HUB_LAUNCH_FACTORY_V2.'}
    try{await this.checkFactory();return {...base,status:'ready',message:'Configured LaunchFactoryV2 is reachable. Pool is created empty at launch; finalizeLiquidity is permissionless after success.'}}
    catch{return {...base,status:'unavailable',message:'Configured LaunchFactoryV2 or RPC is unavailable. Wallet actions are paused.'}}
  }
  private terms(input:Record<string,unknown>):LaunchV2Terms {
    const name=typeof input.name==='string'?input.name.trim():'',symbol=typeof input.symbol==='string'?input.symbol:''
    if(!name||Buffer.byteLength(name)>64||!/^[A-Z0-9]{1,12}$/.test(symbol))throw new HubError(400,'INVALID_TERMS','Use a name up to 64 bytes and a ticker of 1-12 uppercase letters or digits.')
    const wholeSaleSupply=integer(input.wholeSaleSupply??input.wholeSupply,1000n,1000000000000000n,'sale supply')
    const wholeLiquidityTokens=integer(input.wholeLiquidityTokens,1n,1000000000000000n,'liquidity token reserve')
    const softCap=integer(input.softCapWei,1000000000000000n,10000n*10n**18n,'minimum raise')
    const hardCap=integer(input.hardCapWei,softCap,10000n*10n**18n,'target raise')
    const duration=integer(input.durationSeconds,3600n,2592000n,'duration')
    const liquidityBps=Number(input.liquidityBps),liquidityFee=Number(input.liquidityFee)
    if(!Number.isInteger(liquidityBps)||liquidityBps<1||liquidityBps>5000)throw new HubError(400,'INVALID_TERMS','Liquidity BPS must be 1-5000 (max 50% of raised ETH).')
    if(!Number.isInteger(liquidityFee)||!FEE_TIERS.has(liquidityFee))throw new HubError(400,'INVALID_TERMS','Choose a supported Uniswap v3 fee tier.')
    const liquidityRecipient=account(input.liquidityRecipient)
    const description=input.description??'',image=input.image??''
    if(typeof description!=='string'||description.length>500||typeof image!=='string'||image.length>512)throw new HubError(400,'INVALID_METADATA','Description or image URL is too long.')
    if(image){let valid=image.startsWith('ipfs://')&&image.length>7;try{valid ||= new URL(image).protocol==='https:'}catch{};if(!valid)throw new HubError(400,'INVALID_METADATA','Use an HTTPS or IPFS image URL.')}
    const metadataURI='data:application/json;base64,'+Buffer.from(JSON.stringify({description,image})).toString('base64')
    if(Buffer.byteLength(metadataURI)>4096)throw new HubError(400,'INVALID_METADATA','Metadata exceeds the contract limit.')
    return {name,symbol,wholeSaleSupply:wholeSaleSupply.toString(),wholeLiquidityTokens:wholeLiquidityTokens.toString(),metadataURI,softCapWei:softCap.toString(),hardCapWei:hardCap.toString(),durationSeconds:duration.toString(),liquidityBps,liquidityFee,liquidityRecipient}
  }
  async prepare(input:Record<string,unknown>):Promise<PreparedLaunchV2>{
    const action=input.action as LaunchV2Action
    if(!Object.hasOwn(actionTitles,action))throw new HubError(400,'INVALID_ACTION','Choose a supported V2 launch action.')
    const createFields=['chainId','account','action','name','symbol','wholeSaleSupply','wholeLiquidityTokens','softCapWei','hardCapWei','durationSeconds','liquidityBps','liquidityFee','liquidityRecipient','description','image','wholeSupply']
    fields(input,action==='create'?createFields:['chainId','account','action','launchId',...(action==='contribute'?['amount']:[])])
    if(String(input.chainId)!==String(this.options.chainId))throw new HubError(409,'CHAIN_MISMATCH','V2 launch action belongs to another network.')
    const owner=account(input.account);this.guard()
    const terms=action==='create'?this.terms(input):undefined
    const factory=await this.checkFactory(),rpc=this.market.client.public
    let sale:Address|undefined,launchId:string|undefined,data:Hex,value=0n
    if(terms){
      data=encodeFunctionData({abi:launchFactoryV2Abi,functionName:'createLaunchV2',args:[
        terms.name,terms.symbol,BigInt(terms.wholeSaleSupply),BigInt(terms.wholeLiquidityTokens),terms.metadataURI,
        BigInt(terms.softCapWei),BigInt(terms.hardCapWei),BigInt(terms.durationSeconds),terms.liquidityBps,terms.liquidityFee,terms.liquidityRecipient,
      ]})
    } else {
      launchId=integer(input.launchId,0n,(1n<<256n)-1n,'launch ID').toString()
      const matches=await rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'getLaunches',args:[BigInt(launchId),1n]})
      if(matches.length!==1)throw new HubError(404,'SALE_NOT_FOUND','This sale is not registered by LaunchFactoryV2.')
      sale=matches[0]!
      if(action==='contribute'){value=integer(input.amount,1n,(1n<<256n)-1n,'contribution');data=encodeFunctionData({abi:saleV2Abi,functionName:'contribute'})}
      else if(action==='finalizeLiquidity')data=encodeFunctionData({abi:saleV2Abi,functionName:'finalizeLiquidity'})
      else if(action==='withdrawLiquidityDust')data=encodeFunctionData({abi:saleV2Abi,functionName:'withdrawLiquidityDust',args:[owner]})
      else if(action==='withdrawProceeds'||action==='withdrawRemainder'||action==='claim'||action==='refund')
        data=encodeFunctionData({abi:saleV2Abi,functionName:action,args:[owner]})
      else throw new HubError(400,'INVALID_ACTION','Unsupported V2 sale action.')
    }
    const transaction={to:sale??factory,data,value:value.toString()}
    const [balance,price]=await Promise.all([rpc.getBalance({address:owner,blockTag:'pending'}),rpc.getGasPrice()])
    if(price<=0n)throw new HubError(503,'FEE_UNAVAILABLE','Network fee estimate is unavailable.')
    let gas:bigint
    try{gas=await rpc.estimateGas({account:owner,to:transaction.to,data,value})}catch{throw new HubError(422,'LAUNCH_SIMULATION','This V2 action cannot currently execute. Check sale status, LP recipient, amount and ETH for gas.')}
    if(gas<=0n)throw new HubError(503,'FEE_UNAVAILABLE','Network gas estimate is unavailable.')
    const reserve=(gas*price*3n+1n)/2n
    if(balance<value+reserve)throw new HubError(422,'GAS_RESERVE','Leave enough ETH for the contribution and network fees.')
    this.guard()
    const now=Date.now(),planId=randomUUID()
    const plan:PreparedLaunchV2={kind:'launchpad-v2-plan',signing:'user-wallet',planId,chainId:this.options.chainId,account:owner,action,factory,sale,launchId,terms,amount:value.toString(),expiresAt:now+60000,transaction,simulation:'passed',gasEstimate:gas.toString(),estimatedNetworkFeeWei:(gas*price).toString(),gasReserveWei:reserve.toString(),poolAtCreation:true,permissionlessFinalize:true}
    this.options.journal.recordWalletPlan({id:planId,chainId:plan.chainId,account:owner,createdAt:now,expiresAt:plan.expiresAt,actions:[{kind:actionKinds[action],...transaction}]})
    this.options.journal.recordDecision({agentId:'hub:manual',ts:now,kind:'observe',detail:'Unsigned V2 launch action prepared: '+actionTitles[action],meta:{mode:'manual',planId,owner,action,factory,version:'v2'}})
    return plan
  }
  async observeHash(hash:Hex){
    const factory=await this.checkFactory(),rpc=this.market.client.public
    const receipt=await rpc.getTransactionReceipt({hash})
    const [block,head]=await Promise.all([rpc.getBlock({blockNumber:receipt.blockNumber}),rpc.getBlockNumber()])
    if(receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||receipt.status!=='success'||block.hash!==receipt.blockHash||head<receipt.blockNumber||receipt.blockNumber<this.deploymentBlock!)throw new HubError(409,'LAUNCH_UNVERIFIED','V2 factory receipt is not canonical.')
    const events:ExternalEventRecord[]=[]
    for(const log of receipt.logs){
      if(log.removed||log.logIndex===null||log.address.toLowerCase()!==factory.toLowerCase())continue
      let decoded
      try{decoded=decodeEventLog({abi:launchFactoryV2Abi,data:log.data,topics:log.topics,strict:true})}catch{continue}
      if(decoded.eventName!=='LaunchCreatedV2')continue
      const a=decoded.args
      const sales=await rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'getLaunches',args:[a.id,1n],blockNumber:receipt.blockNumber})
      if(sales[0]?.toLowerCase()!==a.sale.toLowerCase())throw new HubError(409,'LAUNCH_UNVERIFIED','V2 factory event does not match the sale registry.')
      const [saleToken,creator,pool]=await Promise.all([
        rpc.readContract({address:a.sale,abi:saleV2Abi,functionName:'token',blockNumber:receipt.blockNumber}),
        rpc.readContract({address:a.sale,abi:saleV2Abi,functionName:'creator',blockNumber:receipt.blockNumber}),
        rpc.readContract({address:a.sale,abi:saleV2Abi,functionName:'pool',blockNumber:receipt.blockNumber}),
      ])
      if(saleToken.toLowerCase()!==a.token.toLowerCase()||creator.toLowerCase()!==a.creator.toLowerCase()||pool.toLowerCase()!==a.pool.toLowerCase())throw new HubError(409,'LAUNCH_UNVERIFIED','SaleV2 does not match LaunchCreatedV2.')
      const asset={address:a.token,symbol:a.symbol.slice(0,32),name:a.name.slice(0,100),decimals:18,type:'launch-token' as const,source,tradable:false}
      const now=Date.now(),confirmed=head-receipt.blockNumber+1n>=2n
      const event:ExternalEventRecord={id:'launch-v2:'+this.options.chainId+':'+hash.toLowerCase()+':'+log.logIndex,type:'launch',source,chainId:this.options.chainId,txHash:hash,owner:a.creator,at:Number(block.timestamp)*1000,observedAt:now,status:confirmed?'confirmed':'confirming',verification:'chain-event',title:a.symbol+' launched (V2)',detail:'Token, empty pool, and SaleV2 created by '+a.creator,data:{factory,version:'v2',launchId:a.id.toString(),sale:a.sale,token:a.token,pool:a.pool,creator:a.creator,name:a.name,symbol:a.symbol,metadataURI:a.metadataURI,liquidityRecipient:a.liquidityRecipient,liquidityBps:Number(a.liquidityBps),liquidityFee:Number(a.liquidityFee),asset,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,tradeEnabled:false}}
      this.options.journal.recordExternalEvent(event,confirmed&&now-event.at>=600000?Number.MAX_SAFE_INTEGER:now+60000)
      if(confirmed)this.options.registry.registerDiscovered(asset)
      events.push(event)
    }
    if(!events.length)throw new HubError(409,'LAUNCH_UNVERIFIED','No matching LaunchCreatedV2 event was emitted by the configured V2 factory.')
    return events
  }
  async observeWallet(event:WalletActivityRecord){
    if(event.kind!=='launch-v2-create')return
    if(event.status==='confirmed')await this.observeHash(event.txHash as Hex)
    else if(event.status==='unverified'||event.status==='reverted')this.invalidate(event.txHash)
  }
  private invalidate(hash:string){
    for(const e of this.records().filter(e=>e.txHash.toLowerCase()===hash.toLowerCase())){
      const other=this.records().some(row=>row.id!==e.id&&row.txHash.toLowerCase()!==hash.toLowerCase()&&row.status==='confirmed'&&row.data.token===e.data.token)
      if(!other)this.options.registry.removeDiscovered(e.data.token as Address)
      this.options.journal.recordExternalEvent({...e,status:'unverified',verification:'unverified',observedAt:Date.now()},Date.now()+60000)
    }
  }
  async scan(force=false){
    if(!this.factory||this.error)return
    if(this.scanning)return this.scanning
    if(!force&&Date.now()-this.lastScan<60000)return
    this.scanning=(async()=>{
      await this.checkFactory()
      const rpc=this.market.client.public,head=await rpc.getBlockNumber()
      if(head<this.deploymentBlock!)throw new HubError(503,'DEPLOYMENT_BLOCK','Configured V2 deployment block is ahead of the RPC.')
      const floor=head>30000n?head-30000n:0n,from=this.deploymentBlock!>floor?this.deploymentBlock!:floor
      const hashes=new Set<Hex>()
      for(let start=from;start<=head;start+=10000n){
        const end=start+9999n<head?start+9999n:head
        const logs=await rpc.getLogs({address:this.factory!,event:eventAbi,fromBlock:start,toBlock:end,strict:true})
        for(const log of logs)if(log.transactionHash&&!log.removed)hashes.add(log.transactionHash)
      }
      for(const hash of [...hashes].slice(-24))await this.observeHash(hash)
      this.lastScan=Date.now()
    })().finally(()=>{this.scanning=null})
    return this.scanning
  }
  async recent(){
    if(!this.factory||this.error)return []
    const {launches}=await this.list()
    return launches.map(e=>({
      launchpad:'hub-launchpad-v2',id:e.launchId,token:e.token,creator:e.creator,sale:e.sale,pool:e.pool,
      blockNumber:e.blockNumber,transactionHash:e.creationTxHash||e.sale,name:e.name,symbol:e.symbol,
      metadataURI:e.metadataURI,asset:this.options.registry.get(e.token)??{address:e.token,symbol:e.symbol,name:e.name,decimals:18,type:'launch-token' as const,source,tradable:false},
      tradeEnabled:false,verification:e.creationTxHash?'confirmed':'registry',version:'v2' as const,
    }))
  }
  async list(owner?:string|null){
    const wallet=owner?account(owner):undefined
    if(!this.factory||this.error)return {launches:[] as SaleV2Snapshot[],observedAt:Date.now(),coverage:'No configured LaunchFactoryV2.',incomplete:false,version:'v2' as const}
    const factory=await this.checkFactory()
    const rpc=this.market.client.public
    const block=await rpc.getBlockNumber()
    const count=await rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'launchCount',blockNumber:block})
    const take=count>SNAPSHOT_LIMIT?SNAPSHOT_LIMIT:count
    const page=take===0n?[]:await rpc.readContract({address:factory,abi:launchFactoryV2Abi,functionName:'getLaunches',args:[0n,take],blockNumber:block})
    const seen=new Map(this.records().filter(e=>e.status==='confirmed'||e.status==='confirming').map(e=>[String(e.data.sale||'').toLowerCase(),e]))
    const launches:SaleV2Snapshot[]=[]
    let unread=0
    for(let i=0;i<page.length;i++){
      const sale=page[i]
      if(!sale||!isAddress(sale)||sale.toLowerCase()===zeroAddress){unread++;continue}
      try{launches.push(await this.snapshotSale(getAddress(sale),String(i),wallet,block,seen.get(sale.toLowerCase())))}
      catch{unread++}
    }
    launches.reverse()
    const omitted=count>BigInt(page.length)
    return {
      launches,observedAt:Date.now(),incomplete:omitted||unread>0,version:'v2' as const,
      coverage:omitted?`First ${page.length} of ${count.toString()} V2 factory sales at block ${block.toString()}.`
        :unread?`V2 factory registry at block ${block.toString()}; ${unread} sale${unread===1?'':'s'} could not be read.`
        :`V2 factory registry at block ${block.toString()}; ${launches.length} sale${launches.length===1?'':'s'}.`,
    }
  }
  private async snapshotSale(sale:Address,launchId:string,wallet:Address|undefined,block:bigint,seen?:ExternalEventRecord):Promise<SaleV2Snapshot>{
    const rpc=this.market.client.public
    const [token,creator,pool,saleSupply,liqTokens,raised,soft,hard,deadline,participants,status,proceeds,remainder,finalized,recipient,bps,fee,ethReserve,contribution,allocation,totalAllocated]=await Promise.all([
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'token',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'creator',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'pool',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'saleSupply',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityTokenReserve',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'totalRaised',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'softCap',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'hardCap',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'deadline',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'participants',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'status',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'proceedsWithdrawn',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'remainderWithdrawn',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityFinalized',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityRecipient',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityBps',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityFee',blockNumber:block}),
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'liquidityEthReserve',blockNumber:block}),
      wallet?rpc.readContract({address:sale,abi:saleV2Abi,functionName:'contributions',args:[wallet],blockNumber:block}):null,
      wallet?rpc.readContract({address:sale,abi:saleV2Abi,functionName:'allocations',args:[wallet],blockNumber:block}):null,
      rpc.readContract({address:sale,abi:saleV2Abi,functionName:'totalAllocated',blockNumber:block}),
    ])
    if(!isAddress(token)||token.toLowerCase()===zeroAddress||!isAddress(creator)||creator.toLowerCase()===zeroAddress)throw new Error('incomplete sale')
    const [tokenName,tokenSymbol,tokenUri]=await Promise.all([
      rpc.readContract({address:token,abi:launchTokenAbi,functionName:'name',blockNumber:block}).catch(()=>''),
      rpc.readContract({address:token,abi:launchTokenAbi,functionName:'symbol',blockNumber:block}).catch(()=>''),
      rpc.readContract({address:token,abi:launchTokenAbi,functionName:'metadataURI',blockNumber:block}).catch(()=>''),
    ])
    const name=typeof tokenName==='string'&&tokenName?tokenName:typeof seen?.data.name==='string'?seen.data.name as string:''
    const symbol=typeof tokenSymbol==='string'&&tokenSymbol?tokenSymbol:typeof seen?.data.symbol==='string'?seen.data.symbol as string:''
    const metadataURI=typeof tokenUri==='string'&&tokenUri?tokenUri:typeof seen?.data.metadataURI==='string'?seen.data.metadataURI as string:''
    if(!name||!symbol)throw new Error('incomplete sale')
    this.options.registry.registerDiscovered({address:getAddress(token),symbol:symbol.slice(0,32),name:name.slice(0,100),decimals:18,type:'launch-token',source,tradable:false})
    return {
      launchId,sale:getAddress(sale),token:getAddress(token),creator:getAddress(creator),pool:getAddress(pool),name,symbol,metadataURI,
      saleSupply:saleSupply.toString(),liquidityTokenReserve:liqTokens.toString(),totalRaised:raised.toString(),softCap:soft.toString(),hardCap:hard.toString(),
      deadline:deadline.toString(),participants:participants.toString(),status:(['active','successful','failed'] as const)[status]!,
      contribution:contribution?.toString()??null,allocation:allocation?.toString()??null,proceedsWithdrawn:proceeds,remainderWithdrawn:remainder,
      liquidityFinalized:finalized,liquidityRecipient:getAddress(recipient),liquidityBps:Number(bps),liquidityFee:Number(fee),liquidityEthReserve:ethReserve.toString(),
      remainderAvailable:(remainder||status===0?0n:status===2?saleSupply:saleSupply-totalAllocated).toString(),
      blockNumber:block.toString(),observedAt:Date.now(),creationTxHash:typeof seen?.txHash==='string'?seen.txHash:'',version:'v2',
    }
  }
  start(){
    if(this.timer||!this.factory||this.error)return
    const tick=()=>{if(this.running)return;this.running=(async()=>{
      for(const e of this.options.journal.dueExternalEvents('launch',Date.now(),10,[source])){
        if(e.data.factory!==this.factory){this.options.journal.deferExternalEvent(e.id,Number.MAX_SAFE_INTEGER);continue}
        this.options.journal.deferExternalEvent(e.id,Date.now()+60000)
        try{await this.observeHash(e.txHash as Hex)}catch(error){if((error instanceof HubError&&error.code==='LAUNCH_UNVERIFIED')||missingReceipt(error))this.invalidate(e.txHash)}
      }
      await this.scan()
    })().catch(()=>undefined).finally(()=>{this.running=null})}
    this.timer=setInterval(tick,60000);this.timer.unref();tick()
  }
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=null;await this.running;await this.scanning?.catch(()=>undefined)}
}

function missingReceipt(error:unknown):boolean {
  const seen=new Set<object>();while(error&&typeof error==='object'&&!seen.has(error)){seen.add(error);const e=error as {name?:string;cause?:unknown};if(e.name==='TransactionReceiptNotFoundError')return true;error=e.cause}return false
}
