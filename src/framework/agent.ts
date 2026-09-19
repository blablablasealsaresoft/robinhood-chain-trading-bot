import { formatUnits, type Account, type Address, type Hash } from 'viem'
import { buildSwapTx, erc20Abi, type SwapQuote } from 'hoodchain'
import type { AgentStateRecord, Journal } from './journal.js'
import type { Market } from './market.js'
import { RiskEngine, utcDayStart } from './risk.js'
import type { KillSwitch } from './kill.js'
import type { Strategy } from './strategy.js'
import type {
  AgentStatus,
  Decision,
  Intent,
  Mode,
  Position,
  RiskLimits,
  TradeRecord,
} from './types.js'

/** Everything an {@link Agent} is constructed with. */
export interface AgentOptions {
  id: string
  strategy: Strategy
  market: Market
  limits: RiskLimits
  journal: Journal
  kill: KillSwitch
  mode: Mode
  /** Account for live execution; null in paper mode. */
  account: Account | null
  fleetMaxDailySpendUsdg: number
  /** Fleet-wide spend accessor + reporter, so the agent respects the global cap. */
  fleetSpentTodayUsd: () => number
  reportFleetSpend: (usd: number) => void
  /** Milliseconds between decision ticks. */
  tickIntervalMs: number
  /** Injected clock, for tests. Defaults to `Date.now`. */
  clock?: () => number
  stateScope?: string
  restoreFleetSpend?: boolean
}

const DUST = 1_000n // token smallest-units below which a position is considered closed

/**
 * An autonomous trading agent = strategy + wallet + risk budget + journal.
 *
 * Each tick runs the full pipeline: observe (the strategy reads the {@link
 * Market}) → decide (the strategy returns intents) → simulate (a real QuoterV2
 * `eth_call`) → risk-check (the {@link RiskEngine}, fail-closed) → execute
 * (paper: record the simulated fill; live: sign the swap) → journal (every
 * decision, refusal, trade, and equity mark). The strategy proposes; the agent
 * disposes, and never lets an intent skip the risk gate.
 */
export class Agent {
  readonly id: string
  readonly strategy: Strategy
  readonly mode: Mode
  private readonly market: Market
  private readonly risk: RiskEngine
  private readonly journal: Journal
  private readonly kill: KillSwitch
  private readonly account: Account | null
  private readonly opts: AgentOptions
  private readonly clock: () => number

