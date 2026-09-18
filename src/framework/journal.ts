import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DecisionRecord, EquityPoint, TradeRecord } from './types.js'

/**
 * The decision journal — the agent's black box recorder. Every observe, every
 * refusal, every trade (paper or live), and every equity mark lands here so the
 * dashboard can answer "why did this trade fire?" and the whole run is auditable
 * after the fact.
 *
 * SQLite via better-sqlite3 (synchronous, zero-config, embedded). bigints are
 * stored as decimal TEXT — SQLite integers are 64-bit signed and token amounts
 * routinely exceed that, so TEXT is the only lossless option.
 */

export interface WalletPlanRecord {
  id: string; chainId: number; account: string; createdAt: number; expiresAt: number
  actions: { kind: 'approval'|'swap'|'wrap'|'unwrap'; to: string; data: string; value: string }[]
}
export interface WalletActivityRecord {
  planId: string; chainId: number; account: string; txHash: string
  kind: WalletPlanRecord['actions'][number]['kind']
  status: 'submitted'|'confirming'|'confirmed'|'reverted'|'unverified'
  at: number; observedAt: number; blockNumber: string|null; blockHash: string|null
}


export interface ExternalEventRecord {
  id:string; type:'bridge'|'launch'; source:string; chainId:number; txHash:string
  owner:string|null; at:number; observedAt:number; status:string
  verification:'unverified'|'provider'|'provider-and-receipt'|'chain-event'
  title:string; detail:string; data:Record<string,unknown>
}

