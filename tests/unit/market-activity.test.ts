import { describe,expect,it,vi } from 'vitest'
import { getAddress,zeroAddress } from 'viem'
import { Journal } from '../../src/framework/journal.js'
import type { Market } from '../../src/framework/market.js'
import type { AssetRegistry } from '../../src/hub/assets.js'
import { MarketActivityService } from '../../src/hub/market-activity.js'

const asset=getAddress('0x2222222222222222222222222222222222222222')
const usdg=getAddress('0x1111111111111111111111111111111111111111')
const pool=getAddress('0x3333333333333333333333333333333333333333')
const now=Date.UTC(2026,8,19,3,0,0)

function fixture(){
 const journal=new Journal(':memory:')
 const getLogs=vi.fn(async()=>[
  {removed:false,blockNumber:900n,logIndex:1,transactionHash:'0x'+'a'.repeat(64),blockHash:'0x'+'1'.repeat(64),args:{amount0:2_000_000n,amount1:-1_000_000_000_000_000_000n}},
  {removed:false,blockNumber:1000n,logIndex:2,transactionHash:'0x'+'b'.repeat(64),blockHash:'0x'+'2'.repeat(64),args:{amount0:-3_000_000n,amount1:1_000_000_000_000_000_000n}},
 ] as any)
 const publicClient={
  getChainId:vi.fn(async()=>4663),
  getBlockNumber:vi.fn(async()=>1000n),
  readContract:vi.fn(async({args}:any)=>args?.[2]===3000?pool:zeroAddress),
  getLogs,
  getBlock:vi.fn(async({blockNumber}:any)=>({hash:blockNumber===900n?'0x'+'1'.repeat(64):'0x'+'2'.repeat(64),timestamp:BigInt(Math.floor(now/1000)-(blockNumber===900n?120:60))})),
 }
 const market={client:{public:publicClient},usdg,usdgDecimals:6} as unknown as Market
 const row={id:'asset',chainId:4663,address:asset,symbol:'TEST',name:'Test',decimals:18,type:'crypto',source:'test',tradable:true}
 const registry={chainId:4663,get:(address:string)=>address.toLowerCase()===asset.toLowerCase()?row:undefined,list:()=>[row]} as unknown as AssetRegistry
 const service=new MarketActivityService(market,registry,journal,()=>now)
 return {journal,service,getLogs,publicClient,market}
}

describe('MarketActivityService',()=>{
 it('indexes canonical direct USDG swaps into time-and-sales and real candles',async()=>{
  const f=fixture()
  const result=await f.service.read({asset,hours:1,intervalSeconds:300,tradeLimit:20})
  expect(result.source).toBe('canonical-uniswap-v3-direct-usdg-pools')
  expect(result.indexedSwaps).toBe(2)
  expect(result.trades.map(t=>t.side)).toEqual(['sell','buy'])
  expect(result.trades[0]).toMatchObject({priceQuote:3,fee:3000,assetAmount:'1000000000000000000',quoteAmount:'3000000'})
  expect(result.trades[1]).toMatchObject({priceQuote:2,fee:3000,assetAmount:'1000000000000000000',quoteAmount:'2000000'})
  expect(result.candles).toHaveLength(1)
  expect(result.candles[0]).toMatchObject({open:2,high:3,low:2,close:3,volumeQuote:5,trades:2,buys:1,sells:1})
  expect(result.note).toContain('direct asset/USDG')
  f.journal.close()
 })
 it('discovers reviewed v3 fee tiers and uses persisted rows on overlapping rescans',async()=>{
  const f=fixture()
  await f.service.read({asset,hours:1,intervalSeconds:60})
  await f.service.read({asset,hours:1,intervalSeconds:60})
  expect(f.publicClient.readContract).toHaveBeenCalledTimes(8)
  expect(f.getLogs).toHaveBeenCalledTimes(2)
  expect(f.journal.marketSwaps(4663,asset,now-3600000,20)).toHaveLength(2)
  f.journal.close()
 })
 it('returns indexing state while a slow backfill continues without duplicate scans',async()=>{
  vi.useFakeTimers()
  const f=fixture();let release:((value:any[])=>void)|undefined
  f.getLogs.mockImplementationOnce(()=>new Promise<any[]>(resolve=>{release=resolve}))
  try{
   const reading=f.service.read({asset})
   await vi.advanceTimersByTimeAsync(2001)
   const result=await reading
   expect(result.indexing).toBe(true);expect(result.indexedSwaps).toBe(0)
   const second=f.service.read({asset})
   await vi.advanceTimersByTimeAsync(2001)
   expect((await second).indexing).toBe(true);expect(f.getLogs).toHaveBeenCalledTimes(1)
   release!([]);await vi.advanceTimersByTimeAsync(0)
  }finally{vi.useRealTimers();f.journal.close()}
 })
 it('rejects unsupported intervals, unknown assets and USDG as the activity asset',async()=>{
  const f=fixture()
  await expect(f.service.read({asset,hours:1,intervalSeconds:120})).rejects.toMatchObject({code:'INVALID_INTERVAL'})
  await expect(f.service.read({asset:'0x4444444444444444444444444444444444444444'})).rejects.toMatchObject({code:'UNKNOWN_ASSET'})
  const usdgRegistry={chainId:4663,get:()=>({id:'usdg',chainId:4663,address:usdg,symbol:'USDG',name:'USDG',decimals:6,type:'stablecoin',source:'test',tradable:true}),list:()=>[]} as unknown as AssetRegistry
  const service=new MarketActivityService(f.market,usdgRegistry,f.journal,()=>now)
  await expect(service.read({asset:usdg})).rejects.toMatchObject({code:'QUOTE_ASSET'})
  f.journal.close()
 })
})
