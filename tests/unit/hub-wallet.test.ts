import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, getAddress } from 'viem'
import { weth9Abi } from 'hoodchain'
import { Journal } from '../../src/framework/journal.js'
import { NativeWrapService } from '../../src/hub/native-wrap.js'
import { WalletReceipts } from '../../src/hub/wallet-receipts.js'
import type { Market } from '../../src/framework/market.js'
const account=getAddress('0x1111111111111111111111111111111111111111'),weth=getAddress('0x2222222222222222222222222222222222222222')
const hash=('0x'+'a'.repeat(64)) as `0x${string}`, blockHash=('0x'+'b'.repeat(64)) as `0x${string}`
let journal:Journal,killed:boolean
function fixture(){
 const rpc={getChainId:vi.fn(async()=>4663),getBalance:vi.fn(async()=>10n**18n),getGasPrice:vi.fn(async()=>1000000000n),getCode:vi.fn(async()=>'0x1234'),estimateGas:vi.fn(async()=>50000n),readContract:vi.fn(async()=>10n**18n),
  getTransaction:vi.fn(async()=>({hash,from:account,to:weth,input:'0xd0e30db0',value:10000000000000000n})),
  getTransactionReceipt:vi.fn(async()=>({transactionHash:hash,status:'success',blockNumber:100n,blockHash})),
  getBlock:vi.fn(async()=>({hash:blockHash,timestamp:1000n})),getBlockNumber:vi.fn(async()=>101n)}
 const market={weth,client:{public:rpc,wallet:null,account:undefined}} as unknown as Market
 return {rpc,market,wrap:new NativeWrapService(market,{chainId:4663,isKilled:()=>killed,journal}),verify:new WalletReceipts(market,journal,4663),input:{chainId:4663,account,amount:'10000000000000000',direction:'wrap'}}
}
beforeEach(()=>{journal=new Journal(':memory:');killed=false})
afterEach(()=>journal.close())
describe('native ETH/WETH preparation',()=>{
 it('prepares a canonical deposit with exact value, fee reserve and persisted terms',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input)
  expect(p.transaction).toEqual({to:weth,data:'0xd0e30db0',value:f.input.amount})
  expect(p.estimatedNetworkFeeWei).toBe('50000000000000');expect(p.gasReserveWei).toBe('75000000000000')
  expect(journal.walletPlan(p.planId)?.actions).toEqual([{kind:'wrap',...p.transaction}])
  expect(f.market.client.wallet).toBeNull()
 })
 it('unwraps only canonical WETH without approval or sending value',async()=>{
  const f=fixture(),p=await f.wrap.prepare({...f.input,direction:'unwrap'})
  expect(p.transaction.value).toBe('0')
  expect(decodeFunctionData({abi:weth9Abi,data:p.transaction.data})).toMatchObject({functionName:'withdraw',args:[10000000000000000n]})
 })
 it.each(['0','-1','1.2','01','1e18',(1n<<256n).toString()])('rejects invalid amount %s',async amount=>{
  const f=fixture();await expect(f.wrap.prepare({...f.input,amount})).rejects.toMatchObject({code:'INVALID_AMOUNT'});expect(f.rpc.getChainId).not.toHaveBeenCalled()
 })
 it('rejects arbitrary calldata, network mismatches, wrong contract, and a signer-bearing Market',async()=>{
  const f=fixture()
  await expect(f.wrap.prepare({...f.input,to:account})).rejects.toMatchObject({code:'UNEXPECTED_FIELD'})
  f.rpc.getChainId.mockResolvedValueOnce(1);await expect(f.wrap.prepare(f.input)).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
  f.rpc.getCode.mockResolvedValueOnce('0x');await expect(f.wrap.prepare(f.input)).rejects.toMatchObject({code:'WETH_UNAVAILABLE'})
  Object.assign(f.market.client,{account:{address:account}})
  expect(()=>new NativeWrapService(f.market,{chainId:4663,isKilled:()=>false,journal})).toThrow('signer-free')
 })
 it('reserves gas for wrap and unwrap, rejects low WETH and failed simulation',async()=>{
  const f=fixture()
  f.rpc.getBalance.mockResolvedValueOnce(BigInt(f.input.amount)+1n);await expect(f.wrap.prepare(f.input)).rejects.toMatchObject({code:'GAS_RESERVE'})
  f.rpc.getBalance.mockResolvedValueOnce(0n);await expect(f.wrap.prepare({...f.input,direction:'unwrap'})).rejects.toMatchObject({code:'GAS_RESERVE'})
  f.rpc.readContract.mockResolvedValueOnce(0n);await expect(f.wrap.prepare({...f.input,direction:'unwrap'})).rejects.toMatchObject({code:'INSUFFICIENT_BALANCE'})
  f.rpc.estimateGas.mockRejectedValueOnce(new Error('revert'));await expect(f.wrap.prepare(f.input)).rejects.toMatchObject({code:'SIMULATION_FAILED'})
 })
 it('rechecks kill after RPC reads before registering a plan',async()=>{
  const f=fixture();f.rpc.estimateGas.mockImplementation(async()=>{killed=true;return 50000n})
  await expect(f.wrap.prepare(f.input)).rejects.toMatchObject({code:'KILLED'})
  expect(journal.allRecentDecisions()).toHaveLength(0)
 })
})
describe('verified manual activity in the existing Journal',()=>{
 it('checks signed terms and persists one event after duplicate requests',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input),request={planId:p.planId,transactionHash:hash}
  const [a,b]=await Promise.all([f.verify.verify(request),f.verify.verify(request)])
  expect(a).toBe(b);expect(f.rpc.getTransaction).toHaveBeenCalledOnce()
  expect(a).toMatchObject({status:'confirmed',account,kind:'wrap',blockNumber:'100',at:1000000})
  await f.verify.verify(request);expect(journal.recentWalletActivity()).toHaveLength(1)
 })
 it.each(['from','to','input','value'])('rejects a transaction with mismatched %s',async field=>{
  const f=fixture(),p=await f.wrap.prepare(f.input),tx=await f.rpc.getTransaction()
  f.rpc.getTransaction.mockResolvedValue({...tx,[field]:field==='value'?2n:field==='input'?'0x1234':'0x3333333333333333333333333333333333333333'})
  await expect(f.verify.verify({planId:p.planId,transactionHash:hash})).rejects.toMatchObject({code:'TRANSACTION_MISMATCH'})
  expect(journal.recentWalletActivity()).toHaveLength(0)
 })
 it('never accepts client-asserted success or unrecognized plans',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input)
  await expect(f.verify.verify({planId:p.planId,transactionHash:hash,status:'confirmed'})).rejects.toMatchObject({code:'UNEXPECTED_FIELD'})
  await expect(f.verify.verify({planId:'missing',transactionHash:hash})).rejects.toMatchObject({code:'PLAN_NOT_FOUND'})
  expect(f.rpc.getTransaction).not.toHaveBeenCalled()
 })
 it('distinguishes confirming, reverted, missing and reorganized receipts',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input),r={planId:p.planId,transactionHash:hash}
  f.rpc.getBlockNumber.mockResolvedValueOnce(100n);expect((await f.verify.verify(r)).status).toBe('confirming')
  f.rpc.getTransactionReceipt.mockResolvedValueOnce({transactionHash:hash,status:'reverted',blockNumber:100n,blockHash});expect((await f.verify.verify(r)).status).toBe('reverted')
  f.rpc.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('not found'),{name:'TransactionReceiptNotFoundError'}));expect((await f.verify.verify(r)).status).toBe('unverified')
  f.rpc.getBlock.mockResolvedValueOnce({hash:('0x'+'c'.repeat(64)) as typeof hash,timestamp:1000n});expect((await f.verify.verify(r)).status).toBe('unverified')
  expect((await f.verify.verify(r)).status).toBe('confirmed')
 })
 it('records pending transactions without a receipt and can verify after kill',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input);killed=true
  f.rpc.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('missing'),{name:'TransactionReceiptNotFoundError'}))
  expect((await f.verify.verify({planId:p.planId,transactionHash:hash})).status).toBe('submitted')
 })
 it('fails closed on RPC errors, network mismatch and duplicate plan association',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input),r={planId:p.planId,transactionHash:hash}
  f.rpc.getChainId.mockResolvedValueOnce(1);await expect(f.verify.verify(r)).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
  f.rpc.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC timeout'));await expect(f.verify.verify(r)).rejects.toThrow('RPC timeout')
  expect(journal.recentWalletActivity()).toHaveLength(0)
  await f.verify.verify(r)
  const p2=await f.wrap.prepare(f.input)
  await expect(f.verify.verify({planId:p2.planId,transactionHash:hash})).rejects.toMatchObject({code:'ALREADY_LINKED'})
 })
})