export class Journal {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`


      CREATE TABLE IF NOT EXISTS external_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, chain_id INTEGER NOT NULL, status TEXT NOT NULL,
        observed_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_external_due ON external_events(type,next_check_at);

      CREATE TABLE IF NOT EXISTS wallet_plans (
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_activity (
        chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, plan_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(chain_id, tx_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_activity_observed ON wallet_activity(observed_at);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        token TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        quote_token TEXT NOT NULL,
        quote_symbol TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount_out TEXT NOT NULL,
        tx_hash TEXT,
        reason TEXT NOT NULL,
        slippage_bps INTEGER NOT NULL,
        gas_estimate TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_agent_ts ON trades(agent_id, ts);

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_agent_ts ON decisions(agent_id, ts);

      CREATE TABLE IF NOT EXISTS equity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        realized_usd REAL NOT NULL,
        open_value_usd REAL NOT NULL,
        equity_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_agent_ts ON equity(agent_id, ts);
    `)
  }

  recordTrade(t: TradeRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO trades
          (agent_id, mode, ts, side, token, token_symbol, quote_token, quote_symbol,
           amount_in, amount_out, tx_hash, reason, slippage_bps, gas_estimate, meta)
         VALUES (@agent_id,@mode,@ts,@side,@token,@token_symbol,@quote_token,@quote_symbol,
           @amount_in,@amount_out,@tx_hash,@reason,@slippage_bps,@gas_estimate,@meta)`,
      )
      .run({
        agent_id: t.agentId,
        mode: t.mode,
        ts: t.ts,
        side: t.side,
        token: t.token,
        token_symbol: t.tokenSymbol,
        quote_token: t.quoteToken,
        quote_symbol: t.quoteSymbol,
        amount_in: t.amountIn.toString(),
        amount_out: t.amountOut.toString(),
        tx_hash: t.txHash,
        reason: t.reason,
        slippage_bps: t.slippageBps,
        gas_estimate: t.gasEstimate.toString(),
        meta: JSON.stringify(t.meta ?? {}),
      })
    return Number(info.lastInsertRowid)
  }

  recordDecision(d: DecisionRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions (agent_id, ts, kind, detail, meta)
         VALUES (@agent_id,@ts,@kind,@detail,@meta)`,
      )
      .run({
        agent_id: d.agentId,
        ts: d.ts,
        kind: d.kind,
        detail: d.detail,
        meta: JSON.stringify(d.meta ?? {}),
      })
    return Number(info.lastInsertRowid)
  }

  recordEquity(e: EquityPoint): void {
    this.db
      .prepare(
        `INSERT INTO equity (agent_id, ts, realized_usd, open_value_usd, equity_usd)
         VALUES (?,?,?,?,?)`,
      )
      .run(e.agentId, e.ts, e.realizedUsd, e.openValueUsd, e.equityUsd)
  }

  /** Sum of USDG-denominated spend by an agent since a UTC-day boundary (ms). */
  spentSince(agentId: string, sinceMs: number, quoteSymbol = 'USDG'): number {
    const rows = this.db
      .prepare(
        `SELECT amount_in FROM trades
         WHERE agent_id=? AND ts>=? AND side='buy' AND quote_symbol=?`,
      )
      .all(agentId, sinceMs, quoteSymbol) as { amount_in: string }[]
    // amount_in is USDG (6dp) smallest units → dollars
    return rows.reduce((sum, r) => sum + Number(BigInt(r.amount_in)) / 1e6, 0)
  }

  recentTrades(agentId: string, limit = 50): TradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE agent_id=? ORDER BY ts DESC LIMIT ?`)
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(rowToTrade)
  }

  recentDecisions(agentId: string, limit = 100): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE agent_id=? ORDER BY ts DESC LIMIT ?`)
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      ts: r.ts as number,
      kind: r.kind as DecisionRecord['kind'],
      detail: r.detail as string,
      meta: JSON.parse((r.meta as string) || '{}'),
    }))
  }

  equityCurve(agentId: string, limit = 500): EquityPoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM equity WHERE agent_id=? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`,
      )
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      ts: r.ts as number,
      realizedUsd: r.realized_usd as number,
      openValueUsd: r.open_value_usd as number,
      equityUsd: r.equity_usd as number,
    }))
  }

  /** All trades across every agent, newest first — for the fleet-wide feed. */
  allRecentTrades(limit = 100): TradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToTrade)
  }

  allRecentDecisions(limit = 100): DecisionRecord[] {
    const rows = this.db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map(r => ({ id: r.id as number, agentId: r.agent_id as string, ts: r.ts as number,
      kind: r.kind as DecisionRecord['kind'], detail: r.detail as string, meta: JSON.parse((r.meta as string) || '{}') }))
  }


  /** Prepared actions are server-owned; browser reports cannot change recipient/calldata. */
  recordWalletPlan(plan: WalletPlanRecord): void {
    this.db.prepare('DELETE FROM wallet_plans WHERE expires_at < ? AND id NOT IN (SELECT plan_id FROM wallet_activity)').run(Date.now()-86_400_000)
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM wallet_plans WHERE id NOT IN (SELECT plan_id FROM wallet_activity)').get() as {n:number}
    if(count.n >= 10000)throw new Error('Wallet plan capacity reached')
    this.db.prepare('INSERT INTO wallet_plans(id, expires_at, payload) VALUES (?,?,?)').run(plan.id,plan.expiresAt,JSON.stringify(plan))
  }
  walletPlan(id: string): WalletPlanRecord | null {
    const row=this.db.prepare('SELECT payload FROM wallet_plans WHERE id=?').get(id) as {payload:string}|undefined
    return row ? JSON.parse(row.payload) : null
  }
  recordWalletActivity(event: WalletActivityRecord): void {
    const prior=this.walletActivity(event.chainId,event.txHash)
    if(prior && prior.planId!==event.planId)throw new Error('Transaction is already associated with a prepared plan')
    this.db.prepare('INSERT INTO wallet_activity(chain_id,tx_hash,plan_id,observed_at,payload) VALUES (?,?,?,?,?) ON CONFLICT(chain_id,tx_hash) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload')
      .run(event.chainId,event.txHash.toLowerCase(),event.planId,event.observedAt,JSON.stringify(event))
  }
  walletActivity(chainId: number, hash: string): WalletActivityRecord | null {
    const row=this.db.prepare('SELECT payload FROM wallet_activity WHERE chain_id=? AND tx_hash=?').get(chainId,hash.toLowerCase()) as {payload:string}|undefined
    return row ? JSON.parse(row.payload) : null
  }
  recentWalletActivity(limit=100): WalletActivityRecord[] {
    const rows=this.db.prepare('SELECT payload FROM wallet_activity ORDER BY observed_at DESC LIMIT ?').all(Math.max(1,Math.min(100,limit))) as {payload:string}[]
    return rows.map(row=>JSON.parse(row.payload))
  }


  recordExternalEvent(event:ExternalEventRecord,nextCheckAt=Number.MAX_SAFE_INTEGER):void {
    this.db.prepare('INSERT INTO external_events(id,type,chain_id,status,observed_at,next_check_at,payload) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,next_check_at=excluded.next_check_at,payload=excluded.payload')
      .run(event.id,event.type,event.chainId,event.status,event.observedAt,nextCheckAt,JSON.stringify(event))
  }
  externalEvent(id:string):ExternalEventRecord|null {
    const row=this.db.prepare('SELECT payload FROM external_events WHERE id=?').get(id) as {payload:string}|undefined
    return row?JSON.parse(row.payload):null
  }
  externalEvents(type:'bridge'|'launch',limit=100,chainId?:number):ExternalEventRecord[] {
    const rows=this.db.prepare('SELECT payload FROM external_events WHERE type=? AND (? IS NULL OR chain_id=?) ORDER BY observed_at DESC LIMIT ?').all(type,chainId??null,chainId??null,Math.min(200,Math.max(1,limit))) as {payload:string}[]
    return rows.map(row=>JSON.parse(row.payload))
  }
  dueExternalEvents(type:'bridge'|'launch',now:number,limit=10):ExternalEventRecord[] {
    const rows=this.db.prepare('SELECT payload FROM external_events WHERE type=? AND next_check_at<=? ORDER BY next_check_at ASC LIMIT ?').all(type,now,limit) as {payload:string}[]
    return rows.map(row=>JSON.parse(row.payload))
  }
  deferExternalEvent(id:string,until:number):void {
    this.db.prepare('UPDATE external_events SET next_check_at=? WHERE id=?').run(until,id)
  }
  pendingExternalCount(type:'bridge'|'launch'):number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM external_events WHERE type=? AND next_check_at<?').get(type,Number.MAX_SAFE_INTEGER) as {n:number}).n
  }

  close(): void {
    this.db.close()
  }
}

function rowToTrade(r: Record<string, unknown>): TradeRecord {
  return {
    id: r.id as number,
    agentId: r.agent_id as string,
    mode: r.mode as TradeRecord['mode'],
    ts: r.ts as number,
    side: r.side as 'buy' | 'sell',
    token: r.token as `0x${string}`,
    tokenSymbol: r.token_symbol as string,
    quoteToken: r.quote_token as `0x${string}`,
    quoteSymbol: r.quote_symbol as string,
    amountIn: BigInt(r.amount_in as string),
    amountOut: BigInt(r.amount_out as string),
    txHash: (r.tx_hash as `0x${string}` | null) ?? null,
    reason: r.reason as string,
    slippageBps: r.slippage_bps as number,
    gasEstimate: BigInt(r.gas_estimate as string),
    meta: JSON.parse((r.meta as string) || '{}'),
  }
}
