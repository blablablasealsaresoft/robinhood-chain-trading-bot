import { MAINNET_ADDRESSES,uniswapV3FactoryAbi } from 'hoodchain'
import { formatUnits,getAddress,isAddress,parseAbiItem,zeroAddress,type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

const FEES=[100,500,3000,10000] as const
const swapEvent=parseAbiItem('event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)')
const MAX_BACKFILL_BLOCKS=20_000n
const REORG_OVERLAP_BLOCKS=50n
const LOG_CHUNK=5_000n
const ALLOWED_INTERVALS=new Set([60,300,900,3600])

type SwapRow={pool:string;txHash:string;logIndex:number;blockNumber:bigint;blockHash:string;blockTime:number;asset:string;quote:string;fee:number;side:'buy'|'sell';assetAmount:string;quoteAmount:string;priceQuote:number}

export class MarketActivityService {
  private readonly scanning=new Map<string,Promise<void>>()
  constructor(private market:Market,private registry:AssetRegistry,private journal:Pick<Journal,'replaceMarketSwapWindow'|'marketSwaps'|'latestMarketSwapBlock'>,private clock:()=>number=Date.now){}

  async read(input:{asset?:string|null;hours?:number;intervalSeconds?:number;tradeLimit?:number}){
    const hours=input.hours??24,intervalSeconds=input.intervalSeconds??300,tradeLimit=input.tradeLimit??100
    if(!Number.isFinite(hours)||hours<1||hours>720)throw new HubError(400,'INVALID_HOURS','Market activity hours must be between 1 and 720.')
    if(!ALLOWED_INTERVALS.has(intervalSeconds))throw new HubError(400,'INVALID_INTERVAL','Candle interval must be 60, 300, 900, or 3600 seconds.')
    if(!Number.isInteger(tradeLimit)||tradeLimit<1||tradeLimit>200)throw new HubError(400,'INVALID_LIMIT','Trade limit must be between 1 and 200.')
    if(this.registry.chainId!==4663)throw new HubError(422,'MARKET_ACTIVITY_NETWORK','Market activity is available on Robinhood Chain mainnet only.')
    if(!input.asset||!isAddress(input.asset)||input.asset.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ASSET','Supply a valid registered asset address.')
    const asset=this.registry.get(getAddress(input.asset))
    if(!asset)throw new HubError(404,'UNKNOWN_ASSET','Asset is not in the Hub registry.')
    if(asset.address.toLowerCase()===this.market.usdg.toLowerCase())throw new HubError(422,'QUOTE_ASSET','USDG is the quote asset for direct-pool activity.')
    await this.refresh(asset.address,asset.decimals)
    const now=this.clock(),rows=this.journal.marketSwaps(4663,asset.address,now-hours*3600_000,2000)
    const chronological=[...rows].reverse()
    const candles=aggregateCandles(chronological,intervalSeconds)
    return {
      chainId:4663,asset:{address:asset.address,symbol:asset.symbol,name:asset.name,decimals:asset.decimals,type:asset.type},
      quote:{address:this.market.usdg,symbol:'USDG',decimals:this.market.usdgDecimals},
      hours,intervalSeconds,observedAt:now,candles,
      trades:rows.slice(0,tradeLimit),
      indexedSwaps:rows.length,
      coverage:rows.length?{from:chronological[0]!.blockTime,to:chronological.at(-1)!.blockTime}:null,
      source:'canonical-uniswap-v3-direct-usdg-pools',
      note:'Candles and time-and-sales are derived only from canonical direct asset/USDG Uniswap v3 Swap events. Routed WETH/multihop flow is intentionally excluded.',
    }
  }

  private async refresh(asset:Address,assetDecimals:number){
    const key=asset.toLowerCase()
    const pending=this.scanning.get(key);if(pending)return pending
    const request=this.scan(asset,assetDecimals).finally(()=>this.scanning.delete(key))
    this.scanning.set(key,request);return request
  }

  private async scan(asset:Address,assetDecimals:number){
    const rpc=this.market.client.public
    if(await rpc.getChainId()!==4663)throw new HubError(503,'CHAIN_MISMATCH','Market activity RPC is not on Robinhood Chain mainnet.')
    const factory=MAINNET_ADDRESSES.uniswapV3Factory
    const discovered:(readonly [Address,number])[]=[]
    for(const fee of FEES){
      const pool=await rpc.readContract({address:factory,abi:uniswapV3FactoryAbi,functionName:'getPool',args:[asset,this.market.usdg,fee]})
      if(pool&&pool.toLowerCase()!==zeroAddress)discovered.push([getAddress(pool),fee])
    }
    if(!discovered.length)return
    const head=await rpc.getBlockNumber()
    const blockCache=new Map<string,{time:number;hash:string}>()
    for(const [pool,fee] of discovered){
      const prior=this.journal.latestMarketSwapBlock(4663,[pool])
      const start=prior===null?(head>MAX_BACKFILL_BLOCKS?head-MAX_BACKFILL_BLOCKS:0n):(prior>REORG_OVERLAP_BLOCKS?prior-REORG_OVERLAP_BLOCKS:0n)
      const rows:SwapRow[]=[]
      for(let from=start;from<=head;from+=LOG_CHUNK){
        const to=from+LOG_CHUNK-1n<head?from+LOG_CHUNK-1n:head
        const logs=await rpc.getLogs({address:pool,event:swapEvent,fromBlock:from,toBlock:to,strict:true})
        for(const log of logs){
          if(log.removed||log.blockNumber===null||log.logIndex===null||!log.transactionHash||!log.blockHash)continue
          const blockKey=log.blockNumber.toString()
          let block=blockCache.get(blockKey)
          if(!block){
            const fetched=await rpc.getBlock({blockNumber:log.blockNumber})
            if(fetched.hash!==log.blockHash)continue
            block={time:Number(fetched.timestamp)*1000,hash:fetched.hash};blockCache.set(blockKey,block)
          }
          const token0=asset.toLowerCase()<this.market.usdg.toLowerCase()?asset:this.market.usdg
          const assetDelta=token0.toLowerCase()===asset.toLowerCase()?log.args.amount0:log.args.amount1
          const quoteDelta=token0.toLowerCase()===asset.toLowerCase()?log.args.amount1:log.args.amount0
          if(assetDelta===undefined||quoteDelta===undefined||assetDelta===0n||quoteDelta===0n)continue
          const assetAbs=assetDelta<0n?-assetDelta:assetDelta,quoteAbs=quoteDelta<0n?-quoteDelta:quoteDelta
          const assetHuman=Number(formatUnits(assetAbs,assetDecimals)),quoteHuman=Number(formatUnits(quoteAbs,this.market.usdgDecimals))
          if(!Number.isFinite(assetHuman)||assetHuman<=0||!Number.isFinite(quoteHuman)||quoteHuman<=0)continue
          rows.push({pool,txHash:log.transactionHash,logIndex:log.logIndex,blockNumber:log.blockNumber,blockHash:block.hash,blockTime:block.time,asset,quote:this.market.usdg,fee,
            side:assetDelta>0n?'sell':'buy',assetAmount:assetAbs.toString(),quoteAmount:quoteAbs.toString(),priceQuote:quoteHuman/assetHuman})
        }
      }
      this.journal.replaceMarketSwapWindow(4663,[pool],start,rows)
    }
  }
}

function aggregateCandles(rows:Array<{blockTime:number;priceQuote:number;quoteAmount:string;side:'buy'|'sell'}>,intervalSeconds:number){
  const size=intervalSeconds*1000
  const buckets=new Map<number,{time:number;open:number;high:number;low:number;close:number;volumeQuote:number;trades:number;buys:number;sells:number}>()
  for(const row of rows){
    const time=Math.floor(row.blockTime/size)*size,price=row.priceQuote,volume=Number(BigInt(row.quoteAmount))/1e6
    const candle=buckets.get(time)
    if(!candle)buckets.set(time,{time,open:price,high:price,low:price,close:price,volumeQuote:volume,trades:1,buys:row.side==='buy'?1:0,sells:row.side==='sell'?1:0})
    else{candle.high=Math.max(candle.high,price);candle.low=Math.min(candle.low,price);candle.close=price;candle.volumeQuote+=volume;candle.trades++;if(row.side==='buy')candle.buys++;else candle.sells++}
  }
  return [...buckets.values()].sort((a,b)=>a.time-b.time)
}
