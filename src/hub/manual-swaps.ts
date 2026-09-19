import { randomUUID } from 'node:crypto'
import { buildSwapTx, erc20Abi, type SwapQuote } from 'hoodchain'
import { encodeFunctionData, formatUnits, getAddress, isAddress, zeroAddress, type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import { AssetRegistry, type ReviewedTradeAsset } from './assets.js'
import type { HubQuote, PreparedSwap } from './types.js'
import { StockComplianceError,type StockCompliancePolicy } from './stock-compliance.js'

export class HubError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export interface ManualSwapOptions {
  chainId: number; maxSlippageBps: number; isKilled: () => boolean
  journal: Pick<Journal, 'recordDecision'> & Partial<Pick<Journal, 'recordWalletPlan'>>; clock?: () => number
  reviewedAssets?: ReviewedTradeAsset[]
  stockCompliance?: StockCompliancePolicy
}
type QuoteEntry = { response: HubQuote; quote: SwapQuote }
const UINT256_MAX = (1n << 256n) - 1n
const QUOTE_TTL = 30_000
const STOCK_REFERENCE_MAX_AGE_SECONDS = 72 * 60 * 60
const STOCK_MAX_DEVIATION_BPS = 1500
export class ManualSwapService {
  readonly registry: AssetRegistry
  private readonly quotes = new Map<string, QuoteEntry>()
  private readonly clock: () => number
  constructor(private readonly market: Market, private readonly options: ManualSwapOptions) {
    if (market.client.wallet || market.client.account) throw new Error('ManualSwapService requires a Market without an account or wallet')
    if (![4663, 46630].includes(options.chainId)) throw new Error('Unsupported Hub chain')
    if (!Number.isInteger(options.maxSlippageBps) || options.maxSlippageBps < 0 || options.maxSlippageBps >= 10000) throw new Error('Invalid manual slippage cap')
    this.registry = new AssetRegistry(options.chainId, market)
    for(const asset of options.reviewedAssets??[])this.registry.registerReviewed(asset)
    this.clock = options.clock ?? Date.now
  }
  private guard(): void {
    if (this.options.isKilled()) throw new HubError(409, 'KILLED', 'The Hub kill switch is active. No new swap plans are available.')
  }
  private async network(): Promise<void> {
    if (await this.market.client.public.getChainId() !== this.options.chainId) throw new HubError(409, 'CHAIN_MISMATCH', 'The RPC is not on the configured chain.')
  }
  private async verifyReviewedAsset(asset:HubQuote['tokenIn']):Promise<void> {
    if(asset.source!=='operator-reviewed')return
    let decimals:unknown
    try { decimals=await this.market.client.public.readContract({address:asset.address,abi:erc20Abi,functionName:'decimals'}) }
    catch { throw new HubError(422,'ASSET_METADATA_UNVERIFIED','The reviewed token metadata could not be verified onchain.') }
    if(Number(decimals)!==asset.decimals)throw new HubError(409,'ASSET_METADATA_MISMATCH','The reviewed token decimals do not match the onchain contract.')
  }
  async quote(input: Record<string, unknown>): Promise<HubQuote> {
    exactFields(input, ['chainId', 'tokenIn', 'tokenOut', 'amountIn', 'account', 'slippageBps'])
    this.guard()
    if (String(input.chainId) !== String(this.options.chainId)) throw new HubError(409, 'CHAIN_MISMATCH', 'Choose the configured Robinhood Chain network.')
    const account = address(input.account, 'account')
    const tokenIn = this.registry.get(address(input.tokenIn, 'tokenIn'))
    const tokenOut = this.registry.get(address(input.tokenOut, 'tokenOut'))
    if (!tokenIn || !tokenOut) throw new HubError(403, 'ASSET_NOT_ENABLED', 'This asset is not available for manual trading.')
    const stockIn=tokenIn.type==='stock-token',stockOut=tokenOut.type==='stock-token'
    if ((!stockIn && !tokenIn.tradable) || (!stockOut && !tokenOut.tradable)) throw new HubError(403, 'ASSET_NOT_ENABLED', 'This asset is not in the manual trading allowlist.')
    if(stockIn&&stockOut)throw new HubError(422,'STOCK_PAIR_UNSUPPORTED','Stock Token to Stock Token swaps are not enabled.')
    if(stockOut){
      if(!this.market.client.acknowledgeStockTokenEligibility)throw new HubError(403,'STOCK_ELIGIBILITY_REQUIRED','Stock Token acquisition requires the operator eligibility acknowledgement.')
      if(!this.options.stockCompliance)throw new HubError(403,'STOCK_COMPLIANCE_REQUIRED','Wallet-scoped Stock Token compliance is not configured.')
      try{this.options.stockCompliance.requireAcquisition(account)}catch(error){throw stockPolicyError(error)}
    }
    if(stockIn||stockOut){
      if(this.options.chainId!==4663)throw new HubError(422,'STOCK_NETWORK','Stock Token manual trading is enabled only on Robinhood Chain mainnet.')
      const quoteAsset=stockIn?tokenOut:tokenIn
      if(quoteAsset.address.toLowerCase()!==this.market.usdg.toLowerCase()&&quoteAsset.address.toLowerCase()!==this.market.weth.toLowerCase())
        throw new HubError(422,'STOCK_QUOTE_ASSET','Stock Token manual trades must use USDG or WETH as the other asset.')
    }
    if (tokenIn.id === tokenOut.id) throw new HubError(400, 'SAME_ASSET', 'Choose two different assets.')
    if (typeof input.amountIn !== 'string' || !/^[1-9]\d{0,77}$/.test(input.amountIn) || BigInt(input.amountIn) > UINT256_MAX) throw new HubError(400, 'INVALID_AMOUNT', 'amountIn must be a positive uint256 base-unit string.')
    const rawSlippage = input.slippageBps ?? String(Math.min(50, this.options.maxSlippageBps))
    if (!/^(0|[1-9]\d{0,3})$/.test(String(rawSlippage))) throw new HubError(400, 'INVALID_SLIPPAGE', 'Slippage must be an integer number of basis points.')
    const slippageBps = Number(rawSlippage)
    if (slippageBps > this.options.maxSlippageBps) throw new HubError(400, 'SLIPPAGE_CAP', 'Slippage exceeds the configured ' + this.options.maxSlippageBps + ' bps cap.')
    await this.network()
    await Promise.all([this.verifyReviewedAsset(tokenIn),this.verifyReviewedAsset(tokenOut)])
    let stockReference:Awaited<ReturnType<Market['stockChainlinkPrice']>>=null
    let stockPolicy:Awaited<ReturnType<StockCompliancePolicy['verifyAsset']>>|undefined
    if(stockIn||stockOut){
      const stock=stockIn?tokenIn:tokenOut
      if(!this.options.stockCompliance)throw new HubError(503,'STOCK_COMPLIANCE_UNAVAILABLE','Stock Token market-policy verification is not configured.')
      try{stockPolicy=await this.options.stockCompliance.verifyAsset(stock.symbol,stock.address,stockOut?'acquire':'dispose')}catch(error){throw stockPolicyError(error)}
      stockReference=await this.market.stockChainlinkPrice(stock.symbol,STOCK_REFERENCE_MAX_AGE_SECONDS)
      if(!stockReference||!Number.isFinite(stockReference.priceUsd)||stockReference.priceUsd<=0)throw new HubError(422,'STOCK_REFERENCE_UNAVAILABLE','A fresh Stock Token reference price is unavailable.')
    }
    this.guard()
    const quote = await this.market.quoteBuy(tokenIn.address, tokenOut.address, BigInt(input.amountIn))
    this.guard()
    if (!quote || quote.amountOut <= 0n) throw new HubError(422, 'NO_ROUTE', 'No liquid route is available for this pair and amount.')
    if (quote.amountIn !== BigInt(input.amountIn) || quote.route.path[0]?.toLowerCase() !== tokenIn.address.toLowerCase() || quote.route.path.at(-1)?.toLowerCase() !== tokenOut.address.toLowerCase()) throw new HubError(503, 'INVALID_PROVIDER_QUOTE', 'The provider returned an inconsistent quote.')
    let stockSafety:HubQuote['stockSafety']
    if(stockReference){
      const stock=stockIn?tokenIn:tokenOut
      const quoteAsset=stockIn?tokenOut:tokenIn
      const stockTokens=stockIn?Number(formatUnits(quote.amountIn,stock.decimals)):Number(formatUnits(quote.amountOut,stock.decimals))
      let quoteUsd:number|null=null
      if(quoteAsset.address.toLowerCase()===this.market.usdg.toLowerCase()){
        const raw=stockIn?quote.amountOut:quote.amountIn
        quoteUsd=Number(formatUnits(raw,this.market.usdgDecimals))
      }else{
        const eth=await this.market.ethUsd(30_000,this.clock())
        if(eth!==null){
          const raw=stockIn?quote.amountOut:quote.amountIn
          quoteUsd=Number(formatUnits(raw,18))*eth
        }
      }
      if(!quoteUsd||!Number.isFinite(quoteUsd)||quoteUsd<=0||!Number.isFinite(stockTokens)||stockTokens<=0)
        throw new HubError(422,'STOCK_EXECUTION_UNVERIFIED','The Stock Token execution price could not be verified.')
      const executionPriceUsd=quoteUsd/stockTokens
      const deviationBps=Math.round(Math.abs(executionPriceUsd/stockReference.priceUsd-1)*10000)
      if(!Number.isFinite(deviationBps)||deviationBps>STOCK_MAX_DEVIATION_BPS)
        throw new HubError(422,'STOCK_PRICE_DEVIATION','The DEX execution price differs too far from the Stock Token reference price.')
      stockSafety={symbol:stock.symbol,referencePriceUsd:stockReference.priceUsd,referenceUpdatedAt:stockReference.updatedAt*1000,executionPriceUsd,deviationBps,maxDeviationBps:STOCK_MAX_DEVIATION_BPS,maxReferenceAgeSeconds:STOCK_REFERENCE_MAX_AGE_SECONDS,acquisitionEligibilityRequired:stockOut,
        rhjAssetStatus:stockPolicy!.assetStatus,rhjFractionalTradability:stockPolicy!.fractionalTradability,rhjAllDayTradability:stockPolicy!.allDayTradability,rhjTradingHalt:stockPolicy!.isTradingHalt,rhjCheckedAt:stockPolicy!.checkedAt}
    }
    const minimum = quote.amountOut * BigInt(10000 - slippageBps) / 10000n
    if (minimum === 0n) throw new HubError(422, 'AMOUNT_TOO_SMALL', 'The quoted output is too small to enforce a positive minimum.')
    let estimatedNetworkFeeWei: string | null = null
    try { estimatedNetworkFeeWei = (quote.gasEstimate * await this.market.client.public.getGasPrice()).toString() } catch { /* Unknown fee is not zero. */ }
    this.guard()
    const now = this.clock()
    for (const [id, entry] of this.quotes) if (entry.response.expiresAt <= now) this.quotes.delete(id)
    if (this.quotes.size >= 1000) throw new HubError(503, 'QUOTE_CAPACITY', 'Quote capacity reached. Try again shortly.')
    const response: HubQuote = {
      quoteId: randomUUID(), chainId: this.options.chainId, account, tokenIn, tokenOut,
      amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), minimumReceived: minimum.toString(),
      slippageBps, gasEstimate: quote.gasEstimate.toString(), estimatedNetworkFeeWei, priceImpactBps: null,
      source: 'hoodchain/uniswap-v3', route: { path: [...quote.route.path], fees: [...quote.route.fees] }, createdAt: now, expiresAt: now + QUOTE_TTL, ...(stockSafety?{stockSafety}:{}),
    }
    this.quotes.set(response.quoteId, { response, quote })
    return structuredClone(response)
  }
  async prepare(input: Record<string, unknown>): Promise<PreparedSwap> {
    exactFields(input, ['quoteId', 'account'])
    this.guard()
    if (typeof input.quoteId !== 'string' || input.quoteId.length > 64) throw new HubError(400, 'INVALID_QUOTE_ID', 'Supply a server-issued quoteId.')
    const entry = this.quotes.get(input.quoteId)
    if (!entry) throw new HubError(404, 'QUOTE_NOT_FOUND', 'Quote not found. Request a fresh quote.')
    const { response, quote } = entry
    const valid = () => {
      this.guard()
      if (this.clock() >= response.expiresAt) throw new HubError(410, 'QUOTE_EXPIRED', 'Quote expired. Review a fresh quote before signing.')
    }
    valid()
    const account = address(input.account, 'account')
    if (account !== response.account) throw new HubError(409, 'ACCOUNT_MISMATCH', 'The wallet differs from the quoted account. Request a fresh quote.')
    await this.network()
    if(response.stockSafety){
      const stock=response.tokenIn.type==='stock-token'?response.tokenIn:response.tokenOut
      const acquiring=response.tokenOut.type==='stock-token'
      if(!this.options.stockCompliance)throw new HubError(503,'STOCK_COMPLIANCE_UNAVAILABLE','Stock Token market-policy verification is not configured.')
      if(acquiring){try{this.options.stockCompliance.requireAcquisition(account)}catch(error){throw stockPolicyError(error)}}
      try{await this.options.stockCompliance.verifyAsset(response.stockSafety.symbol,stock.address,acquiring?'acquire':'dispose',true)}catch(error){throw stockPolicyError(error)}
      const current=await this.market.stockChainlinkPrice(response.stockSafety.symbol,response.stockSafety.maxReferenceAgeSeconds)
      if(!current)throw new HubError(422,'STOCK_REFERENCE_UNAVAILABLE','A fresh Stock Token reference price is no longer available. Request a new quote.')
    }
    valid()
    const router = this.market.addresses().router
    const [balance, allowance] = await Promise.all([
      this.market.client.public.readContract({ address: response.tokenIn.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      this.market.client.public.readContract({ address: response.tokenIn.address, abi: erc20Abi, functionName: 'allowance', args: [account, router] }),
    ])
    valid()
    if (balance < quote.amountIn) throw new HubError(422, 'INSUFFICIENT_BALANCE', 'The wallet does not hold enough of the input token.')
    const tx = buildSwapTx(this.market.client, quote, { recipient: account, slippageBps: response.slippageBps, deadlineSeconds: Math.max(1, Math.floor((response.expiresAt - this.clock()) / 1000)) })
    if (tx.to.toLowerCase() !== router.toLowerCase() || tx.value !== 0n || tx.amountOutMinimum.toString() !== response.minimumReceived) throw new HubError(503, 'INVALID_TRANSACTION', 'The SDK transaction does not match the reviewed terms.')
    const approvals: PreparedSwap['approvals'] = []
    if (allowance < quote.amountIn) {
      for (const amount of allowance > 0n ? [0n, quote.amountIn] : [quote.amountIn]) approvals.push({
        to: response.tokenIn.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, amount] }), value: '0', amount: amount.toString(), spender: router,
      })
    } else {
      try { await this.market.client.public.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value }) }
      catch { throw new HubError(422, 'SIMULATION_FAILED', 'Swap simulation failed. Refresh your quote and check wallet funds and token restrictions.') }
    }
    valid()

    const planId=randomUUID()
    this.options.journal.recordWalletPlan?.({id:planId,chainId:response.chainId,account,createdAt:this.clock(),expiresAt:response.expiresAt,
      actions:[...approvals.map(a=>({kind:'approval' as const,to:a.to,data:a.data,value:a.value})),{kind:'swap',to:tx.to,data:tx.data,value:tx.value.toString()}]})

    this.options.journal.recordDecision({ agentId: 'hub:manual', ts: this.clock(), kind: 'observe', detail: 'Manual wallet transaction plan prepared; nothing signed or broadcast', meta: { quoteId: response.quoteId, chainId: response.chainId, owner: account, tokenIn: response.tokenIn.address, tokenOut: response.tokenOut.address, amountIn: response.amountIn, minimumReceived: response.minimumReceived } })
    return {
      kind: 'wallet-transaction-plan', signing: 'user-wallet', planId, chainId: response.chainId, quoteId: response.quoteId, account,
      expiresAt: response.expiresAt, minimumReceived: response.minimumReceived, deadline: tx.deadline.toString(), approvals,
      transaction: { to: tx.to, data: tx.data, value: tx.value.toString() },
      simulation: approvals.length ? 'requires-approval' : 'passed', reQuoteAfterApproval: approvals.length > 0,
    }
  }
}
function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new HubError(400, 'INVALID_ADDRESS', field + ' must be a valid nonzero EVM address.')
  return getAddress(value)
}
function exactFields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Request contains unsupported fields.')
}

function stockPolicyError(error:unknown):HubError {
  if(error instanceof StockComplianceError){
    const temporary=new Set(['STOCK_ASSET_INACTIVE','STOCK_OPENING_UNAVAILABLE','STOCK_CLOSING_UNAVAILABLE','STOCK_TRADING_HALTED'])
    const upstream=error.code.includes('UPSTREAM')||error.code.includes('UNAVAILABLE')||error.code.includes('STALE')
    return new HubError(upstream?503:temporary.has(error.code)?409:403,error.code,error.message)
  }
  return new HubError(503,'STOCK_COMPLIANCE_UNAVAILABLE','Stock Token compliance checks could not be completed.')
}
