import { isStockTokenAddress, TESTNET_STOCK_TOKENS } from 'hoodchain'
import { getAddress, type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Asset, AssetType } from './types.js'

export type ReviewedTradeAsset = {
  address: Address; symbol: string; name: string; decimals: number
  type: Exclude<AssetType,'stock-token'>
}

export function parseReviewedTradeAssets(raw:string|undefined):ReviewedTradeAsset[] {
  if(!raw?.trim())return []
  let parsed:unknown
  try{parsed=JSON.parse(raw)}catch{throw new Error('HUB_TRADE_ASSETS must be valid JSON')}
  if(!Array.isArray(parsed)||parsed.length>50)throw new Error('HUB_TRADE_ASSETS must be an array of at most 50 assets')
  const seen=new Set<string>()
  return parsed.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('HUB_TRADE_ASSETS['+index+'] must be an object')
    const value=item as Record<string,unknown>
    const allowed=['address','symbol','name','decimals','type']
    if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('HUB_TRADE_ASSETS['+index+'] contains unsupported fields')
    if(typeof value.address!=='string')throw new Error('HUB_TRADE_ASSETS['+index+'].address is required')
    const address=getAddress(value.address)
    if(/^0x0{40}$/i.test(address))throw new Error('Reviewed assets cannot use the zero address')
    const key=address.toLowerCase()
    if(seen.has(key))throw new Error('HUB_TRADE_ASSETS contains duplicate addresses')
    seen.add(key)
    if(typeof value.symbol!=='string'||!/^[A-Za-z0-9._-]{1,16}$/.test(value.symbol))throw new Error('HUB_TRADE_ASSETS['+index+'].symbol is invalid')
    if(typeof value.name!=='string'||value.name.trim().length<1||value.name.trim().length>80)throw new Error('HUB_TRADE_ASSETS['+index+'].name is invalid')
    if(!Number.isInteger(value.decimals)||Number(value.decimals)<0||Number(value.decimals)>36)throw new Error('HUB_TRADE_ASSETS['+index+'].decimals must be an integer from 0 to 36')
    const type=(value.type??'crypto') as string
    if(!['crypto','stablecoin','launch-token'].includes(type))throw new Error('HUB_TRADE_ASSETS cannot enable Stock Tokens; type must be crypto, stablecoin or launch-token')
    return {address,symbol:value.symbol.toUpperCase(),name:value.name.trim(),decimals:Number(value.decimals),type:type as ReviewedTradeAsset['type']}
  })
}

/** Discovery and classification never implicitly grant trading permission. */
export class AssetRegistry {
  private readonly assets = new Map<string, Asset>()
  constructor(readonly chainId: number, market: Pick<Market, 'weth' | 'usdg' | 'usdgDecimals' | 'pricedStockTokens'>) {
    this.register({ address: market.weth, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, type: 'crypto', source: 'hoodchain', tradable: true })
    this.register({ address: market.usdg, symbol: 'USDG', name: 'Global Dollar', decimals: market.usdgDecimals, type: 'stablecoin', source: 'hoodchain', tradable: true })
    // SDK registry is mainnet-specific. Never relabel its addresses as testnet.
    if (chainId === 4663) for (const token of market.pricedStockTokens()) {
      this.register({ address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, type: 'stock-token', source: 'hoodchain/stock-registry', tradable: false })
    }
  }
  private register(asset: Omit<Asset, 'id' | 'chainId'>): void {
    const address = getAddress(asset.address)
    this.assets.set(address.toLowerCase(), { ...asset, address, chainId: this.chainId, id: 'eip155:' + this.chainId + '/erc20:' + address.toLowerCase() })
  }
  registerReviewed(asset:ReviewedTradeAsset):Asset {
    if((this.chainId===4663&&isStockTokenAddress(asset.address))||
      (this.chainId===46630&&Object.values(TESTNET_STOCK_TOKENS).some(address=>address.toLowerCase()===asset.address.toLowerCase())))
      throw new Error('Reviewed assets cannot override Stock Token eligibility')
    const existing=this.get(asset.address)
    if(existing) {
      if(existing.type==='stock-token')throw new Error('Reviewed assets cannot override Stock Token eligibility')
      if(existing.symbol!==asset.symbol||existing.decimals!==asset.decimals)throw new Error('Reviewed asset metadata conflicts with an existing registry asset')
      if(!existing.tradable) {
        this.register({...existing,...asset,source:'operator-reviewed',tradable:true})
        return {...this.get(asset.address)!}
      }
      return {...existing}
    }
    if(this.assets.size>=200)throw new Error('Asset registry capacity reached')
    this.register({...asset,source:'operator-reviewed',tradable:true})
    return {...this.get(asset.address)!}
  }
  registerDiscovered(asset: Omit<Asset,'id'|'chainId'>): Asset {
    const existing=this.get(asset.address)
    if(existing)return {...existing}
    // Discovery never promotes a token into the manual trading allowlist.
    if(this.assets.size>=200) {
      const oldest=[...this.assets.entries()].find(([,entry])=>entry.type==='launch-token' && !entry.tradable)
      if(oldest)this.assets.delete(oldest[0])
      else throw new Error('Discovery registry capacity reached')
    }
    this.register({...asset,tradable:false})
    return {...this.get(asset.address)!}
  }
  removeDiscovered(address:Address):void {
    const asset=this.get(address)
    if(asset?.type==='launch-token'&&!asset.tradable)this.assets.delete(address.toLowerCase())
  }
  list(): Asset[] { return [...this.assets.values()].map(asset => ({ ...asset })) }
  get(address: Address): Asset | undefined { return this.assets.get(address.toLowerCase()) }
}
