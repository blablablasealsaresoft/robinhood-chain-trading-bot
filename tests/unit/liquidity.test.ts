import { beforeEach,describe,expect,it,vi } from 'vitest'
import { decodeFunctionData,getAddress,zeroAddress } from 'viem'
import { MAINNET_ADDRESSES,erc20Abi } from 'hoodchain'
import { Market } from '../../src/framework/market.js'
import type { FleetConfig } from '../../src/framework/config.js'
import { AssetRegistry } from '../../src/hub/assets.js'
import { LiquidityService } from '../../src/hub/liquidity.js'
import { positionManagerAbi } from '../../src/hub/liquidity-abi.js'

const config: FleetConfig={network:'mainnet',rpcUrl:undefined,mode:'paper',hasWallet:false,privateKey:undefined,stockTokenEligible:false,fleetMaxDailySpendUsdg:250,dashboardPort:4670,killFile:'./KILL',dbPath:':memory:',defaultLimits:{maxPositionUsdg:50,maxDailySpendUsdg:100,maxSlippageBps:100,cooldownSeconds:60}}
const account=getAddress('0x1111111111111111111111111111111111111111')
const token=getAddress('0x3333333333333333333333333333333333333333')
const pool=getAddress('0x4444444444444444444444444444444444444444')

function fixture(){
  const market=new Market(config),registry=new AssetRegistry(4663,market)
  registry.registerDiscovered({address:token,symbol:'NEW',name:'New launch',decimals:18,type:'launch-token',source:'hub-launchpad',tradable:false})
  const journal={recordWalletPlan:vi.fn(),recordDecision:vi.fn()}
  const service=new LiquidityService(market,registry,{chainId:4663,maxSlippageBps:100,isKilled:()=>false,journal:journal as never,clock:()=>1_000_000})
  vi.spyOn(market.client.public,'getChainId').mockResolvedValue(4663)
  vi.spyOn(market.client.public,'getCode').mockResolvedValue('0x1234')
  vi.spyOn(market.client.public,'estimateGas').mockResolvedValue(500000n)
  vi.spyOn(market.client.public,'readContract').mockImplementation(async(args:any)=>{
    if(args.address.toLowerCase()===MAINNET_ADDRESSES.nonfungiblePositionManager.toLowerCase()){
      if(args.functionName==='factory')return MAINNET_ADDRESSES.uniswapV3Factory
      if(args.functionName==='WETH9')return MAINNET_ADDRESSES.weth
    }
    if(args.address.toLowerCase()===MAINNET_ADDRESSES.uniswapV3Factory.toLowerCase()&&args.functionName==='getPool')return zeroAddress
    if(args.functionName==='decimals')return 18
    if(args.functionName==='balanceOf')return 10n**30n
    if(args.functionName==='allowance')return 0n
    throw new Error('unexpected read '+args.functionName)
  })
  return {market,registry,journal,service}
}
const input={chainId:4663,account,token,tokenAmount:'1000000000000000000000',wethAmount:'1000000000000000000',fee:3000,slippageBps:50}

