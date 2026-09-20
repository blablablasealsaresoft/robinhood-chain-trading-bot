import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {decodeFunctionData,getAddress} from 'viem'
import {Journal} from '../../src/framework/journal.js'
import {ForeverService} from '../../src/hub/forever.js'
import {foreverFactoryAbi,foreverVaultAbi} from '../../src/hub/forever-abi.js'
import type {Market} from '../../src/framework/market.js'

const address=(n:string)=>getAddress('0x'+n.repeat(40))
const owner=address('1'),factory=address('2'),vault=address('3'),token=address('4'),streamer=address('5')
let journal:Journal
beforeEach(()=>{journal=new Journal(':memory:')})
afterEach(()=>{journal.close();vi.restoreAllMocks()})

const createInput={chainId:4663,account:owner,action:'create',name:'Sealed Cat',symbol:'HCAT',wholeSupply:'1000000000',description:'sealed',image:''}

function setup(config:{factory?:string;deploymentBlock?:string}={factory,deploymentBlock:'90'}){
  let killed=false
  const rpc={
    getChainId:vi.fn(async()=>4663),
    getCode:vi.fn(async()=>'0x1234'),
    getBalance:vi.fn(async()=>10n**18n),
    getGasPrice:vi.fn(async()=>1n),
    estimateGas:vi.fn(async()=>100000n),
    getBlockNumber:vi.fn(async()=>101n),
    readContract:vi.fn(async({functionName}:{functionName:string}):Promise<unknown>=>{
      if(functionName==='isVault')return true
      if(functionName==='token')return token
      return 0n
    }),
  }
  const market={client:{public:rpc},weth:address('8'),usdg:address('9'),usdgDecimals:6} as unknown as Market
  const service=new ForeverService(market,{chainId:4663,...config,isKilled:()=>killed,journal})
  return {rpc,service,kill:()=>{killed=true}}
}

describe('ForeverFactory journal prepare',()=>{
  it('stays disabled without an explicit factory',async()=>{
    const f=setup({})
    expect(await f.service.status()).toMatchObject({configured:false,status:'not-configured'})
    await expect(f.service.prepare(createInput)).rejects.toMatchObject({code:'FOREVER_NOT_CONFIGURED'})
    expect(f.rpc.estimateGas).not.toHaveBeenCalled()
  })

  it('rejects a signer-bearing Market',()=>{
    const f=setup()
    expect(()=>new ForeverService({client:{public:f.rpc,account:{}}} as unknown as Market,{chainId:4663,factory,isKilled:()=>false,journal})).toThrow('signer-free')
  })

  it('prepares createVault terms and persists the plan in the Journal',async()=>{
    const f=setup(),p=await f.service.prepare(createInput)
    const decoded=decodeFunctionData({abi:foreverFactoryAbi,data:p.transaction.data})
    expect(decoded.functionName).toBe('createVault')
    expect(p).toMatchObject({action:'create',amount:'0',transaction:{to:factory,value:'0'},simulation:'passed'})
    expect(journal.walletPlan(p.planId)?.actions[0]).toEqual({kind:'forever-create',...p.transaction})
    expect(journal.recentWalletActivity()).toHaveLength(0)
  })

  it('binds tip streamer and go-live title into calldata and the Journal plan',async()=>{
    const f=setup()
    const tip=await f.service.prepare({chainId:4663,account:owner,action:'tip',vault,streamer,amount:'100'})
    expect(decodeFunctionData({abi:foreverVaultAbi,data:tip.transaction.data})).toMatchObject({functionName:'tip',args:[streamer]})
    expect(tip.streamer).toBe(streamer)
    expect(journal.walletPlan(tip.planId)?.actions[0]?.kind).toBe('forever-tip')
    const live=await f.service.prepare({chainId:4663,account:owner,action:'goLive',vault,title:'Late-night sealed charting'})
    expect(decodeFunctionData({abi:foreverVaultAbi,data:live.transaction.data})).toMatchObject({functionName:'goLive',args:['Late-night sealed charting']})
    expect(live.title).toBe('Late-night sealed charting')
  })

  it('refuses a vault that is not registered on this factory',async()=>{
    const f=setup()
    f.rpc.readContract.mockImplementation(async({functionName}:{functionName:string})=>{
      if(functionName==='isVault')return false
      return token
    })
    await expect(f.service.prepare({chainId:4663,account:owner,action:'buy',vault,amount:'100'})).rejects.toMatchObject({code:'FOREIGN_VAULT'})
    expect(f.rpc.estimateGas).not.toHaveBeenCalled()
  })

  it('refuses a sell whose token does not match the vault',async()=>{
    const f=setup()
    await expect(f.service.prepare({chainId:4663,account:owner,action:'sell',vault,token:streamer,amount:'50'})).rejects.toMatchObject({code:'TOKEN_MISMATCH'})
  })
})
