import { getAddress,isAddress,type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

const MIN_SAMPLE_MS=10_000
export class MarketSeriesService {
  private lastSample=new Map<string,number>()
  constructor(private market:Market,private registry:AssetRegistry,private journal:Pick<Journal,'recordMarketSample'|'marketSeries'>,private clock:()=>number=Date.now){}

  async read(input:{asset?:string|null;symbol?:string|null;hours?:number;limit?:number}){
    const hours=input.hours??24,limit=input.limit??720
    if(!Number.isFinite(hours)||hours<1||hours>720)throw new HubError(400,'INVALID_HOURS','Market series hours must be between 1 and 720.')
    if(!Number.isInteger(limit)||limit<2||limit>2000)throw new HubError(400,'INVALID_LIMIT','Market series limit must be between 2 and 2000.')
    const chainId=this.registry.chainId
    if(chainId!==4663)throw new HubError(422,'MARKET_SERIES_NETWORK','Market series are currently available on Robinhood Chain mainnet only.')
    const now=this.clock()
    let key:string,label:string,kind:'stock-token'|'asset',address:Address
    const symbol=(input.symbol||'').trim().toUpperCase()
    if(symbol){
      if(input.asset)throw new HubError(400,'AMBIGUOUS_ASSET','Supply either asset or symbol, not both.')
      const stock=this.registry.list().find(a=>a.type==='stock-token'&&a.symbol===symbol)
      if(!stock)throw new HubError(404,'UNKNOWN_STOCK','Unknown Stock Token symbol.')
      key='stock:'+stock.symbol.toLowerCase();label=stock.symbol;kind='stock-token';address=stock.address
    }else{
      if(!input.asset||!isAddress(input.asset))throw new HubError(400,'INVALID_ASSET','Supply a valid asset address or Stock Token symbol.')
      address=getAddress(input.asset)
      const asset=this.registry.get(address)
      if(!asset)throw new HubError(404,'UNKNOWN_ASSET','Asset is not in the Hub registry.')
      key='asset:'+address.toLowerCase();label=asset.symbol;kind=asset.type==='stock-token'?'stock-token':'asset'
    }

    if(now-(this.lastSample.get(key)??0)>=MIN_SAMPLE_MS){
      if(kind==='stock-token'){
        const stock=this.registry.list().find(a=>a.address.toLowerCase()===address.toLowerCase()&&a.type==='stock-token')
        if(!stock)throw new HubError(404,'UNKNOWN_STOCK','Stock Token is not in the registry.')
        const reference=await this.market.stockChainlinkPrice(stock.symbol)
        const dex=reference?await this.market.stockDexPrice(stock.address,reference.priceUsd):null
        const spread=reference&&dex!==null?(dex/reference.priceUsd-1)*10000:null
        this.journal.recordMarketSample({chainId,assetKey:key,observedAt:now,priceUsd:dex??reference?.priceUsd??null,referenceUsd:reference?.priceUsd??null,dexUsd:dex,spreadBps:spread,source:'stock-token-chainlink+dex'})
      }else{
        const asset=this.registry.get(address)!
        const spot=await this.market.spotPrice(address,asset.decimals,now)
        this.journal.recordMarketSample({chainId,assetKey:key,observedAt:now,priceUsd:spot?.priceUsd??null,referenceUsd:null,dexUsd:spot?.priceUsd??null,spreadBps:null,source:spot?'dex-'+spot.via:'unavailable'})
      }
      this.lastSample.set(key,now)
    }
    const points=this.journal.marketSeries(chainId,key,now-hours*3600_000,limit)
    return {chainId,key,label,kind,hours,observedAt:now,points,incomplete:points.length===0||points.at(-1)?.priceUsd===null,
      note:'Observed Hub market samples. This is not exchange OHLCV data and does not represent consolidated market volume.'}
  }
}
