
import { isAddress,type Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal,ExternalEventRecord } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'
export interface BridgeReference {fromChainId:number;toChainId:number;txHash:string;destination?:string}
const canonicalHash=(hash:string)=>/^(0x[0-9a-f]+|[0-9a-f]{64})$/i.test(hash)?hash.toLowerCase():hash
const sameAddress=(a:string,b:string)=>isAddress(a)&&isAddress(b)?a.toLowerCase()===b.toLowerCase():a===b
const text=(v:unknown,max=120)=>typeof v==='string'?v.slice(0,max):null
function chain(v:unknown):v is number{return typeof v==='number'&&v>0&&(Number.isSafeInteger(v)||v===9270000000000000)}
export function bridgeReference(input:Record<string,unknown>):BridgeReference {
 if(Object.keys(input).some(k=>!['fromChainId','toChainId','txHash','destination'].includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Only bridge transaction references are accepted.')
 if(!chain(input.fromChainId)||!chain(input.toChainId)||input.fromChainId===input.toChainId||![input.fromChainId,input.toChainId].includes(4663))throw new HubError(400,'BRIDGE_NETWORK','Supply a cross-chain transfer involving Robinhood Chain mainnet.')
 if(typeof input.txHash!=='string'||!/^[A-Za-z0-9:_-]{16,200}$/.test(input.txHash))throw new HubError(400,'INVALID_HASH','Supply the original cross-chain transaction hash.')
 if(input.destination!==undefined&&(typeof input.destination!=='string'||!/^[A-Za-z0-9:_-]{8,160}$/.test(input.destination)||(input.toChainId===4663&&!isAddress(input.destination))))throw new HubError(400,'INVALID_RECIPIENT','Invalid destination address.')
 return {fromChainId:input.fromChainId,toChainId:input.toChainId,txHash:canonicalHash(input.txHash),...(input.destination?{destination:input.destination as string}:{})}
}
export class BridgeObservations {
 private pending=new Map<string,Promise<ExternalEventRecord>>()
 private timer:ReturnType<typeof setInterval>|null=null
 private running:Promise<void>|null=null
 private stopping=false
 constructor(private market:Market,private journal:Journal,private request:typeof fetch=fetch){}
 async verify(input:Record<string,unknown>,force=false):Promise<ExternalEventRecord>{
  const ref=bridgeReference(input),id='bridge:'+ref.fromChainId+':'+ref.txHash
  const prior=this.journal.externalEvent(id)
  if(prior){
   this.assertReference(prior,ref)
   ref.destination??=(prior.data.reference as BridgeReference).destination
   if(!force && Date.now()-prior.observedAt<30000)return prior
  }else if(this.journal.pendingExternalCount('bridge')>=1000)throw new HubError(503,'BRIDGE_CAPACITY','Pending bridge tracking capacity reached.')
  if(this.pending.has(id))return this.pending.get(id)!.then(event=>{this.assertReference(event,ref);return event})
  if(this.pending.size>=10)throw new HubError(503,'BRIDGE_BUSY','Bridge verification is busy. Retry shortly.')
  const work=this.read(ref,id,prior).finally(()=>this.pending.delete(id))
  this.pending.set(id,work);return work
 }
 private assertReference(event:ExternalEventRecord,ref:BridgeReference){
  const saved=event.data.reference as BridgeReference
  if(saved.toChainId!==ref.toChainId||(saved.destination&&ref.destination&&!sameAddress(saved.destination,ref.destination)))throw new HubError(409,'BRIDGE_IDENTITY','Transaction already belongs to another transfer reference.')
  if(ref.destination&&event.owner&&!sameAddress(ref.destination,event.owner))throw new HubError(409,'BRIDGE_RECIPIENT','Provider recipient differs from the reported destination.')
 }
 private async read(ref:BridgeReference,id:string,prior:ExternalEventRecord|null):Promise<ExternalEventRecord>{
  if(await this.market.client.public.getChainId()!==4663)throw new HubError(503,'CHAIN_MISMATCH','Bridge observations require mainnet RPC.')
  const params=new URLSearchParams({fromChain:String(ref.fromChainId),toChain:String(ref.toChainId),txHash:ref.txHash})
  const response=await this.request('https://li.quest/v1/status?'+params,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)})
  const payload=await response.json().catch(()=>null) as Record<string,any>|null
  // LI.FI may report an unindexed origin as HTTP 404 / TransactionNotFound (1003).
  const notFound=response.status===404&&payload?.code===1003
  if(!response.ok&&!notFound)throw new HubError(503,'BRIDGE_PROVIDER','LI.FI status is temporarily unavailable. Your transfer may still be processing.')
  const body=notFound?{status:'NOT_FOUND'}:payload
  if(!body||!['NOT_FOUND','INVALID','PENDING','DONE','FAILED'].includes(body.status))throw new HubError(503,'BRIDGE_SCHEMA','LI.FI returned an unrecognized status.')
  const now=Date.now()
  const event:ExternalEventRecord={id,type:'bridge',source:'lifi',chainId:ref.toChainId,txHash:ref.txHash,owner:prior?.owner??null,
   at:prior?.at??now,observedAt:now,status:'awaiting-provider',verification:'unverified',title:'Bridge transaction',
   detail:'Reported transaction; awaiting LI.FI indexing.',data:{reference:ref,providerStatus:body.status,substatus:text(body.substatus,64),destinationReceipt:'not-checked'}}
  if(body.status==='NOT_FOUND'||body.status==='INVALID'){
   event.status=body.status==='INVALID'?'provider-invalid':prior&&prior.verification!=='unverified'?'unverified':'awaiting-provider'
  }else{
   if(!body.sending||typeof body.sending.txHash!=='string'||canonicalHash(body.sending.txHash)!==ref.txHash||body.sending.chainId!==ref.fromChainId)throw new HubError(409,'BRIDGE_IDENTITY','LI.FI returned a different origin transaction or network.')
   const refunded=body.status==='DONE'&&body.substatus==='REFUNDED'
   if(body.receiving && body.receiving.chainId!==(refunded?ref.fromChainId:ref.toChainId))throw new HubError(409,'BRIDGE_IDENTITY','LI.FI returned a different receiving network.')
   const recipient=text(body.toAddress,160)
   if(recipient&&ref.toChainId===4663&&!isAddress(recipient))throw new HubError(503,'BRIDGE_RECIPIENT','Provider destination address is invalid.')
   if(ref.destination&&recipient&&!sameAddress(recipient,ref.destination))throw new HubError(409,'BRIDGE_RECIPIENT','LI.FI recipient differs from the reported destination.')
   if(body.status==='DONE' && (!recipient||!body.receiving||typeof body.receiving.txHash!=='string'))throw new HubError(503,'BRIDGE_INCOMPLETE','LI.FI completion details are incomplete; arrival is not confirmed.')
   event.owner=recipient??prior?.owner??null
   event.verification='provider'
   event.status=body.status==='PENDING'?'bridging':body.status==='FAILED'?'provider-failed':
    body.substatus==='COMPLETED'?'provider-completed':body.substatus==='PARTIAL'?'partial-delivery':refunded?'provider-refunded':'unverified'
   const ts=body.sending.timestamp
   if(typeof ts==='number'&&Number.isFinite(ts)&&ts>0&&ts*1000<=now+300000)event.at=ts*1000
   const symbol=text(body.sending.token?.symbol,24),receivedSymbol=text(body.receiving?.token?.symbol,24)
   event.title=symbol?'Bridge '+symbol:'Bridge transaction'
   event.detail='Chain '+ref.fromChainId+' → '+ref.toChainId+' · LI.FI '+body.status+(body.substatus?' / '+text(body.substatus,64):'')
   event.data={...event.data,tool:text(body.tool,40),recipient,fromAddress:text(body.fromAddress,160),
    receivingHash:text(body.receiving?.txHash,200),receivingChainId:body.receiving?.chainId??null,
    sentAmount:amount(body.sending.amount),sentSymbol:symbol,receivedAmount:amount(body.receiving?.amount),receivedSymbol}
   // Destination receipt is corroboration, not an independent proof of the amount delivered.
   if(body.status==='DONE' && !refunded && ref.toChainId===4663){
    const hash=body.receiving.txHash
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new HubError(503,'BRIDGE_RECEIPT','Invalid destination transaction identity.')
    const check=await this.receipt(hash)
    event.data.destinationReceipt=check
    if(check==='confirmed'){event.verification='provider-and-receipt';if(body.substatus==='COMPLETED')event.status='completed'}
    else event.status=check==='reverted'?'destination-reverted':check==='unverified'?'unverified':'awaiting-destination-confirmation'
   }
  }
  const terminal=['completed','provider-completed','partial-delivery','provider-refunded','provider-failed','provider-invalid'].includes(event.status)
  const finishedAt=typeof prior?.data.finishedAt==='number'?prior.data.finishedAt:terminal?now:null
  event.data.finishedAt=finishedAt
  this.journal.recordExternalEvent(event,terminal&&finishedAt!==null&&now-finishedAt>=600000?Number.MAX_SAFE_INTEGER:now+30000)
  return event
 }
 private async receipt(hash:Hex):Promise<string>{
  const rpc=this.market.client.public
  if(await rpc.getChainId()!==4663)throw new HubError(503,'CHAIN_MISMATCH','Destination RPC network mismatch.')
  try{
   const receipt=await rpc.getTransactionReceipt({hash})
   const [block,head]=await Promise.all([rpc.getBlock({blockNumber:receipt.blockNumber}),rpc.getBlockNumber()])
   if(receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||block.hash!==receipt.blockHash||head<receipt.blockNumber)return 'unverified'
   if(receipt.status==='reverted')return 'reverted'
   if(receipt.status!=='success')return 'unverified'
   return head-receipt.blockNumber+1n>=2n?'confirmed':'confirming'
  }catch{return 'unavailable'}
 }
 start(){
  if(this.timer)return
  this.stopping=false
  const tick=()=>{
   if(this.running||this.stopping)return
   this.running=(async()=>{
    for(const event of this.journal.dueExternalEvents('bridge',Date.now(),10)){
     if(this.stopping)return
     // Move attempted work to the back of the persistent queue even on provider errors.
     this.journal.deferExternalEvent(event.id,Date.now()+60000)
     try{await this.verify(event.data.reference as unknown as Record<string,unknown>,true)}catch{/* retry later */}
    }
   })().catch(()=>undefined).finally(()=>{this.running=null})
  }
  this.timer=setInterval(tick,15000);this.timer.unref();tick()
 }
 async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;await this.running;await Promise.allSettled([...this.pending.values()])}
}
function amount(v:unknown):string|null{return typeof v==='string'&&/^\d{1,78}$/.test(v)?v:null}
