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
  actions: { kind: 'approval'|'swap'|'wrap'|'unwrap'|'launch-create'|'launch-contribute'|'launch-claim'|'launch-refund'|'launch-proceeds'|'launch-remainder'|'liquidity-add'|'forever-create'|'forever-buy'|'forever-sell'|'forever-depth'|'forever-rewards'|'forever-live'|'forever-end'|'forever-tip'|'forever-stream-claim'; to: string; data: string; value: string }[]
}
export interface WalletActivityRecord {
  planId: string; chainId: number; account: string; txHash: string
  kind: WalletPlanRecord['actions'][number]['kind']
  status: 'submitted'|'confirming'|'confirmed'|'reverted'|'unverified'
  at: number; observedAt: number; blockNumber: string|null; blockHash: string|null
}


export interface AgentStateRecord {
  version:1; agentId:string; strategyId:string; mode:'paper'|'live'; updatedAt:number
  lastTradeId?:number; stateScope?:string
  spentDay:number; spentTodayUsd:number; lastTradeAt:number|null; realizedUsd:number
  ticks:number; trades:number; refusals:number; lastTickAt:number|null
  pendingLive?:{phase:'prepared'|'submitted';nonce:number;hash?:string;at:number}
  positions:Array<{
    token:string; tokenSymbol:string; amount:string; costBasis:string; investedUsd:number
    quoteToken:string; quoteSymbol:string; openedAt:number; markUsd:number|null; meta:Record<string,unknown>
  }>
}

export interface ExternalEventRecord {
  id:string; type:'bridge'|'launch'; source:string; chainId:number; txHash:string
  owner:string|null; at:number; observedAt:number; status:string
  verification:'unverified'|'provider'|'provider-and-receipt'|'chain-event'
  title:string; detail:string; data:Record<string,unknown>
}

export interface PortfolioSnapshotRecord {
  chainId:number; account:string; observedAt:number; blockNumber:string
  pricedValueUsd:number; incomplete:boolean
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
      CREATE INDEX IF NOT EXISTS idx_external_owner_at
        ON external_events(lower(json_extract(payload,'$.owner')), CAST(json_extract(payload,'$.at') AS INTEGER) DESC, id DESC);