describe('receipt recovery',()=>{
 it('refreshes a tracked pending receipt without a browser and acknowledges stop',async()=>{
  const f=fixture(),p=await f.wrap.prepare(f.input),r={planId:p.planId,transactionHash:hash}
  f.rpc.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('missing'),{name:'TransactionReceiptNotFoundError'}))
  await f.verify.verify(r)
  f.verify.start()
  try{await vi.waitFor(()=>expect(journal.walletActivity(4663,hash)?.status).toBe('confirmed'))}
  finally{await f.verify.stop()}
  const calls=f.rpc.getTransaction.mock.calls.length
  expect(calls).toBe(2)
 })
 it('persists exact plans and verified receipts across Journal reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hub-journal-recovery-')),path=join(directory,'journal.db')
  const f=fixture(),p=await f.wrap.prepare(f.input),event=await f.verify.verify({planId:p.planId,transactionHash:hash})
  let disk:Journal|null=null
  try {
   disk=new Journal(path);disk.recordWalletPlan(journal.walletPlan(p.planId)!);disk.recordWalletActivity(event);disk.close();disk=null
   disk=new Journal(path)
   expect(disk.walletPlan(p.planId)?.actions[0]?.value).toBe(f.input.amount)
   expect(disk.recentWalletActivity()).toEqual([event])
  }finally{disk?.close();rmSync(directory,{recursive:true,force:true})}
 })
})
