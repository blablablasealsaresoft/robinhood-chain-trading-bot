import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from 'viem'
import type { Fleet } from '../framework/fleet.js'
import type { Market } from '../framework/market.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

/** Read adapter: valuation never grants permission to acquire a security. */
export class HubReadModel {
  private stocksCache = new Map<string, { at: number; value: unknown }>()
  private stocksPending = new Map<string, Promise<unknown>>()
  constructor(private fleet: Fleet, private market: Market, private registry: AssetRegistry) {}
  async checkChain() {
    if (await this.market.client.public.getChainId() !== this.registry.chainId) throw new HubError(503, 'CHAIN_MISMATCH', 'The RPC returned a different network.')
  }
  strategies() {
    return this.fleet.agentDescriptions().map(agent => ({
      ...agent, lastError: agent.lastError ? 'The last tick failed. Check the local service journal.' : null,
      controlEnabled: this.fleet.config.mode === 'paper',
    }))
  }
  positions() {
    return this.fleet.agentStatuses().flatMap(a => a.positions.map(p => ({
      ...p, id: a.id + ':' + p.token.toLowerCase(), agentId: a.id, mode: a.mode,
      unrealizedUsd: p.markUsd === null ? null : p.markUsd - p.investedUsd,
    })))
  }
  activity() {
    const trades = this.fleet.journal.allRecentTrades(100).map(t => ({
      id: 'trade:' + t.id, at: t.ts, type: 'trade', source: t.agentId, mode: t.mode,
      title: t.side.toUpperCase() + ' ' + t.tokenSymbol, detail: t.reason,
      status: t.mode === 'paper' ? 'simulated' : 'recorded', txHash: t.txHash,
    }))
    const decisions = this.fleet.journal.allRecentDecisions(100).map(d => ({
      id: 'decision:' + d.id, at: d.ts, type: d.kind, source: d.agentId,
      mode: d.agentId === 'hub:manual' ? 'manual' : typeof d.meta.mode === 'string' ? d.meta.mode : 'journal',
      title: d.agentId === 'hub:manual' ? 'Wallet transaction prepared' : d.kind === 'alert' ? 'Strategy alert' : d.kind === 'refused' ? 'Risk gate refused an order' : 'Strategy observation',
      // Errors can contain RPC URLs or credentials; keep raw diagnostics in the operator journal.
      detail: /error|https?:\/\//i.test(d.detail) ? 'See the local journal for diagnostic details.' : d.detail,
      status: d.agentId === 'hub:manual' ? 'unsigned' : 'recorded', txHash: null,
    }))

    const wallets=this.fleet.journal.recentWalletActivity(100).map(event=>({
      id:'wallet:'+event.chainId+':'+event.txHash,at:event.at,type:event.kind,source:'user-wallet',mode:'wallet',
      title:event.kind==='approval'?'Token approval':event.kind==='swap'?'Wallet swap':event.kind==='wrap'?'ETH wrapped to WETH':'WETH unwrapped to ETH',
      detail:'Chain '+event.chainId+' · '+event.account+' · '+(event.blockNumber?'Block '+event.blockNumber:'Awaiting receipt'),
      status:event.status,txHash:event.txHash,chainId:event.chainId,owner:event.account,verifiedAt:event.observedAt,
    }))


    const observations=[...this.fleet.journal.externalEvents('bridge',100),...this.fleet.journal.externalEvents('launch',100)].map(event=>({
      id:event.id,at:event.at,type:event.type,source:event.source,mode:event.type==='launch'?'discovery':'wallet',title:event.title,detail:event.detail,status:event.status,txHash:event.txHash,
      chainId:event.type==='bridge'?(event.data.reference as {fromChainId:number}).fromChainId:event.chainId,owner:event.owner,
      verifiedAt:event.verification==='unverified'?undefined:event.observedAt,observedAt:event.observedAt,verification:event.verification,
      link:event.type==='bridge'?'https://scan.li.fi/tx/'+encodeURIComponent(event.txHash):'https://robinhoodchain.blockscout.com/tx/'+event.txHash,
      receivingHash:event.type==='bridge'?event.data.receivingHash:null,
    }))

    return [...trades, ...decisions, ...wallets, ...observations].sort((a,b) => b.at-a.at).slice(0,100)
  }
  async stock(symbol: string) {
    const token = this.registry.list().find(a => a.type === 'stock-token' && a.symbol === symbol.toUpperCase())
    if (!token) throw new HubError(404, 'UNKNOWN_STOCK', 'This Stock Token is not in the network registry.')
    const cached = this.stocksCache.get(token.symbol)
    if (cached && Date.now()-cached.at < 30_000) return cached.value
    const pending = this.stocksPending.get(token.symbol)
    if (pending) return pending
    const request = (async () => {
      await this.checkChain()
      const reference = await this.market.stockChainlinkPrice(token.symbol)
      // Reuse Market and preserve its existing eligibility gate on acquisition quotes.
      const dex = reference ? await this.market.stockDexPrice(token.address, reference.priceUsd) : null
      const value = { asset: token, referencePriceUsd: reference?.priceUsd ?? null, referenceUpdatedAt: reference ? reference.updatedAt * 1000 : null,
        dexPriceUsd: dex, premiumBps: reference && dex !== null ? (dex/reference.priceUsd-1)*10000 : null,
        liquidityUsd: null, tradingEnabled: false, dexStatus: dex === null ? 'unavailable' : 'quoted',
        observedAt: Date.now(), probeUsdg: '10' }
      this.stocksCache.set(token.symbol, { at: Date.now(), value })
      return value
    })().finally(() => this.stocksPending.delete(token.symbol))
    this.stocksPending.set(token.symbol, request)
    return request
  }
  async portfolio(raw: string | null) {
    if (!raw || !isAddress(raw) || /^0x0{40}$/i.test(raw)) throw new HubError(400, 'INVALID_ACCOUNT', 'Enter a valid public wallet address.')
    const account = getAddress(raw)
    await this.checkChain()
    const blockNumber = await this.market.client.public.getBlockNumber()
    const assets = this.registry.list()
    const [native, balances, ethPrice] = await Promise.all([
      this.market.client.public.getBalance({ address: account, blockNumber }).catch(() => null),
      this.market.client.public.multicall({ contracts: assets.map(a => ({ address: a.address as Address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [account] as const })), blockNumber, allowFailure: true }),
      this.market.ethUsd(),
    ])
    const nativeAsset = { id: 'eip155:' + this.registry.chainId + '/native', chainId: this.registry.chainId, address: null, symbol: 'ETH', name: 'Ether', decimals: 18, type: 'crypto', tradable: false, source: 'rpc' }
    const holdings: { asset: Omit<typeof nativeAsset, 'address'> & { address: string | null }; balance: string | null; priceUsd: number | null; valueUsd: number | null; priceSource: string; balanceStatus: string }[] = [{
      asset: nativeAsset, balance: native?.toString() ?? null, priceUsd: ethPrice, valueUsd: native !== null && ethPrice !== null ? Number(formatUnits(native,18))*ethPrice : null,
      priceSource: 'WETH/USDG probe', balanceStatus: native === null ? 'unavailable' : 'read',
    }]
    for (let i=0; i<assets.length; i++) {
      const asset = assets[i]!, result = balances[i]
      const balance = result?.status === 'success' ? result.result as bigint : null
      let price = asset.symbol === 'WETH' ? ethPrice : asset.symbol === 'USDG' ? 1 : null
      if (asset.type === 'stock-token' && balance !== null && balance > 0n) price = (await this.market.stockChainlinkPrice(asset.symbol))?.priceUsd ?? null
      holdings.push({ asset, balance: balance?.toString() ?? null, priceUsd: price,
        valueUsd: balance === 0n ? 0 : balance !== null && price !== null ? Number(formatUnits(balance,asset.decimals))*price : null,
        priceSource: asset.type === 'stock-token' ? 'Chainlink price per token' : asset.symbol === 'USDG' ? 'USDG valued at $1 (assumption)' : 'WETH/USDG probe',
        balanceStatus: balance === null ? 'unavailable' : 'read' })
    }
    return { account, chainId: this.registry.chainId, blockNumber: blockNumber.toString(), observedAt: Date.now(), holdings,
      pricedValueUsd: holdings.reduce((sum,h) => sum+(h.valueUsd ?? 0),0),
      incomplete: holdings.some(h => h.balance === null || (h.balance !== '0' && h.valueUsd === null)),
      walletPnlUsd: null, positions: this.positions(), botSummary: this.fleet.summary(),
      coverage: 'Native ETH and the Hub asset registry only. Bot positions are separate and are not added to wallet value.' }
  }
}
