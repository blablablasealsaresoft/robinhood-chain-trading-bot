import { describe,expect,it,vi } from 'vitest'
import { getAddress } from 'viem'
import { Journal } from '../../src/framework/journal.js'
import type { Market } from '../../src/framework/market.js'
import type { AssetRegistry } from '../../src/hub/assets.js'
import { MarketSeriesService } from '../../src/hub/market-series.js'

const token=getAddress('0x2222222222222222222222222222222222222222')
const stock=getAddress('0x3333333333333333333333333333333333333333')
function fixture(){
 let now=1_000_000
 const journal=new Journal(':memory:')
 const market={
  spotPrice:vi.fn(async()=>({token,priceUsd:2.5,via:'usdg',ts:now})),
  stockChainlinkPrice:vi.fn(async()=>({symbol:'AAPL',address:stock,feed:token,priceUsd:100,answer:1n,answerDecimals:8,roundId:1n,updatedAt:1,ageSeconds:1})),
  stockDexPrice:vi.fn(async()=>102),
 } as unknown as Market
 const assets=[
  {id:'asset',chainId:4663,address:token,symbol:'TOKEN',name:'Token',decimals:18,type:'crypto',source:'test',tradable:true},
  {id:'stock',chainId:4663,address:stock,symbol:'AAPL',name:'Apple',decimals:18,type:'stock-token',source:'test',tradable:false},
 ]
 const registry={chainId:4663,list:()=>assets,get:(addr:string)=>assets.find(a=>a.address.toLowerCase()===addr.toLowerCase())} as unknown as AssetRegistry
 const service=new MarketSeriesService(market,registry,journal,()=>now)
 return {journal,market,service,advance:(ms:number)=>{now+=ms}}
}

describe('MarketSeriesService',()=>{
 it('records real DEX spot samples and returns persisted history',async()=>{
  const f=fixture()
  const first=await f.service.read({asset:token,hours:1,limit:100})
  expect(first).toMatchObject({chainId:4663,label:'TOKEN',kind:'asset'})
  expect(first.points).toHaveLength(1)
  expect(first.points[0]).toMatchObject({priceUsd:2.5,dexUsd:2.5,referenceUsd:null,source:'dex-usdg'})
  await f.service.read({asset:token,hours:1,limit:100})
  expect(f.market.spotPrice).toHaveBeenCalledTimes(1)
  f.advance(10_000)
  await f.service.read({asset:token,hours:1,limit:100})
  expect(f.market.spotPrice).toHaveBeenCalledTimes(2)
  f.journal.close()
 })
 it('records Stock Token reference, DEX and spread without fabricating OHLCV',async()=>{
  const f=fixture()
  const result=await f.service.read({symbol:'AAPL',hours:24,limit:100})
  expect(result.kind).toBe('stock-token')
  expect(result.points[0]).toMatchObject({referenceUsd:100,dexUsd:102,priceUsd:102,source:'stock-token-chainlink+dex'})
  expect(result.points[0]!.spreadBps).toBeCloseTo(200,8)
  expect(result.note).toContain('not exchange OHLCV')
  f.journal.close()
 })
 it('validates asset selection and bounds',async()=>{
  const f=fixture()
  await expect(f.service.read({asset:token,symbol:'AAPL'})).rejects.toMatchObject({code:'AMBIGUOUS_ASSET'})
  await expect(f.service.read({asset:'bad'})).rejects.toMatchObject({code:'INVALID_ASSET'})
  await expect(f.service.read({symbol:'MSFT'})).rejects.toMatchObject({code:'UNKNOWN_STOCK'})
  await expect(f.service.read({asset:token,hours:0})).rejects.toMatchObject({code:'INVALID_HOURS'})
  await expect(f.service.read({asset:token,limit:1})).rejects.toMatchObject({code:'INVALID_LIMIT'})
  f.journal.close()
 })
})