      CREATE TABLE IF NOT EXISTS wallet_plans (
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_activity (
        chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, plan_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(chain_id, tx_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_activity_observed ON wallet_activity(observed_at);
      CREATE INDEX IF NOT EXISTS idx_wallet_activity_account_at
        ON wallet_activity(lower(json_extract(payload,'$.account')), CAST(json_extract(payload,'$.at') AS INTEGER) DESC, tx_hash DESC);

      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        chain_id INTEGER NOT NULL, account TEXT NOT NULL, block_number TEXT NOT NULL,
        observed_at INTEGER NOT NULL, priced_value_usd REAL NOT NULL, incomplete INTEGER NOT NULL,
        PRIMARY KEY(chain_id, account, block_number)
      );

      CREATE TABLE IF NOT EXISTS market_samples (
        chain_id INTEGER NOT NULL,
        asset_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        price_usd REAL,
        reference_usd REAL,
        dex_usd REAL,
        spread_bps REAL,
        source TEXT NOT NULL,
        PRIMARY KEY(chain_id, asset_key, observed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_market_samples_asset_time
        ON market_samples(chain_id, asset_key, observed_at);

      CREATE TABLE IF NOT EXISTS market_swaps (
        chain_id INTEGER NOT NULL,
        pool TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        block_time INTEGER NOT NULL,
        asset TEXT NOT NULL,
        quote TEXT NOT NULL,
        fee INTEGER NOT NULL,
        side TEXT NOT NULL,
        asset_amount TEXT NOT NULL,
        quote_amount TEXT NOT NULL,
        price_quote REAL NOT NULL,
        PRIMARY KEY(chain_id,pool,tx_hash,log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_market_swaps_asset_time
        ON market_swaps(chain_id,asset,block_time DESC);
      CREATE INDEX IF NOT EXISTS idx_market_swaps_pool_block
        ON market_swaps(chain_id,pool,CAST(block_number AS INTEGER));
      CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account_time
        ON portfolio_snapshots(chain_id, account, observed_at);

      CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_time ON portfolio_snapshots(observed_at);

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
      CREATE INDEX IF NOT EXISTS idx_decisions_owner_ts
        ON decisions(lower(json_extract(meta,'$.owner')), ts DESC, id DESC);

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

  modeSpentSince(mode:'paper'|'live',sinceMs:number):number {
    const rows=this.db.prepare("SELECT meta FROM trades WHERE mode=? AND side='buy' AND ts>=?").all(mode,sinceMs) as {meta:string}[]
    return rows.reduce((sum,row)=>{
      const value=JSON.parse(row.meta).notionalUsd
      if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(mode+' spend history requires reconciliation: missing notional')
      return sum+value
    },0)
  }
  paperSpentSince(sinceMs:number):number { return this.modeSpentSince('paper',sinceMs) }
  liveSpentSince(sinceMs:number):number { return this.modeSpentSince('live',sinceMs) }

  latestTradeId(agentId:string,mode:'paper'|'live'):number {
    return (this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM trades WHERE agent_id=? AND mode=?').get(agentId,mode) as {id:number}).id
  }

  latestTradeTimestamp(agentId:string,mode?:'paper'|'live'):number|null {
    const row=mode
      ? this.db.prepare('SELECT MAX(ts) AS ts FROM trades WHERE agent_id=? AND mode=?').get(agentId,mode) as {ts:number|null}
      : this.db.prepare('SELECT MAX(ts) AS ts FROM trades WHERE agent_id=?').get(agentId) as {ts:number|null}
    return row.ts??null
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


  recordAgentState(state:AgentStateRecord):void {
    this.db.prepare('INSERT INTO agent_state(agent_id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload')
      .run(state.agentId,state.updatedAt,JSON.stringify(state))
  }
  agentState(agentId:string):AgentStateRecord|null {
    const row=this.db.prepare('SELECT payload FROM agent_state WHERE agent_id=?').get(agentId) as {payload:string}|undefined
    return row?JSON.parse(row.payload) as AgentStateRecord:null
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

  walletActivityPage(account:string,limit:number,before?:{at:number;key:string}):Array<{value:WalletActivityRecord;at:number;pageKey:string}> {
    const bounded=Math.max(1,Math.min(101,Math.trunc(limit))),owner=account.toLowerCase()
    const keyExpr="'wallet:' || chain_id || ':' || lower(tx_hash)"
    const atExpr="CAST(json_extract(payload,'$.at') AS INTEGER)"
    const cursor=before?' AND ('+atExpr+' < ? OR ('+atExpr+' = ? AND '+keyExpr+' < ?))':''
    const sql='SELECT payload,'+atExpr+' AS at,'+keyExpr+' AS page_key FROM wallet_activity WHERE lower(json_extract(payload,\'$.account\'))=?'+cursor+' ORDER BY at DESC,page_key DESC LIMIT ?'
    const rows=this.db.prepare(sql).all(owner,...(before?[before.at,before.at,before.key]:[]),bounded) as {payload:string;at:number;page_key:string}[]
    return rows.map(row=>({value:JSON.parse(row.payload),at:Number(row.at),pageKey:row.page_key}))
  }


  replaceMarketSwapWindow(chainId:number,pools:string[],fromBlock:bigint,rows:Array<{pool:string;txHash:string;logIndex:number;blockNumber:bigint;blockHash:string;blockTime:number;asset:string;quote:string;fee:number;side:'buy'|'sell';assetAmount:string;quoteAmount:string;priceQuote:number}>):void {
    if(!pools.length)return
    const unique=[...new Set(pools.map(p=>p.toLowerCase()))]
    const placeholders=unique.map(()=>'?').join(',')
    const transaction=this.db.transaction(()=>{
      this.db.prepare('DELETE FROM market_swaps WHERE chain_id=? AND lower(pool) IN ('+placeholders+') AND CAST(block_number AS INTEGER)>=?')
        .run(chainId,...unique,fromBlock.toString())
      const insert=this.db.prepare(`INSERT INTO market_swaps
        (chain_id,pool,tx_hash,log_index,block_number,block_hash,block_time,asset,quote,fee,side,asset_amount,quote_amount,price_quote)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for(const row of rows)insert.run(chainId,row.pool.toLowerCase(),row.txHash.toLowerCase(),row.logIndex,row.blockNumber.toString(),row.blockHash.toLowerCase(),row.blockTime,row.asset.toLowerCase(),row.quote.toLowerCase(),row.fee,row.side,row.assetAmount,row.quoteAmount,row.priceQuote)
      const cutoff=Date.now()-30*86400000
      this.db.prepare('DELETE FROM market_swaps WHERE block_time<?').run(cutoff)
    })
    transaction()
  }
  marketSwaps(chainId:number,asset:string,sinceMs:number,limit=500):Array<{pool:string;txHash:string;logIndex:number;blockNumber:string;blockHash:string;blockTime:number;asset:string;quote:string;fee:number;side:'buy'|'sell';assetAmount:string;quoteAmount:string;priceQuote:number}> {
    const bounded=Math.max(1,Math.min(2000,Math.trunc(limit)))
    const rows=this.db.prepare(`SELECT pool,tx_hash,log_index,block_number,block_hash,block_time,asset,quote,fee,side,asset_amount,quote_amount,price_quote
      FROM market_swaps WHERE chain_id=? AND asset=? AND block_time>=? ORDER BY block_time DESC,CAST(block_number AS INTEGER) DESC,log_index DESC LIMIT ?`)
      .all(chainId,asset.toLowerCase(),sinceMs,bounded) as Array<Record<string,unknown>>
    return rows.map(row=>({pool:String(row.pool),txHash:String(row.tx_hash),logIndex:Number(row.log_index),blockNumber:String(row.block_number),blockHash:String(row.block_hash),blockTime:Number(row.block_time),asset:String(row.asset),quote:String(row.quote),fee:Number(row.fee),side:row.side as 'buy'|'sell',assetAmount:String(row.asset_amount),quoteAmount:String(row.quote_amount),priceQuote:Number(row.price_quote)}))
  }
  latestMarketSwapBlock(chainId:number,pools:string[]):bigint|null {
    if(!pools.length)return null
    const unique=[...new Set(pools.map(p=>p.toLowerCase()))],placeholders=unique.map(()=>'?').join(',')
    const row=this.db.prepare('SELECT MAX(CAST(block_number AS INTEGER)) AS n FROM market_swaps WHERE chain_id=? AND lower(pool) IN ('+placeholders+')').get(chainId,...unique) as {n:number|null}
    return row.n===null?null:BigInt(row.n)
  }

  recordMarketSample(sample:{chainId:number;assetKey:string;observedAt:number;priceUsd:number|null;referenceUsd:number|null;dexUsd:number|null;spreadBps:number|null;source:string}):void {
    if(!Number.isSafeInteger(sample.observedAt)||sample.observedAt<0)throw new Error('Invalid market sample timestamp')
    for(const value of [sample.priceUsd,sample.referenceUsd,sample.dexUsd,sample.spreadBps])if(value!==null&&!Number.isFinite(value))throw new Error('Invalid market sample value')
    this.db.prepare(`INSERT OR REPLACE INTO market_samples
      (chain_id,asset_key,observed_at,price_usd,reference_usd,dex_usd,spread_bps,source)
      VALUES (?,?,?,?,?,?,?,?)`).run(sample.chainId,sample.assetKey.toLowerCase(),sample.observedAt,sample.priceUsd,sample.referenceUsd,sample.dexUsd,sample.spreadBps,sample.source)
    this.db.prepare('DELETE FROM market_samples WHERE observed_at<?').run(sample.observedAt-30*86400000)
    this.db.prepare('DELETE FROM market_samples WHERE rowid IN (SELECT rowid FROM market_samples WHERE chain_id=? AND asset_key=? ORDER BY observed_at DESC LIMIT -1 OFFSET 10000)')
      .run(sample.chainId,sample.assetKey.toLowerCase())
  }
  marketSeries(chainId:number,assetKey:string,sinceMs:number,limit=720):Array<{observedAt:number;priceUsd:number|null;referenceUsd:number|null;dexUsd:number|null;spreadBps:number|null;source:string}> {
    const bounded=Math.max(2,Math.min(2000,Math.trunc(limit)))
    const rows=this.db.prepare(`SELECT observed_at,price_usd,reference_usd,dex_usd,spread_bps,source
      FROM market_samples WHERE chain_id=? AND asset_key=? AND observed_at>=?
      ORDER BY observed_at DESC LIMIT ?`).all(chainId,assetKey.toLowerCase(),sinceMs,bounded) as Array<Record<string,unknown>>
    return rows.reverse().map(row=>({observedAt:Number(row.observed_at),priceUsd:row.price_usd===null?null:Number(row.price_usd),referenceUsd:row.reference_usd===null?null:Number(row.reference_usd),dexUsd:row.dex_usd===null?null:Number(row.dex_usd),spreadBps:row.spread_bps===null?null:Number(row.spread_bps),source:String(row.source)}))
  }

  recordPortfolioSnapshot(snapshot:PortfolioSnapshotRecord):void {
    const account=snapshot.account.toLowerCase()
    if(!Number.isFinite(snapshot.pricedValueUsd)||snapshot.pricedValueUsd<0)throw new Error('Invalid portfolio value')
    this.db.prepare(`INSERT INTO portfolio_snapshots
      (chain_id,account,block_number,observed_at,priced_value_usd,incomplete)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(chain_id,account,block_number) DO UPDATE SET
        observed_at=excluded.observed_at,
        priced_value_usd=excluded.priced_value_usd,
        incomplete=excluded.incomplete
      WHERE portfolio_snapshots.incomplete=1 OR excluded.incomplete=0`)
      .run(snapshot.chainId,account,snapshot.blockNumber,snapshot.observedAt,snapshot.pricedValueUsd,snapshot.incomplete?1:0)
    this.db.prepare('DELETE FROM portfolio_snapshots WHERE observed_at<?').run(snapshot.observedAt-30*86400000)
    this.db.prepare('DELETE FROM portfolio_snapshots WHERE rowid IN (SELECT rowid FROM portfolio_snapshots WHERE chain_id=? AND account=? ORDER BY observed_at DESC LIMIT -1 OFFSET 10000)').run(snapshot.chainId,account)
    this.db.prepare('DELETE FROM portfolio_snapshots WHERE rowid IN (SELECT rowid FROM portfolio_snapshots ORDER BY observed_at DESC LIMIT -1 OFFSET 100000)').run()
  }
  portfolioSnapshots(chainId:number,account:string,sinceMs:number,limit=288):PortfolioSnapshotRecord[] {
    const bounded=Math.max(1,Math.min(2000,Math.trunc(limit)))
    const rows=this.db.prepare(`SELECT chain_id,account,block_number,observed_at,priced_value_usd,incomplete
      FROM portfolio_snapshots
      WHERE chain_id=? AND account=? AND observed_at>=?
      ORDER BY observed_at DESC LIMIT ?`)
      .all(chainId,account.toLowerCase(),sinceMs,bounded) as Array<Record<string,unknown>>
    return rows.reverse().map(row=>({
      chainId:Number(row.chain_id),account:String(row.account),blockNumber:String(row.block_number),
      observedAt:Number(row.observed_at),pricedValueUsd:Number(row.priced_value_usd),incomplete:Boolean(row.incomplete),
    }))
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

  externalEventsPage(owner:string,limit:number,before?:{at:number;key:string}):Array<{value:ExternalEventRecord;at:number;pageKey:string}> {
    const bounded=Math.max(1,Math.min(101,Math.trunc(limit))),account=owner.toLowerCase()
    const keyExpr="'external:' || id"
    const atExpr="CAST(json_extract(payload,'$.at') AS INTEGER)"
    const cursor=before?' AND ('+atExpr+' < ? OR ('+atExpr+' = ? AND '+keyExpr+' < ?))':''
    const sql='SELECT payload,'+atExpr+' AS at,'+keyExpr+' AS page_key FROM external_events WHERE lower(json_extract(payload,\'$.owner\'))=? AND NOT EXISTS (SELECT 1 FROM wallet_activity wa WHERE lower(json_extract(wa.payload,\'$.account\'))=? AND wa.chain_id=external_events.chain_id AND lower(wa.tx_hash)=lower(json_extract(external_events.payload,\'$.txHash\')))'+cursor+' ORDER BY at DESC,page_key DESC LIMIT ?'
    const rows=this.db.prepare(sql).all(account,account,...(before?[before.at,before.at,before.key]:[]),bounded) as {payload:string;at:number;page_key:string}[]
    return rows.map(row=>({value:JSON.parse(row.payload),at:Number(row.at),pageKey:row.page_key}))
  }

  manualDecisionPage(owner:string,limit:number,before?:{at:number;key:string}):Array<{value:DecisionRecord;at:number;pageKey:string}> {
    const bounded=Math.max(1,Math.min(101,Math.trunc(limit))),account=owner.toLowerCase()
    const keyExpr="'decision:' || printf('%020d',id)"
    const cursor=before?' AND (ts < ? OR (ts = ? AND '+keyExpr+' < ?))':''
    const sql='SELECT *,'+keyExpr+' AS page_key FROM decisions WHERE agent_id=\'hub:manual\' AND lower(json_extract(meta,\'$.owner\'))=?'+cursor+' ORDER BY ts DESC,page_key DESC LIMIT ?'
    const rows=this.db.prepare(sql).all(account,...(before?[before.at,before.at,before.key]:[]),bounded) as (Record<string,unknown>&{page_key:string})[]
    return rows.map(r=>({value:{id:r.id as number,agentId:r.agent_id as string,ts:r.ts as number,kind:r.kind as DecisionRecord['kind'],detail:r.detail as string,meta:JSON.parse((r.meta as string)||'{}')},at:r.ts as number,pageKey:r.page_key}))
  }
  dueExternalEvents(type:'bridge'|'launch',now:number,limit=10,sources?:string[]):ExternalEventRecord[] {
    const filter=sources?.length?' AND json_extract(payload, \'$.source\') IN ('+sources.map(()=>'?').join(',')+')':''
    const rows=this.db.prepare('SELECT payload FROM external_events WHERE type=? AND next_check_at<=?'+filter+' ORDER BY next_check_at ASC LIMIT ?').all(type,now,...(sources??[]),limit) as {payload:string}[]
    return rows.map(row=>JSON.parse(row.payload))
  }
  deferExternalEvent(id:string,until:number):void {
    this.db.prepare('UPDATE external_events SET next_check_at=? WHERE id=?').run(until,id)
  }
  pendingExternalCount(type:'bridge'|'launch'):number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM external_events WHERE type=? AND next_check_at<?').get(type,Number.MAX_SAFE_INTEGER) as {n:number}).n
  }

  healthProbe(): { readable:boolean; writable:boolean } {
    try { this.db.prepare('SELECT id FROM decisions LIMIT 1').get() } catch { return {readable:false,writable:false} }
    let writable=false
    try {
      this.db.exec('SAVEPOINT hub_health')
      this.db.prepare("INSERT INTO decisions(agent_id,ts,kind,detail,meta) VALUES ('hub:health',0,'observe','health probe','{}')").run()
      this.db.exec('ROLLBACK TO hub_health')
      this.db.exec('RELEASE hub_health')
      writable=true
    } catch {
      try { this.db.exec('ROLLBACK TO hub_health'); this.db.exec('RELEASE hub_health') } catch { /* closed or unavailable database */ }
    }
    return {readable:true,writable}
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
