import { randomUUID } from 'node:crypto'
import { decodeEventLog,encodeFunctionData,getAddress,isAddress,zeroAddress,type Address,type Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal,ExternalEventRecord,WalletActivityRecord } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import type { Asset } from './types.js'
import { HubError } from './manual-swaps.js'
import { launchFactoryAbi,saleAbi,tokenFactoryAbi } from './launchpad-abi.js'
import { launchActionKinds,launchActionTitles,type LaunchAction,type LaunchTerms,type PreparedLaunch,type SaleSnapshot,type LaunchpadStatus } from './launchpad-types.js'
interface Options {chainId:number;factory?:string;deploymentBlock?:string;isKilled:()=>boolean;journal:Journal;registry:AssetRegistry}
const source='hub-launchpad'
const eventAbi=launchFactoryAbi.find(x=>x.type==='event'&&x.name==='LaunchCreated')!
function account(v:unknown):Address {if(typeof v!=='string'||!isAddress(v)||v.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ADDRESS','Enter a valid wallet address.');return getAddress(v)}
function integer(v:unknown,min:bigint,max:bigint,label:string):bigint {if(typeof v!=='string'||!/^\d{1,78}$/.test(v)||BigInt(v)<min||BigInt(v)>max)throw new HubError(400,'INVALID_TERMS','Invalid '+label+'.');return BigInt(v)}
function fields(input:Record<string,unknown>,allowed:string[]){if(Object.keys(input).some(k=>!allowed.includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Unsupported launch field.')}
export class LaunchpadService {
 readonly factory:Address|null
 readonly deploymentBlock:bigint|null
 private error=''
 private lastScan=0
 private scanning:Promise<void>|null=null
 private timer:ReturnType<typeof setInterval>|null=null
 private running:Promise<void>|null=null
 constructor(private market:Market,private options:Options){
  if(market.client.wallet||market.client.account)throw new Error('LaunchpadService requires a signer-free Market')
  this.factory=options.factory&&isAddress(options.factory)&&options.factory.toLowerCase()!==zeroAddress?getAddress(options.factory):null
  this.deploymentBlock=options.deploymentBlock&&/^\d{1,20}$/.test(options.deploymentBlock)?BigInt(options.deploymentBlock):null
  if((options.factory||options.deploymentBlock)&&(!this.factory||this.deploymentBlock===null))this.error='Configure both a valid launch factory and its deployment block.'
  if(this.factory&&!this.error)for(const e of this.records())if(e.status==='confirmed'&&e.data.asset)options.registry.registerDiscovered(e.data.asset as Asset)
 }
 private records(){return this.options.journal.externalEvents('launch',200,this.options.chainId).filter(e=>e.source===source&&e.data.factory===this.factory)}
 private requireFactory():Address {if(this.error)throw new HubError(503,'LAUNCH_CONFIGURATION',this.error);if(!this.factory||this.deploymentBlock===null)throw new HubError(503,'LAUNCH_NOT_CONFIGURED','A reviewed launch factory has not been configured for this Hub.');return this.factory}
 private guard(){if(this.options.isKilled())throw new HubError(409,'KILLED','New wallet preparations are halted.')}
 private async network(){
  if(await this.market.client.public.getChainId()!==this.options.chainId)throw new HubError(409,'CHAIN_MISMATCH','Launch RPC network mismatch.')
 }
 private async checkFactory(){
  const factory=this.requireFactory(),rpc=this.market.client.public
  await this.network()
  const [code,head]=await Promise.all([rpc.getCode({address:factory}),rpc.getBlockNumber()])
  if(head<this.deploymentBlock!)throw new HubError(503,'DEPLOYMENT_BLOCK','Configured deployment block is ahead of the RPC.')
  if(!code||code==='0x')throw new HubError(503,'FACTORY_UNAVAILABLE','No contract exists at the configured launch factory.')
  const tokenFactory=await rpc.readContract({address:factory,abi:launchFactoryAbi,functionName:'tokenFactory'})
  const parent=await rpc.readContract({address:tokenFactory,abi:tokenFactoryAbi,functionName:'launchFactory'})
  if(parent.toLowerCase()!==factory.toLowerCase())throw new HubError(503,'FACTORY_MISMATCH','The token factory is not bound to this launch factory.')
  return factory
 }
 async status():Promise<LaunchpadStatus>{
  const base={chainId:this.options.chainId,configured:!!this.factory&&this.deploymentBlock!==null&&!this.error,factory:this.factory,deploymentBlock:this.deploymentBlock?.toString()??null,killed:this.options.isKilled()}
  if(this.error)return {...base,status:'configuration-error',message:this.error}
  if(!base.configured)return {...base,status:'not-configured',message:'Live creation requires a reviewed factory deployment. You can still use the separate token playground.'}
  try{await this.checkFactory();return {...base,status:'ready',message:'Configured factory is reachable. Each wallet action requires review and confirmation.'}}
  catch{return {...base,status:'unavailable',message:'The configured factory or RPC is unavailable. Wallet actions are paused.'}}
 }
 private terms(input:Record<string,unknown>):LaunchTerms {
  const name=typeof input.name==='string'?input.name.trim():'',symbol=typeof input.symbol==='string'?input.symbol:''
  if(!name||Buffer.byteLength(name)>64||!/^[A-Z0-9]{1,12}$/.test(symbol))throw new HubError(400,'INVALID_TERMS','Use a name up to 64 bytes and a ticker of 1-12 uppercase letters or digits.')
  const wholeSupply=integer(input.wholeSupply,1000n,1000000000000000n,'whole token supply')
  const softCap=integer(input.softCapWei,1000000000000000n,10000n*10n**18n,'minimum raise')
  const hardCap=integer(input.hardCapWei,softCap,10000n*10n**18n,'target raise')
  const duration=integer(input.durationSeconds,3600n,2592000n,'duration')
  const description=input.description??'',image=input.image??''
  if(typeof description!=='string'||description.length>500||typeof image!=='string'||image.length>512)throw new HubError(400,'INVALID_METADATA','Description or image URL is too long.')
  if(image){let valid=image.startsWith('ipfs://')&&image.length>7;try{valid ||= new URL(image).protocol==='https:'}catch{};if(!valid)throw new HubError(400,'INVALID_METADATA','Use an HTTPS or IPFS image URL.')}
  const metadataURI='data:application/json;base64,'+Buffer.from(JSON.stringify({description,image})).toString('base64')
  if(Buffer.byteLength(metadataURI)>4096)throw new HubError(400,'INVALID_METADATA','Metadata exceeds the contract limit.')
  return {name,symbol,wholeSupply:wholeSupply.toString(),metadataURI,softCapWei:softCap.toString(),hardCapWei:hardCap.toString(),durationSeconds:duration.toString()}
 }
 async prepare(input:Record<string,unknown>):Promise<PreparedLaunch>{
  const action=input.action as LaunchAction
  if(!Object.hasOwn(launchActionKinds,action))throw new HubError(400,'INVALID_ACTION','Choose a supported launch action.')
  fields(input,action==='create'?['chainId','account','action','name','symbol','wholeSupply','softCapWei','hardCapWei','durationSeconds','description','image']:['chainId','account','action','launchId',...(action==='contribute'?['amount']:[])])
  if(String(input.chainId)!==String(this.options.chainId))throw new HubError(409,'CHAIN_MISMATCH','Launch action belongs to another network.')
  const owner=account(input.account);this.guard()
  const terms=action==='create'?this.terms(input):undefined
  const factory=await this.checkFactory(),rpc=this.market.client.public
  let sale:Address|undefined,launchId:string|undefined,data:Hex,value=0n
  if(terms)data=encodeFunctionData({abi:launchFactoryAbi,functionName:'createLaunch',args:[terms.name,terms.symbol,BigInt(terms.wholeSupply),terms.metadataURI,BigInt(terms.softCapWei),BigInt(terms.hardCapWei),BigInt(terms.durationSeconds)]})
  else {
   launchId=integer(input.launchId,0n,(1n<<256n)-1n,'launch ID').toString()
   const matches=await rpc.readContract({address:factory,abi:launchFactoryAbi,functionName:'getLaunches',args:[BigInt(launchId),1n]})
   if(matches.length!==1)throw new HubError(404,'SALE_NOT_FOUND','This sale is not registered by the configured factory.')
   sale=matches[0]!
   if(action==='withdrawRemainder'){
    const [state,supply,allocated,withdrawn]=await Promise.all([rpc.readContract({address:sale,abi:saleAbi,functionName:'status'}),rpc.readContract({address:sale,abi:saleAbi,functionName:'supply'}),rpc.readContract({address:sale,abi:saleAbi,functionName:'totalAllocated'}),rpc.readContract({address:sale,abi:saleAbi,functionName:'remainderWithdrawn'})])
    if(withdrawn||(state===1&&supply<=allocated))throw new HubError(422,'NO_REMAINDER','No unsold tokens remain to withdraw. ETH proceeds use the separate proceeds withdrawal action.')
   }
   if(action==='contribute'){value=integer(input.amount,1n,(1n<<256n)-1n,'contribution');data=encodeFunctionData({abi:saleAbi,functionName:'contribute'})}
   else data=encodeFunctionData({abi:saleAbi,functionName:action as 'claim'|'refund'|'withdrawProceeds'|'withdrawRemainder',args:[owner]})
  }
  const transaction={to:sale??factory,data,value:value.toString()}
  const [balance,price]=await Promise.all([rpc.getBalance({address:owner,blockTag:'pending'}),rpc.getGasPrice()])
  if(price<=0n)throw new HubError(503,'FEE_UNAVAILABLE','Network fee estimate is unavailable.')
  let gas:bigint
  try{gas=await rpc.estimateGas({account:owner,to:transaction.to,data,value})}catch{throw new HubError(422,'LAUNCH_SIMULATION','This action cannot currently execute. Check sale status, wallet permissions, amount and ETH for gas.')}
  if(gas<=0n)throw new HubError(503,'FEE_UNAVAILABLE','Network gas estimate is unavailable.')
  const reserve=(gas*price*3n+1n)/2n
  if(balance<value+reserve)throw new HubError(422,'GAS_RESERVE','Leave enough ETH for the contribution and network fees.')
  this.guard()
  const now=Date.now(),planId=randomUUID()
  const plan:PreparedLaunch={kind:'launchpad-plan',signing:'user-wallet',planId,chainId:this.options.chainId,account:owner,action,factory,sale,launchId,terms,amount:value.toString(),expiresAt:now+60000,transaction,simulation:'passed',gasEstimate:gas.toString(),estimatedNetworkFeeWei:(gas*price).toString(),gasReserveWei:reserve.toString()}
  this.options.journal.recordWalletPlan({id:planId,chainId:plan.chainId,account:owner,createdAt:now,expiresAt:plan.expiresAt,actions:[{kind:launchActionKinds[action],...transaction}]})
  this.options.journal.recordDecision({agentId:'hub:manual',ts:now,kind:'observe',detail:'Unsigned launch action prepared: '+launchActionTitles[action],meta:{mode:'manual',planId,owner,action,factory}})
  return plan
 }
 async observeHash(hash:Hex){
  const factory=await this.checkFactory(),rpc=this.market.client.public
  const receipt=await rpc.getTransactionReceipt({hash})
  const [block,head]=await Promise.all([rpc.getBlock({blockNumber:receipt.blockNumber}),rpc.getBlockNumber()])
  if(receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||receipt.status!=='success'||block.hash!==receipt.blockHash||head<receipt.blockNumber||receipt.blockNumber<this.deploymentBlock!)throw new HubError(409,'LAUNCH_UNVERIFIED','Factory receipt is not canonical.')
  const events:ExternalEventRecord[]=[]
  for(const log of receipt.logs){
   if(log.removed||log.logIndex===null||log.address.toLowerCase()!==factory.toLowerCase())continue
   let decoded
   try{decoded=decodeEventLog({abi:launchFactoryAbi,data:log.data,topics:log.topics,strict:true})}catch{continue}
   if(decoded.eventName!=='LaunchCreated')continue
   const a=decoded.args
   const sales=await rpc.readContract({address:factory,abi:launchFactoryAbi,functionName:'getLaunches',args:[a.id,1n],blockNumber:receipt.blockNumber})
   if(sales[0]?.toLowerCase()!==a.sale.toLowerCase())throw new HubError(409,'LAUNCH_UNVERIFIED','Factory event does not match the sale registry.')
   const [saleToken,creator]=await Promise.all([rpc.readContract({address:a.sale,abi:saleAbi,functionName:'token',blockNumber:receipt.blockNumber}),rpc.readContract({address:a.sale,abi:saleAbi,functionName:'creator',blockNumber:receipt.blockNumber})])
   if(saleToken.toLowerCase()!==a.token.toLowerCase()||creator.toLowerCase()!==a.creator.toLowerCase())throw new HubError(409,'LAUNCH_UNVERIFIED','Sale contract does not match the factory event.')
   const asset={address:a.token,symbol:a.symbol.slice(0,32),name:a.name.slice(0,100),decimals:18,type:'launch-token' as const,source,tradable:false}
   const now=Date.now(),confirmed=head-receipt.blockNumber+1n>=2n
   const event:ExternalEventRecord={id:'launch:'+this.options.chainId+':'+hash.toLowerCase()+':'+log.logIndex,type:'launch',source,chainId:this.options.chainId,txHash:hash,owner:a.creator,at:Number(block.timestamp)*1000,observedAt:now,status:confirmed?'confirmed':'confirming',verification:'chain-event',title:a.symbol+' launched',detail:'Token and escrow sale created by '+a.creator,data:{factory,launchId:a.id.toString(),sale:a.sale,token:a.token,creator:a.creator,name:a.name,symbol:a.symbol,metadataURI:a.metadataURI,asset,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,tradeEnabled:false}}
   this.options.journal.recordExternalEvent(event,confirmed&&now-event.at>=600000?Number.MAX_SAFE_INTEGER:now+60000)
   if(confirmed)this.options.registry.registerDiscovered(asset)
   events.push(event)
  }
  if(!events.length)throw new HubError(409,'LAUNCH_UNVERIFIED','No matching launch event was emitted by the configured factory.')
  return events
 }
 async observeWallet(event:WalletActivityRecord){
  if(event.kind!=='launch-create')return
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
   if(head<this.deploymentBlock!)throw new HubError(503,'DEPLOYMENT_BLOCK','Configured deployment block is ahead of the RPC.')
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
  await this.scan()
  return this.records().filter(e=>e.status==='confirmed'||e.status==='confirming')
   .sort((a,b)=>b.at-a.at).slice(0,24).map(e=>({
    launchpad:'hub-launchpad',id:e.data.launchId,token:e.data.token,creator:e.data.creator,sale:e.data.sale,
    pool:null,blockNumber:e.data.blockNumber,transactionHash:e.txHash,name:e.data.name,symbol:e.data.symbol,
    metadataURI:e.data.metadataURI,asset:this.options.registry.get(e.data.token as Address)??e.data.asset,
    tradeEnabled:false,verification:e.status,
   }))
 }
 async list(owner?:string|null){
  const wallet=owner?account(owner):undefined
  if(!this.factory||this.error)return {launches:[] as SaleSnapshot[],observedAt:Date.now(),coverage:'No configured factory.'}
  await this.scan()
  const rpc=this.market.client.public;await this.network()
  const block=await rpc.getBlockNumber()
  const launches:SaleSnapshot[]=[]
  for(const event of this.records().filter(e=>e.status==='confirmed').sort((a,b)=>b.at-a.at).slice(0,24)){
   const d=event.data,sale=d.sale as Address
   const read=<T extends 'supply'|'totalAllocated'|'totalRaised'|'softCap'|'hardCap'|'deadline'|'participants'|'status'|'proceedsWithdrawn'|'remainderWithdrawn'>(functionName:T)=>rpc.readContract({address:sale,abi:saleAbi,functionName,blockNumber:block})
   const [supply,raised,soft,hard,deadline,participants,status,proceeds,remainder,contribution,allocation,totalAllocated]=await Promise.all([read('supply'),read('totalRaised'),read('softCap'),read('hardCap'),read('deadline'),read('participants'),read('status'),read('proceedsWithdrawn'),read('remainderWithdrawn'),wallet?rpc.readContract({address:sale,abi:saleAbi,functionName:'contributions',args:[wallet],blockNumber:block}):null,wallet?rpc.readContract({address:sale,abi:saleAbi,functionName:'allocations',args:[wallet],blockNumber:block}):null,read('totalAllocated')])
   launches.push({launchId:d.launchId as string,sale,token:d.token as Address,creator:d.creator as Address,name:d.name as string,symbol:d.symbol as string,metadataURI:d.metadataURI as string,supply:supply.toString(),totalRaised:raised.toString(),softCap:soft.toString(),hardCap:hard.toString(),deadline:deadline.toString(),participants:participants.toString(),status:(['active','successful','failed'] as const)[status]!,contribution:contribution?.toString()??null,allocation:allocation?.toString()??null,proceedsWithdrawn:proceeds,remainderWithdrawn:remainder,remainderAvailable:(remainder||status===0?0n:status===2?supply:supply-totalAllocated).toString(),blockNumber:block.toString(),observedAt:Date.now(),creationTxHash:event.txHash})
  }
  return {launches,observedAt:Date.now(),coverage:'Latest 24 verified sales; discovery scans at most 30,000 blocks.'}
 }
 monitorStatus(){
  const configured=!!this.factory&&this.deploymentBlock!==null&&!this.error
  return {id:'launch-monitor',name:'Launch factory monitor',status:!configured?'not-configured':this.timer?'watching':'stopped',running:!!this.timer,mode:'observe',controlEnabled:false,positions:[],lastScanAt:this.lastScan||null,observedLaunches:configured?this.records().filter(e=>e.status==='confirmed').length:0,detail:configured?'Read-only factory event monitoring feeds the common registry and Journal. Sale tokens are not automatically bought; existing strategies keep their liquidity and risk gates.':'Connect a reviewed factory to enable launch monitoring. Playground events stay simulated.'}
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
