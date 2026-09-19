import { describe,expect,it,vi } from 'vitest'
import { getAddress,parseUnits } from 'viem'
import type { Market } from '../../src/framework/market.js'
import type { AssetRegistry } from '../../src/hub/assets.js'
import { MarketDepthService } from '../../src/hub/market-depth.js'

const asset=getAddress('0x2222222222222222222222222222222222222222')
const usdg=getAddress('0x1111111111111111111111111111111111111111')
function fixture(){
 const quoteBuy=vi.fn(async(_quote:string,_token:string,amountIn:bigint)=>{
  const usd=Number(amountIn)/1e6
  if(usd>250)return null
  const price=10*(1+usd/10000)
  const tokens=usd/price
  return {amountIn,amountOut:parseUnits(tokens.toFixed(18),18),gasEstimate:150000n,route:{path:[usdg,asset],fees:[3000],encodedPath:'0x'}} as any
 })
 const quoteSell=vi.fn(async(_token:string,_quote:string,amountIn:bigint)=>{
  const tokens=Number(amountIn)/1e18,notional=tokens*10
  if(notional>250)return null
  const price=10*(1-notional/12500)
  return {amountIn,amountOut:parseUnits((tokens*price).toFixed(6),6),gasEstimate:160000n,route:{path:[asset,usdg],fees:[500],encodedPath:'0x'}} as any
 })
 const market={usdg,usdgDecimals:6,spotPrice:vi.fn(async()=>({token:asset,priceUsd:10,via:'usdg',ts:1})),stockChainlinkPrice:vi.fn(),quoteBuy,quoteSell} as unknown as Market
 const row={id:'asset',chainId:4663,address:asset,symbol:'TEST',name:'Test',decimals:18,type:'crypto',source:'test',tradable:true}
 const registry={chainId:4663,get:(address:string)=>address.toLowerCase()===asset.toLowerCase()?row:undefined,list:()=>[row]} as unknown as AssetRegistry
 return {service:new MarketDepthService(market,registry,()=>123456),quoteBuy,quoteSell,market}
}
describe('MarketDepthService',()=>{
 it('returns executable buy/sell curves with impact and route metadata',async()=>{
  const f=fixture(),result=await f.service.read(asset)
  expect(result.levelsUsd).toEqual([10,25,50,100,250,500])
  expect(result.buy[0]).toMatchObject({notionalUsd:10,available:true,slippageBps:0,routeHops:1,routeFees:[3000]})
  expect(result.sell[0]).toMatchObject({notionalUsd:10,available:true,slippageBps:0,routeHops:1,routeFees:[500]})
  expect(result.buy[4].slippageBps).toBeGreaterThan(result.buy[1].slippageBps!)
  expect(result.sell[4].slippageBps).toBeGreaterThan(result.sell[1].slippageBps!)
  expect(result.buy[5].available).toBe(false)
  expect(result.sell[5].available).toBe(false)
  expect(result.maxExecutableBuyUsd).toBe(250)
  expect(result.maxExecutableSellUsd).toBe(250)
  expect(result.note).toContain('not an order book')
 })
 it('uses Chainlink reference for Stock Token sell sizing without granting trade permission',async()=>{
  const f=fixture()
  const stockRow={id:'stock',chainId:4663,address:asset,symbol:'AAPL',name:'Apple',decimals:18,type:'stock-token',source:'test',tradable:false}
  const registry={chainId:4663,get:()=>stockRow,list:()=>[stockRow]} as unknown as AssetRegistry
  const market=f.market
  vi.mocked(market.stockChainlinkPrice).mockResolvedValue({symbol:'AAPL',address:asset,feed:usdg,priceUsd:10,answer:1n,answerDecimals:8,roundId:1n,updatedAt:1,ageSeconds:1})
  const service=new MarketDepthService(market,registry,()=>123456)
  const result=await service.read(asset)
  expect(result.referencePriceUsd).toBe(10)
  expect(result.asset.type).toBe('stock-token')
 })
 it('validates network, asset, and reference availability',async()=>{
  const f=fixture()
  await expect(f.service.read('bad')).rejects.toMatchObject({code:'INVALID_ASSET'})
  const unknownRegistry={chainId:4663,get:()=>undefined,list:()=>[]} as unknown as AssetRegistry
  const market=f.market
  await expect(new MarketDepthService(market,unknownRegistry).read(asset)).rejects.toMatchObject({code:'UNKNOWN_ASSET'})
 })
})
