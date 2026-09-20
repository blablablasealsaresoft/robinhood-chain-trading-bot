import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {decodeFunctionData,encodeAbiParameters,encodeEventTopics,getAddress} from 'viem'
import {Journal} from '../../src/framework/journal.js'
import {AssetRegistry} from '../../src/hub/assets.js'
import {LaunchpadService} from '../../src/hub/launchpad.js'
import {launchFactoryAbi,saleAbi} from '../../src/hub/launchpad-abi.js'
import type {Market} from '../../src/framework/market.js'
const address=(n:string)=>getAddress('0x'+n.repeat(40))
const owner=address('1'),sale=address('2'),token=address('3'),factory=address('4'),tokenFactory=address('5')
const hash=('0x'+'a'.repeat(64)) as `0x${string}`,blockHash=('0x'+'b'.repeat(64)) as `0x${string}`
let journal:Journal
beforeEach(()=>{journal=new Journal(':memory:')})
afterEach(()=>{journal.close();vi.restoreAllMocks()})
const input={chainId:4663,account:owner,action:'create',name:'Launch token',symbol:'NEW',wholeSupply:'1000000',softCapWei:'1000000000000000',hardCapWei:'10000000000000000',durationSeconds:'3600',description:'Hello',image:'https://example.com/token.png'}
function setup(config:{factory?:string;deploymentBlock?:string}={factory,deploymentBlock:'90'}){
 let killed=false
 const topics=encodeEventTopics({abi:launchFactoryAbi,eventName:'LaunchCreated',args:{id:0n,creator:owner,sale}})
 const data=encodeAbiParameters([{type:'address'},{type:'string'},{type:'string'},{type:'string'}],[token,'Launch token','NEW',''])
 const receipt={transactionHash:hash,status:'success',blockNumber:100n,blockHash,logs:[{address:factory,topics,data,logIndex:2,removed:false}]}
 const rpc={
 getChainId:vi.fn(async()=>4663),getCode:vi.fn(async()=> '0x1234'),
 getBalance:vi.fn(async()=>10n**18n),getGasPrice:vi.fn(async()=>1n),estimateGas:vi.fn(async()=>100000n),
 getTransactionReceipt:vi.fn(async()=>receipt),getBlock:vi.fn(async()=>({hash:blockHash,timestamp:BigInt(Math.floor(Date.now()/1000))})),getBlockNumber:vi.fn(async()=>101n),
 getLogs:vi.fn(async()=>[{transactionHash:hash,removed:false}]),
 readContract:vi.fn(async({functionName}: {functionName:string}):Promise<any>=>{
  if(functionName==='tokenFactory')return tokenFactory
  if(functionName==='launchFactory')return factory
  if(functionName==='getLaunches')return [sale]
  if(functionName==='token')return token
  if(functionName==='creator')return owner
  if(functionName==='status')return 0
  if(functionName==='proceedsWithdrawn'||functionName==='remainderWithdrawn')return false
  return 1n
 })
 }
 const market={client:{public:rpc},weth:address('8'),usdg:address('9'),usdgDecimals:6,pricedStockTokens:()=>[]} as unknown as Market
 const registry=new AssetRegistry(4663,market)
 const service=new LaunchpadService(market,{chainId:4663,...config,isKilled:()=>killed,journal,registry})
 return {rpc,market,registry,service,receipt,kill:()=>{killed=true}}
}
describe('configured launch contract adapter',()=>{
 it('rejects a deployment block ahead of the current RPC',async()=>{
  const f=setup({factory,deploymentBlock:'102'})
  expect((await f.service.status()).status).toBe('unavailable')
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'DEPLOYMENT_BLOCK'})
 })
 it('rechecks disappeared factory receipts without a browser',async()=>{
  const f=setup(),events=await f.service.observeHash(hash)
  journal.deferExternalEvent(events[0]!.id,0)
  f.rpc.getLogs.mockResolvedValue([])
  f.rpc.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not found'),{name:'TransactionReceiptNotFoundError'}))
  f.service.start()
  try{await vi.waitFor(()=>expect(journal.externalEvent(events[0]!.id)?.status).toBe('unverified'))}finally{await f.service.stop()}
  expect(f.registry.get(token)).toBeUndefined()
 })

 it('stays disabled without an explicit factory and deployment block',async()=>{
  const f=setup({})
  expect(await f.service.status()).toMatchObject({configured:false,status:'not-configured'})
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'LAUNCH_NOT_CONFIGURED'})
  expect(f.rpc.estimateGas).not.toHaveBeenCalled()
 })
 it('rejects partial configuration and a signer-bearing Market',async()=>{
  const f=setup({factory});expect((await f.service.status()).status).toBe('configuration-error')
  expect(()=>new LaunchpadService({...f.market,client:{...f.market.client,account:{}}} as Market,{chainId:4663,factory,deploymentBlock:'90',isKilled:()=>false,journal,registry:f.registry})).toThrow('signer-free')
 })
 it('prepares exact creation terms without sending or approving, persisting the plan in the Journal',async()=>{
  const f=setup(),p=await f.service.prepare(input)
  const decoded=decodeFunctionData({abi:launchFactoryAbi,data:p.transaction.data})
  expect(decoded.functionName).toBe('createLaunch');expect(decoded.args?.[2]).toBe(1000000n)
  expect(p).toMatchObject({action:'create',amount:'0',transaction:{to:factory,value:'0'},simulation:'passed'})
  expect(journal.walletPlan(p.planId)?.actions[0]).toEqual({kind:'launch-create',...p.transaction})
  expect(journal.recentWalletActivity()).toHaveLength(0)
 })
 it.each([{symbol:'bad'},{wholeSupply:'999'},{hardCapWei:'1'},{durationSeconds:'0'},{image:'javascript:alert(1)'},{name:'🦊'.repeat(17)},{status:'confirmed'}])('refuses invalid or client-asserted terms %j',async change=>{
  const f=setup();await expect(f.service.prepare({...input,...change})).rejects.toMatchObject({status:400})
  expect(f.rpc.estimateGas).not.toHaveBeenCalled()
 })
 it('enforces requested chain, actual RPC chain and bound token factory',async()=>{
  const f=setup()
  await expect(f.service.prepare({...input,chainId:1})).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
  f.rpc.getChainId.mockResolvedValueOnce(1);await expect(f.service.prepare(input)).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
  f.rpc.readContract.mockResolvedValueOnce(tokenFactory).mockResolvedValueOnce(token)
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'FACTORY_MISMATCH'})
 })
 it('checks kill before and after RPC work and refuses missing gas funds',async()=>{
  const f=setup();f.rpc.getBalance.mockResolvedValueOnce(1n)
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'GAS_RESERVE'})
  f.rpc.estimateGas.mockImplementationOnce(async()=>{f.kill();return 100n})
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'KILLED'})
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'KILLED'})
 })
 it('never trusts a client sale address and resolves the target from the configured factory',async()=>{
  const f=setup()
  await expect(f.service.prepare({chainId:4663,account:owner,action:'contribute',launchId:'0',amount:'10',sale:token})).rejects.toMatchObject({code:'UNEXPECTED_FIELD'})
  const p=await f.service.prepare({chainId:4663,account:owner,action:'contribute',launchId:'0',amount:'10'})
  expect(p.transaction).toMatchObject({to:sale,value:'10'})
  expect(decodeFunctionData({abi:saleAbi,data:p.transaction.data}).functionName).toBe('contribute')
 })
 it.each(['claim','refund','withdrawProceeds','withdrawRemainder'])('binds %s recipient to the reviewed wallet',async action=>{
  const f=setup(),p=await f.service.prepare({chainId:4663,account:owner,action,launchId:'0'})
  expect(decodeFunctionData({abi:saleAbi,data:p.transaction.data}).args).toEqual([owner])
  expect(p.transaction.value).toBe('0')
 })
 it('requires the sale registry to contain the requested ID and simulation to succeed',async()=>{
  const f=setup()
  const original=f.rpc.readContract.getMockImplementation()!
  f.rpc.readContract.mockImplementation(async x=>x.functionName==='getLaunches'?[]:original(x))
  await expect(f.service.prepare({chainId:4663,account:owner,action:'claim',launchId:'999'})).rejects.toMatchObject({code:'SALE_NOT_FOUND'})
  f.rpc.readContract.mockImplementation(original);f.rpc.estimateGas.mockRejectedValueOnce(new Error('revert'))
  await expect(f.service.prepare(input)).rejects.toMatchObject({code:'LAUNCH_SIMULATION'})
 })
 it('admits only canonical matching factory events after two blocks and restores configured assets',async()=>{
  const f=setup()
  f.rpc.getBlockNumber.mockResolvedValue(100n)
  expect((await f.service.observeHash(hash))[0]?.status).toBe('confirming');expect(f.registry.get(token)).toBeUndefined()
  f.rpc.getBlockNumber.mockResolvedValue(101n)
  await f.service.observeHash(hash);await f.service.observeHash(hash)
  expect(journal.externalEvents('launch')).toHaveLength(1);expect(f.registry.get(token)?.tradable).toBe(false)
  const other=setup();expect(other.registry.get(token)?.symbol).toBe('NEW')
  const disabled=setup({});expect(disabled.registry.get(token)).toBeUndefined()
 })
 it('rejects unknown emitters and mismatched canonical block or sale identity',async()=>{
  const f=setup()
  f.receipt.logs[0]!.address=token
  await expect(f.service.observeHash(hash)).rejects.toMatchObject({code:'LAUNCH_UNVERIFIED'})
  f.receipt.logs[0]!.address=factory;f.rpc.getBlock.mockResolvedValueOnce({hash:hash,timestamp:1n})
  await expect(f.service.observeHash(hash)).rejects.toMatchObject({code:'LAUNCH_UNVERIFIED'})
  const original=f.rpc.readContract.getMockImplementation()!
  f.rpc.readContract.mockImplementation(async x=>x.functionName==='token'?owner:original(x))
  await expect(f.service.observeHash(hash)).rejects.toMatchObject({code:'LAUNCH_UNVERIFIED'})
  expect(journal.externalEvents('launch')).toHaveLength(0)
 })
 it('invalidates a previously confirmed creation if its wallet receipt loses verification',async()=>{
  const f=setup();await f.service.observeHash(hash)
  await f.service.observeWallet({kind:'launch-create',status:'unverified',txHash:hash} as never)
  expect(f.registry.get(token)).toBeUndefined();expect(journal.externalEvents('launch')[0]?.status).toBe('unverified')
 })
 it('keeps SDK and local-factory recovery queues separate',async()=>{
  const f=setup();await f.service.observeHash(hash)
  expect(journal.dueExternalEvents('launch',Date.now()+120000,10,['hoodchain/noxa','hoodchain/odyssey'])).toHaveLength(0)
  expect(journal.dueExternalEvents('launch',Date.now()+120000,10,['hub-launchpad'])).toHaveLength(1)
 })
})

