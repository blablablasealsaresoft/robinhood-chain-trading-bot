import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from 'viem'
import type { Fleet } from '../framework/fleet.js'
import type { Market } from '../framework/market.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

/** Read adapter: valuation never grants permission to acquire a security. */
export class HubReadModel {
  private stocksCache = new Map<string, { at: number; value: unknown }>()
  private stocksPending = new Map<string, Promise<unknown>>()
  private tokenPriceCache = new Map<string,{at:number;value:{price:number;source:string}|null}>()
  private tokenPricePending = new Map<string,Promise<{price:number;source:string}|null>>()
  private probeCursor=0
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
      title:event.kind.startsWith('launch-')?({'launch-create':'Token and sale created','launch-contribute':'Sale contribution','launch-claim':'Sale tokens claimed','launch-refund':'Sale contribution refunded','launch-proceeds':'Creator proceeds withdrawn','launch-remainder':'Remaining sale tokens withdrawn'} as Record<string,string>)[event.kind]:event.kind==='approval'?'Token approval':event.kind==='swap'?'Wallet swap':event.kind==='wrap'?'ETH wrapped to WETH':event.kind==='unwrap'?'WETH unwrapped to ETH':'Liquidity added',
      detail:'Chain '+event.chainId+' · '+event.account+' · '+(event.blockNumber?'Block '+event.blockNumber:'Awaiting receipt'),
      status:event.status,txHash:event.txHash,chainId:event.chainId,owner:event.account,verifiedAt:event.observedAt,
    }))


    const observations=[...this.fleet.journal.externalEvents('bridge',100),...this.fleet.journal.externalEvents('launch',100)].map(event=>({
      id:event.id,at:event.at,type:event.type,source:event.source==='hub-launchpad'&&wallets.some(w=>w.txHash===event.txHash)?'user-wallet':event.source,mode:event.source==='hub-launchpad'&&wallets.some(w=>w.txHash===event.txHash)?'wallet':event.type==='launch'?'discovery':'wallet',title:event.title,detail:event.detail,status:event.status,txHash:event.txHash,
      chainId:event.type==='bridge'?(event.data.reference as {fromChainId:number}).fromChainId:event.chainId,owner:event.owner,
      verifiedAt:event.verification==='unverified'?undefined:event.observedAt,observedAt:event.observedAt,verification:event.verification,
      link:event.type==='bridge'?'https://scan.li.fi/tx/'+encodeURIComponent(event.txHash):'https://robinhoodchain.blockscout.com/tx/'+event.txHash,
      receivingHash:event.type==='bridge'?event.data.receivingHash:null,
    }))

    const all=[...trades,...decisions,...wallets,...observations]
    const merged=new Map<string,typeof all[number]>()
    const checked=(e:typeof all[number])=>'observedAt' in e?e.observedAt:'verifiedAt' in e?e.verifiedAt??0:0
    for(const event of all){
      const key=event.source==='user-wallet'&&event.txHash&&'chainId' in event?'wallet:'+event.chainId+':'+event.txHash.toLowerCase():event.id
      const prior=merged.get(key);if(!prior||checked(event)>=checked(prior))merged.set(key,event)
    }
    return [...merged.values()].sort((a,b)=>b.at-a.at).slice(0,100)
  }

  activityPage(rawAccount:string|null,rawLimit=50,rawCursor:string|null=null) {
    if(!rawAccount||!isAddress(rawAccount)||/^0x0{40}$/i.test(rawAccount))throw new HubError(400,'INVALID_ACCOUNT','Enter a valid public wallet address.')
    const account=getAddress(rawAccount)
    if(!Number.isInteger(rawLimit)||rawLimit<1||rawLimit>100)throw new HubError(400,'INVALID_LIMIT','Activity limit must be between 1 and 100.')
    const cursor=decodeActivityCursor(rawCursor)
    const take=Math.min(101,rawLimit+1)
    const candidates:Array<{event:any;at:number;pageKey:string}>=[]
    for(const row of this.fleet.journal.walletActivityPage(account,take,cursor)){
      const event=row.value
      const title=event.kind.startsWith('launch-')?({'launch-create':'Token and sale created','launch-contribute':'Sale contribution','launch-claim':'Sale tokens claimed','launch-refund':'Sale contribution refunded','launch-proceeds':'Creator proceeds withdrawn','launch-remainder':'Remaining sale tokens withdrawn'} as Record<string,string>)[event.kind]:event.kind==='approval'?'Token approval':event.kind==='swap'?'Wallet swap':event.kind==='wrap'?'ETH wrapped to WETH':event.kind==='unwrap'?'WETH unwrapped to ETH':'Liquidity added'
      candidates.push({at:row.at,pageKey:row.pageKey,event:{
        id:'wallet:'+event.chainId+':'+event.txHash,at:event.at,type:event.kind,source:'user-wallet',mode:'wallet',
        title,detail:'Chain '+event.chainId+' · '+event.account+' · '+(event.blockNumber?'Block '+event.blockNumber:'Awaiting receipt'),
        status:event.status,txHash:event.txHash,chainId:event.chainId,owner:event.account,verifiedAt:event.observedAt,
      }})
    }
    for(const row of this.fleet.journal.externalEventsPage(account,take,cursor)){
      const event=row.value
      candidates.push({at:row.at,pageKey:row.pageKey,event:{
        id:event.id,at:event.at,type:event.type,source:event.source,mode:event.type==='launch'?'discovery':'wallet',
        title:event.title,detail:event.detail,status:event.status,txHash:event.txHash,
        chainId:event.type==='bridge'?(event.data.reference as {fromChainId?:number}|undefined)?.fromChainId??event.chainId:event.chainId,
        owner:event.owner,verifiedAt:event.verification==='unverified'?undefined:event.observedAt,observedAt:event.observedAt,verification:event.verification,
        link:event.type==='bridge'?'https://scan.li.fi/tx/'+encodeURIComponent(event.txHash):'https://robinhoodchain.blockscout.com/tx/'+event.txHash,
        receivingHash:event.type==='bridge'?event.data.receivingHash:null,
      }})
    }
    for(const row of this.fleet.journal.manualDecisionPage(account,take,cursor)){
      const decision=row.value
      candidates.push({at:row.at,pageKey:row.pageKey,event:{
        id:'decision:'+decision.id,at:decision.ts,type:decision.kind,source:decision.agentId,mode:'manual',
        title:'Wallet transaction prepared',
        detail:/error|https?:\/\//i.test(decision.detail)?'See the local journal for diagnostic details.':decision.detail,
        status:'unsigned',txHash:null,owner:account,
      }})
    }
    candidates.sort((a,b)=>b.at-a.at||b.pageKey.localeCompare(a.pageKey))
    const page=candidates.slice(0,rawLimit)
    const hasMore=candidates.length>rawLimit
    const last=page.at(-1)
    return {
      account,scope:'wallet',limit:rawLimit,
      events:page.map(row=>row.event),
      nextCursor:hasMore&&last?encodeActivityCursor({at:last.at,key:last.pageKey}):null,
    }
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
        liquidityUsd: null,
        tradingEnabled: this.registry.chainId===4663 && dex!==null,
        acquisitionEnabled: this.registry.chainId===4663 && dex!==null && this.market.client.acknowledgeStockTokenEligibility,
        eligibilityAcknowledged: !!this.market.client.acknowledgeStockTokenEligibility,
        dexStatus: dex === null ? 'unavailable' : 'quoted',
        observedAt: Date.now(), probeUsdg: '10' }
      this.stocksCache.set(token.symbol, { at: Date.now(), value })
      return value
    })().finally(() => this.stocksPending.delete(token.symbol))
    this.stocksPending.set(token.symbol, request)
    return request
  }
  private async tokenSpotPrice(asset:{address:Address;decimals:number}):Promise<{price:number;source:string}|null> {
    const key=asset.address.toLowerCase(),cached=this.tokenPriceCache.get(key)
    if(cached&&Date.now()-cached.at<30_000)return cached.value
    const pending=this.tokenPricePending.get(key);if(pending)return pending
    const request=(async()=>{
      const spot=await this.market.spotPrice(asset.address,asset.decimals).catch(()=>null)
      const value=spot&&Number.isFinite(spot.priceUsd)&&spot.priceUsd>0?
        {price:spot.priceUsd,source:spot.via==='usdg'?'DEX token/USDG probe':'DEX token/WETH → USDG probe'}:null
      this.tokenPriceCache.delete(key)
      this.tokenPriceCache.set(key,{at:Date.now(),value})
      while(this.tokenPriceCache.size>400)this.tokenPriceCache.delete(this.tokenPriceCache.keys().next().value!)
      return value
    })().finally(()=>this.tokenPricePending.delete(key))
    this.tokenPricePending.set(key,request)
    return request
  }
  portfolioHistory(raw:string|null,hours=24,limit=288) {
    if (!raw || !isAddress(raw) || /^0x0{40}$/i.test(raw)) throw new HubError(400, 'INVALID_ACCOUNT', 'Enter a valid public wallet address.')
    if(!Number.isFinite(hours)||hours<1||hours>720)throw new HubError(400,'INVALID_HOURS','History hours must be between 1 and 720.')
    if(!Number.isInteger(limit)||limit<2||limit>2000)throw new HubError(400,'INVALID_LIMIT','History limit must be between 2 and 2000.')
    const account=getAddress(raw)
    const points=this.fleet.journal.portfolioSnapshots(this.registry.chainId,account,Date.now()-hours*3_600_000,limit)
    const first=points[0]??null,last=points.at(-1)??null
    const changeUsd=points.length>=2&&first&&last?last.pricedValueUsd-first.pricedValueUsd:null
    const changePct=points.length>=2&&first&&last&&first.pricedValueUsd>0?changeUsd!/first.pricedValueUsd*100:null
    return {
      account,chainId:this.registry.chainId,hours,points, observedFrom:first?.observedAt??null,observedTo:last?.observedAt??null,
      changeUsd,changePct,
      incomplete:points.some(point=>point.incomplete),
      metric:'observed-priced-value-change',
      note:'Value change is based on Hub portfolio snapshots. It is not cost basis, realized P&L, tax P&L, or proof of investment performance.',
    }
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
    const heldNonStock=assets.map((asset,i)=>({asset,i,balance:balances[i]?.status==='success'?balances[i]!.result as bigint:null}))
      .filter(x=>x.balance!==null&&x.balance>0n&&x.asset.type!=='stock-token'&&x.asset.address.toLowerCase()!==this.market.weth.toLowerCase()&&x.asset.address.toLowerCase()!==this.market.usdg.toLowerCase())
    const maxSpotProbes=24
    const spotPrices=new Map<string,{price:number;source:string}|null>()
    const misses=heldNonStock.filter(x=>{
      const key=x.asset.address.toLowerCase(),cached=this.tokenPriceCache.get(key)
      if(cached&&Date.now()-cached.at<30000){spotPrices.set(key,cached.value);return false}
      return true
    })
    const start=misses.length?this.probeCursor%misses.length:0
    const selected=[...misses.slice(start),...misses.slice(0,start)].slice(0,maxSpotProbes)
    this.probeCursor=misses.length?(start+selected.length)%misses.length:0
    for(let offset=0;offset<selected.length;offset+=4){
      const priced=await Promise.all(selected.slice(offset,offset+4).map(async x=>[x.asset.address.toLowerCase(),await this.tokenSpotPrice(x.asset)] as const))
      for(const [key,value] of priced)spotPrices.set(key,value)
    }
    for (let i=0; i<assets.length; i++) {
      const asset = assets[i]!, result = balances[i]
      const balance = result?.status === 'success' ? result.result as bigint : null
      let price:number|null = asset.address.toLowerCase() === this.market.weth.toLowerCase() ? ethPrice : asset.address.toLowerCase() === this.market.usdg.toLowerCase() ? 1 : null
      let priceSource = asset.address.toLowerCase() === this.market.weth.toLowerCase() ? 'WETH/USDG probe' : asset.address.toLowerCase() === this.market.usdg.toLowerCase() ? 'USDG valued at $1 (assumption)' : 'Unavailable'
      if (asset.type === 'stock-token' && balance !== null && balance > 0n) {
        price = (await this.market.stockChainlinkPrice(asset.symbol))?.priceUsd ?? null
        priceSource='Chainlink price per token'
      } else if(balance!==null&&balance>0n&&price===null&&asset.type!=='stock-token') {
        const spot=spotPrices.get(asset.address.toLowerCase())
        if(spot){price=spot.price;priceSource=spot.source}
        else if(!spotPrices.has(asset.address.toLowerCase()))priceSource='Valuation probe limit reached'
        else priceSource='No liquid USD route'
      }
      holdings.push({ asset, balance: balance?.toString() ?? null, priceUsd: price,
        valueUsd: balance === 0n ? 0 : balance !== null && price !== null ? Number(formatUnits(balance,asset.decimals))*price : null,
        priceSource,
        balanceStatus: balance === null ? 'unavailable' : 'read' })
    }
    const observedAt=Date.now(),pricedValueUsd=holdings.reduce((sum,h)=>sum+(h.valueUsd??0),0)
    const incomplete=holdings.some(h=>h.balance===null||(h.balance!=='0'&&h.valueUsd===null))
    this.fleet.journal.recordPortfolioSnapshot({chainId:this.registry.chainId,account,observedAt,blockNumber:blockNumber.toString(),pricedValueUsd,incomplete})
    return { account, chainId: this.registry.chainId, blockNumber: blockNumber.toString(), observedAt, holdings,
      pricedValueUsd,incomplete,
      walletPnlUsd: null, positions: this.positions(), botSummary: this.fleet.summary(),
      coverage: 'Native ETH and the Hub asset registry only. Held non-stock ERC-20s use bounded live DEX probes when available. Bot positions are separate and are not added to wallet value.' }
  }
}

function encodeActivityCursor(cursor:{at:number;key:string}):string {
  return Buffer.from(JSON.stringify(cursor),'utf8').toString('base64url')
}
function decodeActivityCursor(raw:string|null):{at:number;key:string}|undefined {
  if(raw===null||raw==='')return undefined
  if(raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw))throw new HubError(400,'INVALID_CURSOR','Activity cursor is invalid.')
  try{
    const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')) as {at?:unknown;key?:unknown}
    if(!Number.isSafeInteger(value.at)||Number(value.at)<0||typeof value.key!=='string'||value.key.length<1||value.key.length>256)throw new Error()
    return {at:Number(value.at),key:value.key}
  }catch{throw new HubError(400,'INVALID_CURSOR','Activity cursor is invalid.')}
}
