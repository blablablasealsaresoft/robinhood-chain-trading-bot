import { getAddress, type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Asset } from './types.js'

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