describe('manual Uniswap v3 launch liquidity',()=>{
 beforeEach(()=>vi.restoreAllMocks())

 it('prepares exact approvals plus create+initialize+full-range mint without a backend signer',async()=>{
   const f=fixture(),plan=await f.service.prepare(input)
   expect(plan).toMatchObject({kind:'liquidity-plan',signing:'user-wallet',chainId:4663,account,token,fee:3000,positionManager:MAINNET_ADDRESSES.nonfungiblePositionManager,simulation:'requires-approval',tradeAdmission:'operator-reviewed-after-verified-pool'})
   expect(plan.approvals).toHaveLength(2)
   for(const approval of plan.approvals){
     const decoded=decodeFunctionData({abi:erc20Abi,data:approval.data})
     expect(decoded.functionName).toBe('approve')
     expect(decoded.args?.[0]).toBe(MAINNET_ADDRESSES.nonfungiblePositionManager)
   }
   const outer=decodeFunctionData({abi:positionManagerAbi,data:plan.transaction.data})
   expect(outer.functionName).toBe('multicall')
   const calls=outer.args?.[0] as readonly `0x${string}`[]
   expect(calls).toHaveLength(2)
   const create=decodeFunctionData({abi:positionManagerAbi,data:calls[0]!})
   const mint=decodeFunctionData({abi:positionManagerAbi,data:calls[1]!})
   expect(create.functionName).toBe('createAndInitializePoolIfNecessary')
   expect(mint.functionName).toBe('mint')
   expect((mint.args?.[0] as any)).toMatchObject({fee:3000,tickLower:-887220,tickUpper:887220,recipient:account})
   expect(f.journal.recordWalletPlan).toHaveBeenCalledWith(expect.objectContaining({actions:expect.arrayContaining([expect.objectContaining({kind:'liquidity-add'})])}))
   expect(f.market.client.wallet).toBeNull()
 })

 it('requires exact launch-token classification and explicitly blocks Stock Tokens',async()=>{
   const f=fixture()
   await expect(f.service.prepare({...input,token:f.market.usdg})).rejects.toMatchObject({code:'LAUNCH_TOKEN_REQUIRED'})
   const stock=f.registry.list().find(a=>a.type==='stock-token')!
   await expect(f.service.prepare({...input,token:stock.address})).rejects.toMatchObject({code:'STOCK_TOKEN_BLOCKED'})
 })

 it('refuses existing pools so creators cannot unknowingly add at an existing market price',async()=>{
   const f=fixture()
   vi.mocked(f.market.client.public.readContract).mockImplementation(async(args:any)=>{
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.nonfungiblePositionManager.toLowerCase()){
       if(args.functionName==='factory')return MAINNET_ADDRESSES.uniswapV3Factory
       if(args.functionName==='WETH9')return MAINNET_ADDRESSES.weth
     }
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.uniswapV3Factory.toLowerCase()&&args.functionName==='getPool')return pool
     if(args.functionName==='decimals')return 18
     if(args.functionName==='balanceOf')return 10n**30n
     if(args.functionName==='allowance')return 0n
     throw new Error('unexpected')
   })
   await expect(f.service.prepare(input)).rejects.toMatchObject({code:'POOL_EXISTS'})
 })

 it('enforces balance, metadata, fee tier and slippage limits before producing calldata',async()=>{
   const f=fixture()
   await expect(f.service.prepare({...input,fee:2500})).rejects.toMatchObject({code:'INVALID_FEE'})
   await expect(f.service.prepare({...input,slippageBps:101})).rejects.toMatchObject({code:'SLIPPAGE_CAP'})
   vi.mocked(f.market.client.public.readContract).mockImplementation(async(args:any)=>{
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.nonfungiblePositionManager.toLowerCase()){
       if(args.functionName==='factory')return MAINNET_ADDRESSES.uniswapV3Factory
       if(args.functionName==='WETH9')return MAINNET_ADDRESSES.weth
     }
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.uniswapV3Factory.toLowerCase()&&args.functionName==='getPool')return zeroAddress
     if(args.functionName==='decimals')return 18
     if(args.functionName==='balanceOf')return 0n
     if(args.functionName==='allowance')return 0n
     throw new Error('unexpected')
   })
   await expect(f.service.prepare(input)).rejects.toMatchObject({code:'INSUFFICIENT_BALANCE'})
 })

 it('preflights the final mint when approvals already exist',async()=>{
   const f=fixture()
   const original=vi.mocked(f.market.client.public.readContract)
   original.mockImplementation(async(args:any)=>{
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.nonfungiblePositionManager.toLowerCase()){
       if(args.functionName==='factory')return MAINNET_ADDRESSES.uniswapV3Factory
       if(args.functionName==='WETH9')return MAINNET_ADDRESSES.weth
     }
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.uniswapV3Factory.toLowerCase()&&args.functionName==='getPool')return zeroAddress
     if(args.functionName==='decimals')return 18
     if(args.functionName==='balanceOf')return 10n**30n
     if(args.functionName==='allowance')return 10n**30n
     throw new Error('unexpected')
   })
   const plan=await f.service.prepare(input)
   expect(plan.approvals).toEqual([])
   expect(plan.simulation).toBe('passed')
   expect(f.market.client.public.estimateGas).toHaveBeenCalledOnce()
 })

 it('inspects verified pools and preserves operator-reviewed Trade admission',async()=>{
   const f=fixture()
   vi.spyOn(f.market,'quoteBuy').mockResolvedValue({amountIn:1n,amountOut:1n,gasEstimate:1n,route:{path:[f.market.weth,token],fees:[3000],encodedPath:'0x'}} as never)
   vi.mocked(f.market.client.public.readContract).mockImplementation(async(args:any)=>{
     if(args.address.toLowerCase()===MAINNET_ADDRESSES.uniswapV3Factory.toLowerCase()&&args.functionName==='getPool')return args.args[2]===3000?pool:zeroAddress
     if(args.address.toLowerCase()===pool.toLowerCase()&&args.functionName==='liquidity')return 123n
     if(args.address.toLowerCase()===pool.toLowerCase()&&args.functionName==='slot0')return [2n**96n,0,0,0,0,0,true]
     throw new Error('unexpected')
   })
   const status=await f.service.inspect(token)
   expect(status.pools).toEqual([expect.objectContaining({fee:3000,pool,initialized:true,liquidity:'123'})])
   expect(status.routeAvailable).toBe(true)
   expect(status.tradeEnabled).toBe(false)
   expect(status.admission).toContain('HUB_TRADE_ASSETS')
 })
})
