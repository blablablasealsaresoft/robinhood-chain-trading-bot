
import { decodeEventLog,type Address } from 'viem'
import { NOXA_ADDRESSES,ODYSSEY_ADDRESSES,noxaTokenLaunchedEvent,odysseyTokenCreatedEvent,type Launch } from 'hoodchain'
import type { Market } from '../framework/market.js'
import type { Journal,ExternalEventRecord } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import type { Asset } from './types.js'
import { HubError } from './manual-swaps.js'
const factories=[ODYSSEY_ADDRESSES.bondingCurveFactory,ODYSSEY_ADDRESSES.reflectionFactory,ODYSSEY_ADDRESSES.instantFactory].map(a=>a.toLowerCase())
export class LaunchJournal {
 constructor(private market:Market,private registry:AssetRegistry,private journal:Journal){
  for(const e of journal.externalEvents('launch',200,registry.chainId).reverse()){
   const asset=e.data.asset as Asset|null
   if(e.status==='confirmed'&&asset&&asset.chainId===registry.chainId)this.registry.registerDiscovered(asset)
  }
 }
 async observe(launch:Launch,asset:Asset|null):Promise<ExternalEventRecord>{
  const rpc=this.market.client.public
  if(this.registry.chainId!==4663||await rpc.getChainId()!==4663)throw new HubError(503,'CHAIN_MISMATCH','Launch journal requires verified mainnet RPC.')
  const receipt=await rpc.getTransactionReceipt({hash:launch.transactionHash})
  const [block,head]=await Promise.all([rpc.getBlock({blockNumber:receipt.blockNumber}),rpc.getBlockNumber()])
  if(receipt.status!=='success'||receipt.transactionHash.toLowerCase()!==launch.transactionHash.toLowerCase()||receipt.blockNumber!==launch.blockNumber||receipt.blockHash!==block.hash||head<receipt.blockNumber)throw new HubError(503,'LAUNCH_UNVERIFIED','Launch receipt is not canonical.')
  let index:number|null=null
  for(const log of receipt.logs){
   if(log.removed||log.logIndex===null)continue
   const expected=launch.launchpad==='noxa'?log.address.toLowerCase()===NOXA_ADDRESSES.launchFactory.toLowerCase():factories.includes(log.address.toLowerCase())
   if(!expected)continue
   try{
    const decoded=decodeEventLog({abi:[noxaTokenLaunchedEvent,odysseyTokenCreatedEvent],data:log.data,topics:log.topics,strict:true})
    if(launch.launchpad==='noxa'&&decoded.eventName==='TokenLaunched'&&decoded.args.token.toLowerCase()===launch.token.toLowerCase()&&decoded.args.deployer.toLowerCase()===launch.creator.toLowerCase()&&decoded.args.pool.toLowerCase()===launch.pool?.toLowerCase())index=log.logIndex
    if(launch.launchpad==='odyssey'&&decoded.eventName==='TokenCreated'&&decoded.args.token.toLowerCase()===launch.token.toLowerCase()&&decoded.args.creator.toLowerCase()===launch.creator.toLowerCase())index=log.logIndex
   }catch{/* unrelated log */}
  }
  if(index===null)throw new HubError(503,'LAUNCH_UNVERIFIED','Expected factory event is absent from the receipt.')
  const now=Date.now(),confirmed=head-receipt.blockNumber+1n>=2n
  const event:ExternalEventRecord={id:'launch:'+this.registry.chainId+':'+launch.transactionHash.toLowerCase()+':'+index,type:'launch',source:'hoodchain/'+launch.launchpad,chainId:this.registry.chainId,txHash:launch.transactionHash,owner:launch.creator,
   at:Number(block.timestamp)*1000,observedAt:now,status:confirmed?'confirmed':'confirming',verification:'chain-event',
   title:'Launch discovered'+(asset?' · '+asset.symbol:''),detail:launch.launchpad+' · '+launch.token+' · block '+receipt.blockNumber,
   data:{launch:{...launch,blockNumber:launch.blockNumber.toString()},asset,blockHash:receipt.blockHash,logIndex:index,tradeEnabled:false}}
  this.journal.recordExternalEvent(event,confirmed&&now-event.at>=600000?Number.MAX_SAFE_INTEGER:now+60000)
  if(confirmed&&asset)this.registry.registerDiscovered(asset)
  return event
 }
 async recheck(){
  for(const event of this.journal.dueExternalEvents('launch',Date.now(),10)){
   this.journal.deferExternalEvent(event.id,Date.now()+60000)
   const saved=event.data.launch as Omit<Launch,'blockNumber'>&{blockNumber:string}
   try{await this.observe({...saved,blockNumber:BigInt(saved.blockNumber)},event.data.asset as Asset|null)}
   catch(error){
    // RPC outages are not proof of a reorg; retain the last observation unless a canonical check fails.
    if((error instanceof HubError && error.code==='LAUNCH_UNVERIFIED')||missingReceipt(error)){
     const other=this.journal.externalEvents('launch',200,this.registry.chainId).some(e=>e.id!==event.id&&e.status==='confirmed'&&(e.data.launch as {token?:string})?.token?.toLowerCase()===saved.token.toLowerCase())
     if(!other)this.registry.removeDiscovered(saved.token as Address)
     this.journal.recordExternalEvent({...event,status:'unverified',verification:'unverified',observedAt:Date.now(),detail:'Canonical launch event could not be confirmed; trading remains disabled.'},Date.now()+60000)
    }
   }
  }
 }
}
function missingReceipt(error:unknown):boolean {
 const seen=new Set<object>()
 while(error&&typeof error==='object'&&!seen.has(error)){
  seen.add(error);const e=error as {name?:string;cause?:unknown}
  if(e.name==='TransactionReceiptNotFoundError')return true
  error=e.cause
 }
 return false
}
