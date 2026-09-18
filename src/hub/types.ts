import type { Address, Hex } from 'viem'

export type AssetType = 'crypto' | 'stablecoin' | 'stock-token' | 'launch-token'
export interface Asset {
  id: string; chainId: number; address: Address; symbol: string; name: string
  decimals: number; type: AssetType; source: string; tradable: boolean
}
export interface HubQuote {
  quoteId: string; chainId: number; account: Address; tokenIn: Asset; tokenOut: Asset
  amountIn: string; amountOut: string; minimumReceived: string; slippageBps: number
  gasEstimate: string; estimatedNetworkFeeWei: string | null; priceImpactBps: null
  source: 'hoodchain/uniswap-v3'; route: { path: Address[]; fees: number[] }
  createdAt: number; expiresAt: number
}
export interface WalletTransaction { to: Address; data: Hex; value: string }
export interface PreparedSwap {
  kind: 'wallet-transaction-plan'; signing: 'user-wallet'; chainId: number
  planId: string; quoteId: string; account: Address; expiresAt: number; minimumReceived: string; deadline: string
  approvals: (WalletTransaction & { amount: string; spender: Address })[]
  transaction: WalletTransaction; simulation: 'passed' | 'requires-approval'; reQuoteAfterApproval: boolean
}
/** Wire projection only; existing Agent Position remains authoritative. */
export interface HubPosition {
  id: string; chainId: number; assetId: string; owner: Address
  source: 'wallet' | 'bot' | 'launch'; strategyId?: string; mode: 'paper' | 'live'
  amount: string; investedUsd: number | null; markUsd: number | null; openedAt: number | null
}
/** Planned Journal event projection, not a second persistence store. */
export interface ActivityEvent {
  id: string; chainId: number; owner: Address | null; sourceRecordId: string
  source: 'manual' | 'bot' | 'bridge' | 'launch' | 'arbitrage'
  kind: string; status: 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'reorged'
  timestamp: number; txHash?: Hex; blockNumber?: string; logIndex?: number
}
/** Wraps Agent or external worker; does not replace Strategy.tick. */
export interface HubStrategy {
  id: string; name: string; start(): Promise<void>; stop(): Promise<void>
  status(): { running: boolean; killed: boolean; mode: 'paper' | 'live'; lastError: string | null }
  positions(): HubPosition[]
}

export interface PreparedWrap {
  kind:'native-wrap-plan'; signing:'user-wallet'; planId:string; chainId:number; account:Address
  direction:'wrap'|'unwrap'; amount:string; weth:Address; expiresAt:number
  transaction:WalletTransaction; simulation:'passed'; gasEstimate:string
  estimatedNetworkFeeWei:string; gasReserveWei:string
}
