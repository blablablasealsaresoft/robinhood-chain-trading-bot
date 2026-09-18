
import type { Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal, WalletActivityRecord } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'

export class WalletReceipts {

  private timer: ReturnType<typeof setInterval>|null=null
  private refresh: Promise<void>|null=null
  private stopping=false
  private checked=new Map<string,number>()
  /** Recover tracked receipts after browser closure/restart; never discovers or sends transactions. */
  start():void {
    if(this.timer)return
    this.stopping=false
    const tick=()=>{
      if(this.refresh||this.stopping)return
      this.refresh=(async()=>{
        const now=Date.now()
        const events=this.journal.recentWalletActivity(100).filter(e=>
          now-(this.checked.get(e.txHash)||0)>=15000 &&
          (!['confirmed','reverted'].includes(e.status)||now-e.at<600000))
        for(const event of events.sort((a,b)=>(this.checked.get(a.txHash)||0)-(this.checked.get(b.txHash)||0)).slice(0,20)){
          if(this.stopping)return
          this.checked.set(event.txHash,Date.now())
          if(this.checked.size>200)this.checked.delete(this.checked.keys().next().value!)
          try {await this.verify({planId:event.planId,transactionHash:event.txHash})} catch { /* Keep last observed state; retry later. */ }
        }
      })().finally(()=>{this.refresh=null})
    }
    this.timer=setInterval(tick,15000);this.timer.unref();tick()
  }
  async stop():Promise<void> {
    this.stopping=true
    if(this.timer)clearInterval(this.timer)
    this.timer=null
    await this.refresh
    await Promise.allSettled([...this.pending.values()])
  }

  private pending=new Map<string,Promise<WalletActivityRecord>>()
  constructor(private market:Market,private journal:Journal,private chainId:number) {}
  async verify(input:Record<string,unknown>):Promise<WalletActivityRecord> {
    if(Object.keys(input).some(k=>!['planId','transactionHash'].includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Only a prepared plan ID and transaction hash are accepted.')
    if(typeof input.planId!=='string'||input.planId.length>64||typeof input.transactionHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash))throw new HubError(400,'INVALID_REFERENCE','Supply a plan ID and transaction hash.')
    const key=input.planId+':'+input.transactionHash.toLowerCase()
    if(this.pending.has(key))return this.pending.get(key)!
    if(this.pending.size>=20)throw new HubError(503,'VERIFY_CAPACITY','Receipt verification is busy. Retry shortly.')
    const request=this.read(input.planId,input.transactionHash.toLowerCase() as Hex).finally(()=>this.pending.delete(key))
    this.pending.set(key,request)
    return request
  }
  private async read(planId:string,hash:Hex):Promise<WalletActivityRecord> {
    const plan=this.journal.walletPlan(planId)
    if(!plan)throw new HubError(404,'PLAN_NOT_FOUND','The prepared wallet plan is unavailable in this Journal.')
    if(plan.chainId!==this.chainId)throw new HubError(409,'CHAIN_MISMATCH','Plan belongs to another network.')
    const client=this.market.client.public
    if(await client.getChainId()!==this.chainId)throw new HubError(503,'CHAIN_MISMATCH','Receipt RPC network mismatch.')
    const prior=this.journal.walletActivity(this.chainId,hash)
    // A single chain transaction has one canonical journal identity even after retries.
    if(prior && prior.planId!==plan.id)throw new HubError(409,'ALREADY_LINKED','This transaction is already associated with a prepared plan.')
    const now=Date.now()
    let tx
    try {tx=await client.getTransaction({hash})}
    catch(error) {
      if(prior && missing(error,'TransactionNotFoundError')) {
        const event={...prior,status:'unverified' as const,observedAt:now}
        this.journal.recordWalletActivity(event);return event
      }
      if(missing(error,'TransactionNotFoundError'))throw new HubError(404,'TRANSACTION_PENDING','The RPC has not indexed this transaction yet. Retry later.')
      throw error
    }
    const action=plan.actions.find(a=>a.to.toLowerCase()===tx.to?.toLowerCase()&&a.data.toLowerCase()===tx.input.toLowerCase()&&BigInt(a.value)===tx.value)
    if(tx.hash.toLowerCase()!==hash||tx.from.toLowerCase()!==plan.account.toLowerCase()||!action)throw new HubError(409,'TRANSACTION_MISMATCH','The onchain sender, recipient, value or calldata differs from the prepared action.')
    let receipt
    try {receipt=await client.getTransactionReceipt({hash})}
    catch(error) {if(!missing(error,'TransactionReceiptNotFoundError'))throw error}
    const event:WalletActivityRecord={planId:plan.id,chainId:this.chainId,account:plan.account,txHash:hash,kind:action.kind,
      status:prior?.blockHash?'unverified':'submitted',at:prior?.at??now,observedAt:now,blockNumber:null,blockHash:null}
    if(receipt){
      if(receipt.status!=='success'&&receipt.status!=='reverted')throw new HubError(503,'RECEIPT_STATUS','The RPC returned an unknown receipt status.')
      const [block,head]=await Promise.all([client.getBlock({blockNumber:receipt.blockNumber}),client.getBlockNumber()])
      if(receipt.transactionHash.toLowerCase()!==hash)throw new HubError(503,'RECEIPT_MISMATCH','Receipt identity mismatch.')
      if(block.hash===receipt.blockHash && head>=receipt.blockNumber){
        event.at=Number(block.timestamp)*1000;event.blockNumber=receipt.blockNumber.toString();event.blockHash=receipt.blockHash
        event.status=receipt.status==='reverted'?'reverted':head-receipt.blockNumber+1n>=2n?'confirmed':'confirming'
      } else event.status='unverified'
    }
    this.journal.recordWalletActivity(event)
    return event
  }
}
function missing(error:unknown,name:string):boolean {
  const seen=new Set<object>()
  while(error && typeof error==='object'&&!seen.has(error)){
    seen.add(error);const e=error as {name?:string;cause?:unknown}
    if(e.name===name)return true
    error=e.cause
  }
  return false
}
