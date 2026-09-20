
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
import { encodeAbiParameters,encodeEventTopics,getAddress } from 'viem'
import { odysseyTokenCreatedEvent,ODYSSEY_ADDRESSES } from 'hoodchain'
import { Journal } from '../../src/framework/journal.js'
import { BridgeObservations } from '../../src/hub/bridge-observations.js'
import { LaunchJournal } from '../../src/hub/launch-journal.js'
import { AssetRegistry } from '../../src/hub/assets.js'
import type { Market } from '../../src/framework/market.js'
const account=getAddress('0x1111111111111111111111111111111111111111'),token=getAddress('0x2222222222222222222222222222222222222222')
const hash=('0x'+'a'.repeat(64)) as `0x${string}`,destHash=('0x'+'b'.repeat(64)) as `0x${string}`,blockHash=('0x'+'c'.repeat(64)) as `0x${string}`
let journal:Journal
beforeEach(()=>{journal=new Journal(':memory:')})
afterEach(()=>{journal.close();vi.restoreAllMocks()})
function fixture(){
 const rpc={getChainId:vi.fn(async()=>4663),getTransactionReceipt:vi.fn(async()=>({status:'success',transactionHash:destHash,blockNumber:100n,blockHash,logs:[]})),getBlock:vi.fn(async()=>({hash:blockHash,timestamp:Math.floor(Date.now()/1000)})),getBlockNumber:vi.fn(async()=>101n)}
 const market={weth:account,usdg:getAddress('0x3333333333333333333333333333333333333333'),usdgDecimals:6,pricedStockTokens:()=>[],client:{public:rpc}} as unknown as Market
 const body={status:'DONE',substatus:'COMPLETED',tool:'test',sending:{txHash:hash,chainId:8453,amount:'100',token:{symbol:'ETH'}},receiving:{txHash:destHash,chainId:4663,amount:'99',token:{symbol:'ETH'}},fromAddress:account,toAddress:account}
 const request=vi.fn(async()=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}))
 const bridge=new BridgeObservations(market,journal,request as typeof fetch)
 const ref={fromChainId:8453,toChainId:4663,txHash:hash,destination:account}
 return {rpc,market,body,request,bridge,ref}
}
describe('bridge observations',()=>{
 it('persists LI.FI transaction-not-found responses but rejects unrelated HTTP failures',async()=>{
  const f=fixture()
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({code:1003}),{status:404}))
  expect(await f.bridge.verify(f.ref)).toMatchObject({status:'awaiting-provider',verification:'unverified'})
  expect(journal.pendingExternalCount('bridge')).toBe(1)
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({code:9999}),{status:404}))
  await expect(f.bridge.verify(f.ref,true)).rejects.toMatchObject({code:'BRIDGE_PROVIDER'})
 })

 it('checks the identity of coalesced requests and preserves the stored recipient',async()=>{
  const f=fixture()
  const outcomes=await Promise.allSettled([f.bridge.verify(f.ref),f.bridge.verify({...f.ref,destination:token}),f.bridge.verify({...f.ref,toChainId:1})])
  expect(outcomes[0]!.status).toBe('fulfilled');expect(outcomes[1]!.status).toBe('rejected');expect(outcomes[2]!.status).toBe('rejected')
  expect(f.request).toHaveBeenCalledOnce()
  const {destination,...withoutDestination}=f.ref
  const event=await f.bridge.verify(withoutDestination,true)
  expect((event.data.reference as {destination:string}).destination).toBe(destination)
 })

 it('requires LI.FI completion and a canonical destination receipt; duplicate reports reuse the row',async()=>{
  const f=fixture(),a=await f.bridge.verify(f.ref),b=await f.bridge.verify(f.ref)
  expect(a).toMatchObject({status:'completed',verification:'provider-and-receipt',owner:account})
  expect(b.id).toBe(a.id);expect(f.request).toHaveBeenCalledOnce();expect(journal.externalEvents('bridge')).toHaveLength(1)
  expect(String(f.request.mock.calls[0]?.[0])).toContain('https://li.quest/v1/status?')
 })
 it('does not treat one block or unavailable/reverted destination receipts as delivered',async()=>{
  const f=fixture()
  f.rpc.getBlockNumber.mockResolvedValueOnce(100n);expect((await f.bridge.verify(f.ref)).status).toBe('awaiting-destination-confirmation')
  f.rpc.getTransactionReceipt.mockRejectedValueOnce(new Error('not indexed'));expect((await f.bridge.verify(f.ref,true)).status).toBe('awaiting-destination-confirmation')
  f.rpc.getTransactionReceipt.mockResolvedValueOnce({status:'reverted',transactionHash:destHash,blockNumber:100n,blockHash,logs:[]});expect((await f.bridge.verify(f.ref,true)).status).toBe('destination-reverted')
  f.rpc.getBlock.mockResolvedValueOnce({hash:hash,timestamp:1});expect((await f.bridge.verify(f.ref,true)).status).toBe('unverified')
 })
 it.each(['PARTIAL','REFUNDED'])('preserves %s instead of reporting requested-token arrival',async substatus=>{
  const f=fixture();f.body.substatus=substatus
  if(substatus==='REFUNDED')f.body.receiving.chainId=8453
  const e=await f.bridge.verify(f.ref)
  expect(e.status).toBe(substatus==='PARTIAL'?'partial-delivery':'provider-refunded')
  if(substatus==='REFUNDED')expect(f.rpc.getTransactionReceipt).not.toHaveBeenCalled()
 })
 it('does not claim independent receipt verification for a non-Hub destination',async()=>{
  const f=fixture();f.body.sending.chainId=4663;f.body.receiving.chainId=8453
  expect(await f.bridge.verify({...f.ref,fromChainId:4663,toChainId:8453})).toMatchObject({status:'provider-completed',verification:'provider'})
  expect(f.rpc.getTransactionReceipt).not.toHaveBeenCalled()
 })
 it('keeps not-found references unverified and rejects client-asserted success',async()=>{
  const f=fixture();f.body.status='NOT_FOUND'
  const e=await f.bridge.verify(f.ref)
  expect(e.status).toBe('awaiting-provider');expect(e.verification).toBe('unverified')
  await expect(f.bridge.verify({...f.ref,status:'DONE'})).rejects.toMatchObject({code:'UNEXPECTED_FIELD'})
 })
 it.each(['hash','network','recipient','receiving'])('rejects mismatched provider %s',async field=>{
  const f=fixture()
  if(field==='hash')f.body.sending.txHash=destHash
  if(field==='network')f.body.sending.chainId=1
  if(field==='recipient')f.body.toAddress=token
  if(field==='receiving')f.body.receiving.chainId=1
  await expect(f.bridge.verify(f.ref)).rejects.toMatchObject({status:409})
  expect(journal.externalEvents('bridge')).toHaveLength(0)
 })
 it('keeps failures retryable without accepting incomplete completion records',async()=>{
  const f=fixture();f.request.mockResolvedValueOnce(new Response('rate limited',{status:429}))
  await expect(f.bridge.verify(f.ref)).rejects.toMatchObject({code:'BRIDGE_PROVIDER'})
  f.body.receiving.txHash='' as typeof destHash
  await expect(f.bridge.verify(f.ref)).rejects.toMatchObject({code:'BRIDGE_RECEIPT'})
  expect(journal.externalEvents('bridge')).toHaveLength(0)
 })
 it('continues tracked status checks without a browser and stops cleanly',async()=>{
  const f=fixture();f.body.status='PENDING'
  const e=await f.bridge.verify(f.ref);journal.deferExternalEvent(e.id,0);f.body.status='DONE'
  f.bridge.start()
  try{await vi.waitFor(()=>expect(journal.externalEvent(e.id)?.status).toBe('completed'))}finally{await f.bridge.stop()}
 })
})
describe('factory launch journal',()=>{
 function launchFixture(){
  const f=fixture(),registry=new AssetRegistry(4663,f.market)
  const topics=encodeEventTopics({abi:[odysseyTokenCreatedEvent],eventName:'TokenCreated',args:{token,creator:account}})
  const data=encodeAbiParameters([{type:'address'},{type:'bool'},{type:'uint256'}],[account,false,1n])
  const receipt={status:'success',transactionHash:hash,blockNumber:100n,blockHash,logs:[{address:ODYSSEY_ADDRESSES.bondingCurveFactory,topics,data,removed:false,logIndex:7}]}
  f.rpc.getTransactionReceipt.mockResolvedValue(receipt as never)
  const launches=new LaunchJournal(f.market,registry,journal)
  const launch={launchpad:'odyssey' as const,token,creator:account,pool:null,blockNumber:100n,transactionHash:hash}
  const asset={id:'eip155:4663/erc20:'+token.toLowerCase(),chainId:4663,address:token,symbol:'NEW',name:'New token',decimals:18,type:'launch-token' as const,source:'hoodchain/odyssey',tradable:false}
  return {...f,registry,launches,launch,asset,receipt}
 }
 it('deduplicates by chain, transaction and log index and restores read-only metadata',async()=>{
  const f=launchFixture()
  const e=await f.launches.observe(f.launch,f.asset);await f.launches.observe(f.launch,f.asset)
  expect(e.id).toBe('launch:4663:'+hash+':7');expect(journal.externalEvents('launch')).toHaveLength(1)
  expect(f.registry.get(token)?.tradable).toBe(false)
  const restored=new AssetRegistry(4663,f.market);new LaunchJournal(f.market,restored,journal)
  expect(restored.get(token)).toMatchObject({symbol:'NEW',tradable:false})
 })
 it('does not register a launch until the second observed block',async()=>{
  const f=launchFixture();f.rpc.getBlockNumber.mockResolvedValueOnce(100n)
  expect((await f.launches.observe(f.launch,f.asset)).status).toBe('confirming')
  expect(f.registry.get(token)).toBeUndefined()
 })
 it('rejects logs from an unknown factory or another token',async()=>{
  const f=launchFixture();f.receipt.logs[0]!.address=token
  await expect(f.launches.observe(f.launch,f.asset)).rejects.toMatchObject({code:'LAUNCH_UNVERIFIED'})
  expect(journal.externalEvents('launch')).toHaveLength(0)
 })
 it('marks a reorganized launch unverified and removes only its discovered registry entry',async()=>{
  const f=launchFixture(),e=await f.launches.observe(f.launch,f.asset)
  journal.deferExternalEvent(e.id,0);f.rpc.getBlock.mockResolvedValueOnce({hash:destHash,timestamp:1})
  await f.launches.recheck()
  expect(journal.externalEvent(e.id)?.status).toBe('unverified')
  expect(f.registry.get(token)).toBeUndefined();expect(f.registry.get(account)?.tradable).toBe(true)
 })
 it('does not interpret an RPC outage as a reorg',async()=>{
  const f=launchFixture(),e=await f.launches.observe(f.launch,f.asset)
  journal.deferExternalEvent(e.id,0);f.rpc.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC offline'))
  await f.launches.recheck();expect(journal.externalEvent(e.id)?.status).toBe('confirmed')
 })
})