  private readonly positions = new Map<string, Position>()
  private lastTradeAt: number | null = null
  private realizedUsd = 0
  private spentTodayUsd = 0
  private spentDay = 0
  private ticks = 0
  private trades = 0
  private refusals = 0
  private lastTickAt: number | null = null
  private lastError: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private ticking = false

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.id = opts.id
    this.strategy = opts.strategy
    this.mode = opts.mode
    this.market = opts.market
    this.risk = new RiskEngine(opts.limits)
    this.journal = opts.journal
    this.kill = opts.kill
    this.account = opts.account
    this.clock = opts.clock ?? Date.now
    this.restoreState()
  }

  /** Begin the tick loop and wire the strategy's stream subscriptions. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const log = (message: string, meta: Record<string, unknown> = {}) =>
      this.journal.recordDecision({ agentId: this.id, ts: this.clock(), kind: 'observe', detail: message, meta })
    await this.strategy.start?.({ market: this.market, log })
    this.kill.onKill((reason) => log(`kill switch tripped: ${reason} — halting new orders`))
    this.scheduleTick()
  }

  /** Stop the loop and the strategy's subscriptions. */
  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.strategy.stop?.()
  }

  private scheduleTick(): void {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      await this.tick()
      this.scheduleTick()
    }, this.opts.tickIntervalMs)
    this.timer.unref?.()
  }

  /** Run one full pipeline pass. Safe to call directly (used by tests). */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const now = this.clock()
    try {
      this.rolloverDay(now)
      await this.markPositions(now)

      if (this.kill.isKilled()) {
        // Halted: still mark equity so the curve shows the freeze, but propose nothing.
        this.recordEquity(now)
        this.ticks++
        this.lastTickAt = now
        this.persistState(now)
        return
      }

      const decision = await this.decide(now)
      for (const alert of decision.alerts) {
        this.journal.recordDecision({
          agentId: this.id,
          ts: now,
          kind: 'alert',
          detail: `[${alert.level}] ${alert.message}`,
          meta: alert.meta ?? {},
        })
      }
      for (const intent of decision.intents) {
        await this.processIntent(intent, now)
      }

      this.recordEquity(now)
      this.ticks++
      this.lastTickAt = now
      this.lastError = null
      this.persistState(now)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.journal.recordDecision({
        agentId: this.id,
        ts: now,
        kind: 'observe',
        detail: `tick error: ${this.lastError}`,
        meta: {},
      })
    } finally {
      this.ticking = false
    }
  }

  private async decide(now: number): Promise<Decision> {
    const { quoteToken, quoteSymbol, quoteDecimals } = this.quoteInfo()
    return this.strategy.tick({
      market: this.market,
      positions: [...this.positions.values()],
      now,
      quoteToken,
      quoteSymbol,
      quoteDecimals,
      log: (message, meta = {}) =>
        this.journal.recordDecision({ agentId: this.id, ts: now, kind: 'observe', detail: message, meta }),
    })
  }

  private quoteInfo(): { quoteToken: Address; quoteSymbol: string; quoteDecimals: number } {
    if (this.strategy.quote === 'weth') {
      return { quoteToken: this.market.weth, quoteSymbol: 'WETH', quoteDecimals: 18 }
    }
    return { quoteToken: this.market.usdg, quoteSymbol: 'USDG', quoteDecimals: this.market.usdgDecimals }
  }

  private async processIntent(intent: Intent, now: number): Promise<void> {
    const refuse = (reason: string, detail: string, meta: Record<string, unknown> = {}) => {
      this.refusals++
      this.journal.recordDecision({
        agentId: this.id,
        ts: now,
        kind: 'refused',
        detail: `${intent.side} ${intent.tokenSymbol}: ${detail}`,
        meta: { reason, intentReason: intent.reason, ...meta },
      })
    }

    const quoteToken = intent.quoteToken
    const quoteDecimals = intent.quoteSymbol === 'USDG' ? this.market.usdgDecimals : 18

    // ── simulate (real eth_call against live pools) ────────────────────────────
    let sim: SwapQuote | null
    if (intent.side === 'buy') {
      sim = await this.market.quoteBuy(quoteToken, intent.token, intent.amountIn)
    } else {
      sim = await this.market.quoteSell(intent.token, quoteToken, intent.amountIn)
    }
    if (!sim || sim.amountOut <= 0n) {
      refuse('no_route', 'no liquid route to simulate the fill')
      return
    }

    // ── notional in USD ────────────────────────────────────────────────────────
    const ethUsd = intent.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
    if (ethUsd === null) {
      refuse('no_route', 'cannot price ETH to enforce USD caps')
      return
    }
    let notionalUsd: number
    if (intent.side === 'buy') {
      notionalUsd = Number(formatUnits(intent.amountIn, quoteDecimals)) * ethUsd
    } else {
      notionalUsd = Number(formatUnits(sim.amountOut, quoteDecimals)) * ethUsd
    }

    // ── position accounting for the cap ────────────────────────────────────────
    const existing = this.positions.get(intent.token.toLowerCase())
    if (intent.side === 'sell') {
      if (!existing || existing.amount < intent.amountIn - DUST) {
        refuse('insufficient_balance', 'position too small to sell requested amount')
        return
      }
    }
    const positionUsdAfter = intent.side === 'buy' ? (existing?.investedUsd ?? 0) + notionalUsd : 0

    // ── slippage bound ─────────────────────────────────────────────────────────
    const slippageBps = Math.min(intent.maxSlippageBps ?? this.risk.riskLimits.maxSlippageBps, 10_000)
    const minOut = (sim.amountOut * BigInt(10_000 - slippageBps)) / 10_000n

    // ── risk gate (fail closed) ────────────────────────────────────────────────
    const verdict = this.risk.check({
      side: intent.side,
      notionalUsd,
      positionUsdAfter,
      spentTodayUsd: this.spentTodayUsd,
      fleetSpentTodayUsd: this.opts.fleetSpentTodayUsd(),
      lastTradeAt: this.lastTradeAt,
      slippageBps,
      killed: this.kill.isKilled(),
      now,
      fleetMaxDailySpendUsdg: this.opts.fleetMaxDailySpendUsdg,
    })
    if (!verdict.ok) {
      refuse(verdict.reason ?? 'refused', verdict.detail, { notionalUsd: round(notionalUsd) })
      return
    }

    // ── execute ────────────────────────────────────────────────────────────────
    let txHash: Hash | null = null
    let amountOut = sim.amountOut
    if (this.mode === 'live') {
      const executed = await this.executeLive(intent, sim, slippageBps)
      if (!executed) {
        refuse('no_route', 'live execution failed (see logs)')
        return
      }
      txHash = executed.hash
      amountOut = executed.amountOutMinimum // conservative floor actually received ≥ this
    }

    // ── journal + book-keeping ──────────────────────────────────────────────────
    const trade: TradeRecord = {
      agentId: this.id,
      mode: this.mode,
      ts: now,
      side: intent.side,
      token: intent.token,
      tokenSymbol: intent.tokenSymbol,
      quoteToken,
      quoteSymbol: intent.quoteSymbol,
      amountIn: intent.amountIn,
      amountOut,
      txHash,
      reason: intent.reason,
      slippageBps,
      gasEstimate: sim.gasEstimate,
      meta: { ...(intent.meta ?? {}), notionalUsd: round(notionalUsd), minOut: minOut.toString() },
    }
    const tradeId=this.journal.recordTrade(trade)
    this.lastTradeId=tradeId
    this.trades++
    this.lastTradeAt = now
    this.applyFill(intent, amountOut, notionalUsd, now)
    if (intent.side === 'buy') {
      this.spentTodayUsd += notionalUsd
      this.opts.reportFleetSpend(notionalUsd)
    }
    if(this.mode==='live')this.pendingLive=undefined
    this.persistState(now)
  }

  private async executeLive(
    intent: Intent,
    sim: SwapQuote,
    slippageBps: number,
  ): Promise<{ hash: Hash; amountOutMinimum: bigint } | null> {
    if (!this.account || !this.market.client.wallet) return null
    if(this.pendingLive)throw new Error('Live execution is unresolved and requires operator reconciliation before another transaction.')
    try {
      const tx = buildSwapTx(this.market.client, sim, { slippageBps })
      const inputToken=intent.side === 'buy' ? intent.quoteToken : intent.token
      const router=this.market.addresses().router
      const allowance=await this.market.client.public.readContract({address:inputToken,abi:erc20Abi,functionName:'allowance',args:[this.account.address,router]})
      if(allowance<intent.amountIn){
        this.lastError='Live automation requires a pre-approved router allowance; it never broadcasts approval transactions.'
        return null
      }
      const nonce=await this.market.client.public.getTransactionCount({address:this.account.address,blockTag:'pending'})
      this.pendingLive={phase:'prepared',nonce,at:this.clock()}
      this.persistState()
      const hash = await this.market.client.wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce,
        account: this.account,
        chain: this.market.client.chain,
      })
      this.pendingLive={phase:'submitted',nonce,hash,at:this.pendingLive.at}
      this.persistState()
      const receipt=await this.market.client.public.waitForTransactionReceipt({ hash })
      if(receipt.status!=='success'){
        this.lastError='Live swap reverted: '+hash
        return null
      }
      return { hash, amountOutMinimum: tx.amountOutMinimum }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  private applyFill(intent: Intent, amountOut: bigint, notionalUsd: number, now: number): void {
    const key = intent.token.toLowerCase()
    const existing = this.positions.get(key)
    if (intent.side === 'buy') {
      if (existing) {
        existing.amount += amountOut
        existing.costBasis += intent.amountIn
        existing.investedUsd += notionalUsd
      } else {
        this.positions.set(key, {
          token: intent.token,
          tokenSymbol: intent.tokenSymbol,
          amount: amountOut,
          costBasis: intent.amountIn,
          investedUsd: notionalUsd,
          quoteToken: intent.quoteToken,
          quoteSymbol: intent.quoteSymbol,
          openedAt: now,
          markUsd: null,
          meta: intent.meta ?? {},
        })
      }
      return
    }
    // sell: realize PnL on the sold fraction
    if (!existing) return
    const sellAmount = intent.amountIn > existing.amount ? existing.amount : intent.amountIn
    // fraction as a float only touches investedUsd (already a float, USD-scale — safe);
    // costBasis stays bigint-only arithmetic so large token-unit positions (amounts near
    // or past 2^53) don't lose precision through a Number() round-trip.
    const fraction = existing.amount > 0n ? Number(sellAmount) / Number(existing.amount) : 1
    const costFractionUsd = existing.investedUsd * fraction
    const costBasisSold = existing.amount > 0n ? (existing.costBasis * sellAmount) / existing.amount : existing.costBasis
    this.realizedUsd += notionalUsd - costFractionUsd
    existing.amount -= sellAmount
    existing.costBasis -= costBasisSold
    existing.investedUsd -= costFractionUsd
    if (existing.amount <= DUST) this.positions.delete(key)
  }

  /** Mark every open position to its live exit value (a real sell-side quote). */
  private async markPositions(now: number): Promise<void> {
    for (const pos of this.positions.values()) {
      const q = await this.market.quoteSell(pos.token, pos.quoteToken, pos.amount)
      if (!q) {
        pos.markUsd = null
        continue
      }
      const quoteDecimals = pos.quoteSymbol === 'USDG' ? this.market.usdgDecimals : 18
      const ethUsd = pos.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
      if (ethUsd === null) {
        pos.markUsd = null
        continue
      }
      pos.markUsd = Number(formatUnits(q.amountOut, quoteDecimals)) * ethUsd
    }
  }

  private openValueUsd(): number {
    let sum = 0
    for (const pos of this.positions.values()) sum += pos.markUsd ?? pos.investedUsd
    return sum
  }

  private recordEquity(now: number): void {
    const openValueUsd = this.openValueUsd()
    this.journal.recordEquity({
      agentId: this.id,
      ts: now,
      realizedUsd: round(this.realizedUsd),
      openValueUsd: round(openValueUsd),
      equityUsd: round(this.realizedUsd + openValueUsd),
    })
  }

  private rolloverDay(now: number): void {
    const day = utcDayStart(now)
    if (day !== this.spentDay) {
      this.spentDay = day
      this.spentTodayUsd = 0
    }
  }

  private lastTradeId=0
  private pendingLive:{phase:'prepared'|'submitted';nonce:number;hash?:string;at:number}|undefined
  private get stateScope():string { return this.opts.stateScope ?? this.mode+":"+this.market.usdg.toLowerCase() }

  private restoreState():void {
    const saved=this.journal.agentState(this.id)
    const latestId=this.journal.latestTradeId(this.id,this.mode)
    const label=this.mode+' agent'
    if(!saved) {
      if(latestId>0)throw new Error('Persisted '+label+' state is missing for '+this.id+'; existing trades require reconciliation.')
      return
    }
    if(saved.version!==1||saved.mode!==this.mode||saved.agentId!==this.id||saved.strategyId!==this.strategy.id)throw new Error('Persisted '+label+' state is incompatible for '+this.id)
    if(saved.lastTradeId!==latestId)throw new Error('Persisted '+label+' state is stale for '+this.id)
    if(saved.stateScope!==this.stateScope)throw new Error('Persisted '+label+' state scope is incompatible for '+this.id)
    if(saved.pendingLive&&this.mode==='live')throw new Error('Persisted live execution is unresolved for '+this.id+'; reconcile nonce '+saved.pendingLive.nonce+(saved.pendingLive.hash?' / '+saved.pendingLive.hash:'')+' before restart.')
    if(saved.pendingLive&&this.mode!=='live')throw new Error('Persisted paper state contains live execution metadata for '+this.id)
    if(!Number.isSafeInteger(saved.updatedAt)||saved.updatedAt<0||!Array.isArray(saved.positions)||
      !(saved.lastTradeAt===null||Number.isSafeInteger(saved.lastTradeAt)&&saved.lastTradeAt>=0)||
      !(saved.lastTickAt===null||Number.isSafeInteger(saved.lastTickAt)&&saved.lastTickAt>=0))throw new Error('Persisted '+label+' state is invalid for '+this.id)
    this.lastTradeId=latestId
    if(!Number.isFinite(saved.realizedUsd)||!Number.isFinite(saved.spentTodayUsd)||saved.spentTodayUsd<0||!Number.isInteger(saved.spentDay)||
      !Number.isInteger(saved.ticks)||saved.ticks<0||!Number.isInteger(saved.trades)||saved.trades<0||!Number.isInteger(saved.refusals)||saved.refusals<0)throw new Error('Persisted '+label+' state is invalid for '+this.id)
    const now=this.clock(),today=utcDayStart(now)
    this.realizedUsd=saved.realizedUsd
    this.lastTradeAt=saved.lastTradeAt
    this.ticks=saved.ticks
    this.trades=saved.trades
    this.refusals=saved.refusals
    this.lastTickAt=saved.lastTickAt
    this.spentDay=today
    this.spentTodayUsd=saved.spentDay===today?saved.spentTodayUsd:0
    this.positions.clear()
    for(const raw of saved.positions){
      if(!/^0x[0-9a-fA-F]{40}$/.test(raw.token)||!/^0x[0-9a-fA-F]{40}$/.test(raw.quoteToken)||!/^\d+$/.test(raw.amount)||!/^\d+$/.test(raw.costBasis)||
        !Number.isFinite(raw.investedUsd)||raw.investedUsd<0||!Number.isInteger(raw.openedAt)||raw.openedAt<0||
        !(raw.markUsd===null||Number.isFinite(raw.markUsd)))throw new Error('Persisted '+label+' position is invalid for '+this.id)
      const position:Position={
        token:raw.token as Address,tokenSymbol:raw.tokenSymbol,amount:BigInt(raw.amount),costBasis:BigInt(raw.costBasis),
        investedUsd:raw.investedUsd,quoteToken:raw.quoteToken as Address,quoteSymbol:raw.quoteSymbol,
        openedAt:raw.openedAt,markUsd:raw.markUsd,meta:raw.meta??{},
      }
      if(this.positions.has(position.token.toLowerCase()))throw new Error('Duplicate persisted '+label+' position for '+this.id)
      if(position.amount>DUST)this.positions.set(position.token.toLowerCase(),position)
    }
    if(this.spentTodayUsd>0&&this.opts.restoreFleetSpend!==false)this.opts.reportFleetSpend(this.spentTodayUsd)
  }

  private persistState(now=this.clock()):void {
    const state:AgentStateRecord={
      version:1,agentId:this.id,strategyId:this.strategy.id,mode:this.mode,updatedAt:now,lastTradeId:this.lastTradeId,stateScope:this.stateScope,
      spentDay:this.spentDay,spentTodayUsd:round(this.spentTodayUsd),lastTradeAt:this.lastTradeAt,realizedUsd:round(this.realizedUsd),
      ticks:this.ticks,trades:this.trades,refusals:this.refusals,lastTickAt:this.lastTickAt,
      ...(this.pendingLive?{pendingLive:{...this.pendingLive}}:{}),
      positions:[...this.positions.values()].map(p=>({
        token:p.token,tokenSymbol:p.tokenSymbol,amount:p.amount.toString(),costBasis:p.costBasis.toString(),
        investedUsd:p.investedUsd,quoteToken:p.quoteToken,quoteSymbol:p.quoteSymbol,openedAt:p.openedAt,
        markUsd:p.markUsd,meta:p.meta,
      })),
    }
    this.journal.recordAgentState(state)
  }

  /** Live status snapshot for the dashboard API. */
  status(): AgentStatus {
    const openValueUsd = this.openValueUsd()
    return {
      id: this.id,
      strategy: this.strategy.id,
      mode: this.mode,
      running: this.running,
      killed: this.kill.isKilled(),
      limits: this.risk.riskLimits,
      spentTodayUsd: round(this.spentTodayUsd),
      realizedUsd: round(this.realizedUsd),
      openValueUsd: round(openValueUsd),
      equityUsd: round(this.realizedUsd + openValueUsd),
      positions: [...this.positions.values()],
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      ticks: this.ticks,
      trades: this.trades,
      refusals: this.refusals,
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
