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

  it('lists a bounded fixed-block snapshot with live hosts and the wallet ended stream',async()=>{
    const ended=address('6'),foreign=address('7')
    const metadata='data:application/json;base64,'+Buffer.from(JSON.stringify({description:'Sealed community'})).toString('base64')
    const f=setup()
    f.rpc.readContract.mockImplementation(async({functionName,args}:{functionName:string;args?:unknown[]})=>{
      if(functionName==='vaultCount')return 1n
      if(functionName==='getVaults')return [vault]
      if(functionName==='token')return token
      if(functionName==='creator')return owner
      if(functionName==='metadataURI')return metadata
      if(functionName==='realEth')return 3n
      if(functionName==='tokenReserve')return 900n
      if(functionName==='rewardPot')return 2n
      if(functionName==='participants')return 4n
      if(functionName==='liveCount')return 1n
      if(functionName==='name')return 'Sealed Cat'
      if(functionName==='symbol')return 'HCAT'
      if(functionName==='totalSupply')return 1000n
      if(functionName==='pendingRewards')return 11n
      if(functionName==='balanceOf')return 40n
      if(functionName==='buyVolume')return 5n
      if(functionName==='sellVolume')return 0n
      if(functionName==='tradeCount')return 2n
      if(functionName==='liveStreamers')return streamer
      if(functionName==='streams'){
        const who=String(args?.[0]).toLowerCase()
        if(who===streamer.toLowerCase())return {host:streamer,live:true,startedAt:1700000000n,tipsWei:100n,claimable:95n,claimed:0n,title:'Live booth'}
        if(who===owner.toLowerCase())return {host:owner,live:false,startedAt:1690000000n,tipsWei:20n,claimable:19n,claimed:1n,title:'Yesterday recap'}
        if(who===ended.toLowerCase())return {host:ended,live:false,startedAt:1680000000n,tipsWei:8n,claimable:7n,claimed:0n,title:'Hidden ended'}
        return {host:'0x0000000000000000000000000000000000000000',live:false,startedAt:0n,tipsWei:0n,claimable:0n,claimed:0n,title:''}
      }
      if(functionName==='isVault')return true
      return 0n
    })
    const feed=await f.service.list(owner)
    expect(feed).toMatchObject({chainId:4663,factory,incomplete:false,blockNumber:'101'})
    expect(feed.vaults).toHaveLength(1)
    expect(feed.vaults[0]).toMatchObject({vault,token,creator:owner,name:'Sealed Cat',symbol:'HCAT',description:'Sealed community',pendingRewards:'11',tokenBalance:'40',buyVolume:'5'})
    expect(feed.vaults[0].streams.map((s:{streamer:string;live:boolean;title:string})=>[s.streamer,s.live,s.title])).toEqual([[streamer,true,'Live booth'],[owner,false,'Yesterday recap']])
    expect(feed.vaults[0].streams.some((s:{streamer:string})=>s.streamer.toLowerCase()===foreign.toLowerCase()||s.streamer.toLowerCase()===ended.toLowerCase())).toBe(false)
    expect(feed.coverage).toMatch(/ended streams/i)
    expect(f.rpc.getBlockNumber).toHaveBeenCalled()
  })

  it('does not invent vaults when the factory page is empty',async()=>{
    const f=setup()
    f.rpc.readContract.mockImplementation(async({functionName}:{functionName:string})=>{
      if(functionName==='vaultCount')return 0n
      if(functionName==='getVaults')return []
      throw new Error('unexpected '+functionName)
    })
    await expect(f.service.list()).resolves.toMatchObject({vaults:[],incomplete:false,factory})
  })

  it('marks partial coverage when a vault cannot be read',async()=>{
    const broken=address('8')
    const f=setup()
    f.rpc.readContract.mockImplementation(async({functionName,address}:{functionName:string;address?:string})=>{
      if(functionName==='vaultCount')return 2n
      if(functionName==='getVaults')return [vault,broken]
      if(address===broken)throw new Error('rpc timeout')
      if(functionName==='token')return token
      if(functionName==='creator')return owner
      if(functionName==='metadataURI')return ''
      if(functionName==='realEth')return 1n
      if(functionName==='tokenReserve')return 1n
      if(functionName==='rewardPot')return 0n
      if(functionName==='participants')return 0n
      if(functionName==='liveCount')return 0n
      if(functionName==='name')return 'Ok'
      if(functionName==='symbol')return 'OK'
      if(functionName==='totalSupply')return 1000n
      return 0n
    })
    const feed=await f.service.list()
    expect(feed.incomplete).toBe(true)
    expect(feed.vaults).toHaveLength(1)
    expect(feed.coverage).toMatch(/could not be read/)
  })

  it('refuses an invalid snapshot account and stays disabled without a factory',async()=>{
    const f=setup()
    await expect(f.service.list('0x0')).rejects.toMatchObject({code:'INVALID_ADDRESS'})
    const empty=setup({})
    await expect(empty.service.list()).rejects.toMatchObject({code:'FOREVER_NOT_CONFIGURED'})
  })
})