it('projects canonical native factory observations for the combined discovery feed',async()=>{
 const f=setup()
 await f.service.observeHash(hash)
 const rows=await f.service.recent()
 expect(rows).toHaveLength(1)
 expect(rows[0]).toMatchObject({launchpad:'hub-launchpad',id:'0',token,creator:owner,sale,pool:null,verification:'confirmed',tradeEnabled:false,name:'Launch token',symbol:'NEW'})
 expect(journal.externalEvents('launch')).toHaveLength(1)
})

it('refuses empty token-remainder preparations but preserves the ETH proceeds action',async()=>{
 const f=setup(),original=f.rpc.readContract.getMockImplementation()!;
 f.rpc.readContract.mockImplementation(async x=>x.functionName==='status'?1:x.functionName==='supply'||x.functionName==='totalAllocated'?1000n:original(x));
 await expect(f.service.prepare({chainId:4663,account:owner,action:'withdrawRemainder',launchId:'0'})).rejects.toMatchObject({code:'NO_REMAINDER'});
 expect(f.rpc.estimateGas).not.toHaveBeenCalled();
 const proceeds=await f.service.prepare({chainId:4663,account:owner,action:'withdrawProceeds',launchId:'0'});
 expect(decodeFunctionData({abi:saleAbi,data:proceeds.transaction.data}).functionName).toBe('withdrawProceeds');
 const list=await f.service.list(owner);expect(list.launches[0]?.remainderAvailable).toBe('0');
});
it('reports actual unsold tokens and allows a positive remainder withdrawal',async()=>{
 const f=setup(),original=f.rpc.readContract.getMockImplementation()!;
 f.rpc.readContract.mockImplementation(async x=>x.functionName==='status'?1:x.functionName==='supply'?1000n:x.functionName==='totalAllocated'?600n:original(x));
 const list=await f.service.list(owner);expect(list.launches[0]?.remainderAvailable).toBe('400');
 const p=await f.service.prepare({chainId:4663,account:owner,action:'withdrawRemainder',launchId:'0'});
 expect(decodeFunctionData({abi:saleAbi,data:p.transaction.data}).args).toEqual([owner]);
});
