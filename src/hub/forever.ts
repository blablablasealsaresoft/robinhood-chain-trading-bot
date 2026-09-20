import { randomUUID } from 'node:crypto'
import { encodeFunctionData, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'
import { foreverFactoryAbi, foreverTokenAbi, foreverVaultAbi } from './forever-abi.js'

const SNAPSHOT_LIMIT = 100n

function streamRecord(row: unknown): { host: Address; live: boolean; startedAt: bigint; tipsWei: bigint; claimable: bigint; claimed: bigint; title: string } {
  const raw = Array.isArray(row)
    ? { host: row[0], live: row[1], startedAt: row[2], tipsWei: row[3], claimable: row[4], claimed: row[5], title: row[6] }
    : row && typeof row === 'object' ? row as Record<string, unknown> : null
  const host = raw && (raw.host ?? raw.streamer)
  if (!raw || typeof host !== 'string' || !isAddress(host) || typeof raw.live !== 'boolean' || typeof raw.startedAt !== 'bigint' || typeof raw.tipsWei !== 'bigint' || typeof raw.claimable !== 'bigint' || typeof raw.claimed !== 'bigint' || typeof raw.title !== 'string') {
    throw new Error('incomplete stream')
  }
  return { host: getAddress(host), live: raw.live, startedAt: raw.startedAt, tipsWei: raw.tipsWei, claimable: raw.claimable, claimed: raw.claimed, title: raw.title }
}

function descriptionFromUri(uri: string): string {
  try {
    if (!uri.startsWith('data:application/json;base64,')) return ''
    const parsed = JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8')) as { description?: unknown }
    return typeof parsed.description === 'string' && parsed.description.length <= 500 ? parsed.description : ''
  } catch {
    return ''
  }
}

export type ForeverAction = 'create' | 'buy' | 'sell' | 'addDepth' | 'claimRewards' | 'goLive' | 'endLive' | 'tip' | 'claimStream'
const kinds = {
  create: 'forever-create',
  buy: 'forever-buy',
  sell: 'forever-sell',
  addDepth: 'forever-depth',
  claimRewards: 'forever-rewards',
  goLive: 'forever-live',
  endLive: 'forever-end',
  tip: 'forever-tip',
  claimStream: 'forever-stream-claim',
} as const
const titles: Record<ForeverAction, string> = {
  create: 'Seal vault',
  buy: 'Buy sealed tokens',
  sell: 'Sell sealed tokens',
  addDepth: 'Add depth forever',
  claimRewards: 'Claim buyer rewards',
  goLive: 'Go live',
  endLive: 'End stream',
  tip: 'Tip live stream',
  claimStream: 'Claim stream earnings',
}

interface Options { chainId: number; factory?: string; deploymentBlock?: string; isKilled: () => boolean; journal: Journal }
function account(v: unknown): Address {
  if (typeof v !== 'string' || !isAddress(v) || v.toLowerCase() === zeroAddress) throw new HubError(400, 'INVALID_ADDRESS', 'Enter a valid wallet address.')
  return getAddress(v)
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported forever field.')
}
function metadataURI(description = '', image = '') {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify({ description, image })).toString('base64')
}

export class ForeverService {
  readonly factory: Address | null
  readonly deploymentBlock: bigint | null
  private error = ''
  constructor(private market: Market, private options: Options) {
    if (market.client.wallet || market.client.account) throw new Error('ForeverService requires a signer-free Market')
    this.factory = options.factory && isAddress(options.factory) && options.factory.toLowerCase() !== zeroAddress ? getAddress(options.factory) : null
    this.deploymentBlock = options.deploymentBlock && /^\d{1,20}$/.test(options.deploymentBlock) ? BigInt(options.deploymentBlock) : null
    if ((options.factory || options.deploymentBlock) && !this.factory) this.error = 'Configure a valid ForeverFactory address.'
    if (options.deploymentBlock && this.deploymentBlock === null) this.error = 'ForeverFactory deployment block must be a decimal integer.'
  }
  private requireFactory(): Address {
    if (this.error) throw new HubError(503, 'FOREVER_CONFIGURATION', this.error)
    if (!this.factory) throw new HubError(503, 'FOREVER_NOT_CONFIGURED', 'A reviewed ForeverFactory has not been configured for this Hub.')
    return this.factory
  }
  private guard() { if (this.options.isKilled()) throw new HubError(409, 'KILLED', 'New wallet preparations are halted.') }
  private async checkFactory() {
    const factory = this.requireFactory(), rpc = this.market.client.public
    if (await rpc.getChainId() !== this.options.chainId) throw new HubError(409, 'CHAIN_MISMATCH', 'Forever RPC network mismatch.')
    const [code, head] = await Promise.all([rpc.getCode({ address: factory }), rpc.getBlockNumber()])
    if (this.deploymentBlock !== null && head < this.deploymentBlock) throw new HubError(503, 'DEPLOYMENT_BLOCK', 'Configured deployment block is ahead of the RPC.')
    if (!code || code === '0x') throw new HubError(503, 'FACTORY_UNAVAILABLE', 'No contract exists at the configured ForeverFactory.')
    return factory
  }
  async status() {
    const base = { chainId: this.options.chainId, configured: !!this.factory && !this.error, factory: this.factory, deploymentBlock: this.deploymentBlock?.toString() ?? null, killed: this.options.isKilled() }
    if (this.error) return { ...base, status: 'configuration-error', message: this.error }
    if (!base.configured) return { ...base, status: 'not-configured', message: 'Sealed markets stay in the playground until a reviewed ForeverFactory is configured.' }
    try {
      await this.checkFactory()
      return { ...base, status: 'ready', message: 'Configured ForeverFactory is ready. Each wallet action requires review and confirmation.' }
    } catch {
      return { ...base, status: 'unavailable', message: 'The configured ForeverFactory or RPC is unavailable. Wallet actions are paused.' }
    }
  }
  async list(owner?: string | null) {
    const wallet = owner ? account(owner) : undefined
    const factory = await this.checkFactory()
    const rpc = this.market.client.public
    const block = await rpc.getBlockNumber()
    const read = <T>(address: Address, abi: typeof foreverFactoryAbi | typeof foreverVaultAbi | typeof foreverTokenAbi, functionName: string, args: readonly unknown[] = []) =>
      rpc.readContract({ address, abi, functionName, args, blockNumber: block } as never) as Promise<T>
    const count = await read<bigint>(factory, foreverFactoryAbi, 'vaultCount')
    const page = await read<Address[]>(factory, foreverFactoryAbi, 'getVaults', [0n, SNAPSHOT_LIMIT])
    const vaults: Record<string, unknown>[] = []
    let unread = 0
    for (const vault of page) {
      try { vaults.push(await this.snapshotVault(vault, wallet, read)) }
      catch { unread++ }
    }
    const omitted = count > BigInt(page.length)
    const incomplete = omitted || unread > 0
    return {
      chainId: this.options.chainId,
      factory,
      blockNumber: block.toString(),
      observedAt: Date.now(),
      incomplete,
      coverage: omitted
        ? `First ${page.length} of ${count.toString()} vaults at block ${block.toString()}; not complete history.`
        : unread
          ? `Vault snapshot at block ${block.toString()}; ${unread} vault${unread === 1 ? '' : 's'} could not be read.`
          : `Vault snapshot at block ${block.toString()}; live hosts plus the connected wallet’s ended streams. Not a full tape.`,
      vaults,
    }
  }
  private async snapshotVault(vault: Address, wallet: Address | undefined, read: <T>(address: Address, abi: typeof foreverFactoryAbi | typeof foreverVaultAbi | typeof foreverTokenAbi, functionName: string, args?: readonly unknown[]) => Promise<T>) {
    const [token, creator, metadataURI, realEth, tokenReserve, rewardPot, participants, liveCount] = await Promise.all([
      read<Address>(vault, foreverVaultAbi, 'token'),
      read<Address>(vault, foreverVaultAbi, 'creator'),
      read<string>(vault, foreverVaultAbi, 'metadataURI'),
      read<bigint>(vault, foreverVaultAbi, 'realEth'),
      read<bigint>(vault, foreverVaultAbi, 'tokenReserve'),
      read<bigint>(vault, foreverVaultAbi, 'rewardPot'),
      read<bigint>(vault, foreverVaultAbi, 'participants'),
      read<bigint>(vault, foreverVaultAbi, 'liveCount'),
    ])
    if (!isAddress(token) || token.toLowerCase() === zeroAddress || !isAddress(creator) || creator.toLowerCase() === zeroAddress) throw new Error('incomplete vault')
    const liveLimit = liveCount > SNAPSHOT_LIMIT ? Number(SNAPSHOT_LIMIT) : Number(liveCount)
    const [name, symbol, supply, pendingRewards, tokenBalance, buyVolume, sellVolume, tradeCount, ...liveHosts] = await Promise.all([
      read<string>(token, foreverTokenAbi, 'name'),
      read<string>(token, foreverTokenAbi, 'symbol'),
      read<bigint>(token, foreverTokenAbi, 'totalSupply'),
      wallet ? read<bigint>(vault, foreverVaultAbi, 'pendingRewards', [wallet]) : Promise.resolve(null),
      wallet ? read<bigint>(token, foreverTokenAbi, 'balanceOf', [wallet]) : Promise.resolve(null),
      wallet ? read<bigint>(vault, foreverVaultAbi, 'buyVolume', [wallet]) : Promise.resolve(null),
      wallet ? read<bigint>(vault, foreverVaultAbi, 'sellVolume', [wallet]) : Promise.resolve(null),
      wallet ? read<bigint>(vault, foreverVaultAbi, 'tradeCount', [wallet]) : Promise.resolve(null),
      ...Array.from({ length: liveLimit }, (_, i) => read<Address>(vault, foreverVaultAbi, 'liveStreamers', [BigInt(i)])),
    ])
    if (typeof name !== 'string' || typeof symbol !== 'string') throw new Error('incomplete vault')
    const hosts = new Map<string, Address>()
    for (const host of liveHosts) {
      if (isAddress(host) && host.toLowerCase() !== zeroAddress) hosts.set(host.toLowerCase(), getAddress(host))
    }
    if (wallet && !hosts.has(wallet.toLowerCase())) hosts.set(wallet.toLowerCase(), wallet)
    const streams = []
    for (const host of hosts.values()) {
      const row = streamRecord(await read<unknown>(vault, foreverVaultAbi, 'streams', [host]))
      const streamer = getAddress(row.host)
      if (streamer.toLowerCase() === zeroAddress) continue
      if (!row.live && (!wallet || streamer.toLowerCase() !== wallet.toLowerCase())) continue
      if (!row.title || new TextEncoder().encode(row.title).length > 80) continue
      if (!Number.isSafeInteger(Number(row.startedAt) * 1000)) continue
      streams.push({
        vault,
        streamer,
        title: row.title,
        live: row.live,
        startedAt: row.startedAt.toString(),
        tipsWei: row.tipsWei.toString(),
        claimable: row.claimable.toString(),
        claimed: row.claimed.toString(),
      })
    }
    return {
      vaultId: vault,
      vault,
      token: getAddress(token),
      creator: getAddress(creator),
      name,
      symbol,
      metadataURI,
      description: descriptionFromUri(metadataURI),
      supply: supply.toString(),
      realEth: realEth.toString(),
      tokenReserve: tokenReserve.toString(),
      rewardPot: rewardPot.toString(),
      participants: participants.toString(),
      pendingRewards: pendingRewards?.toString() ?? null,
      tokenBalance: tokenBalance?.toString() ?? null,
      buyVolume: buyVolume?.toString() ?? null,
      sellVolume: sellVolume?.toString() ?? null,
      tradeCount: tradeCount?.toString() ?? null,
      streams,
    }
  }
  async prepare(input: Record<string, unknown>) {
    const action = input.action as ForeverAction
    if (!Object.hasOwn(kinds, action)) throw new HubError(400, 'INVALID_ACTION', 'Choose a supported forever action.')
    const extra = action === 'create' ? ['name', 'symbol', 'wholeSupply', 'description', 'image']
      : action === 'sell' ? ['vault', 'token', 'amount']
      : action === 'tip' ? ['vault', 'streamer', 'amount']
      : action === 'goLive' ? ['vault', 'title']
      : action === 'buy' || action === 'addDepth' ? ['vault', 'amount']
      : ['vault']
    fields(input, ['chainId', 'account', 'action', ...extra])
    if (String(input.chainId) !== String(this.options.chainId)) throw new HubError(409, 'CHAIN_MISMATCH', 'Forever action belongs to another network.')
    const owner = account(input.account)
    this.guard()
    const factory = await this.checkFactory()
    const rpc = this.market.client.public
    let to: Address = factory
    let value = 0n
    let data: Hex
    let amount = '0'
    let vault: Address | undefined
    let token: Address | undefined
    let streamer: Address | undefined
    let title: string | undefined
    let terms: { name: string; symbol: string; wholeSupply: string; metadataURI: string } | undefined
    const approvals: { to: Address; data: Hex; value: string }[] = []
    if (action === 'create') {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const symbol = typeof input.symbol === 'string' ? input.symbol.trim() : ''
      const wholeSupply = typeof input.wholeSupply === 'string' ? input.wholeSupply : ''
      const description = typeof input.description === 'string' ? input.description : ''
      const image = typeof input.image === 'string' ? input.image : ''
      if (!name || name.length > 64) throw new HubError(400, 'INVALID_TERMS', 'Enter a vault name of at most 64 characters.')
      if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new HubError(400, 'INVALID_TERMS', 'Ticker must be 1-12 letters or numbers.')
      if (!/^\d+$/.test(wholeSupply)) throw new HubError(400, 'INVALID_TERMS', 'Supply must be a whole number.')
      const supply = BigInt(wholeSupply)
      if (supply < 1000n || supply > 10n ** 15n) throw new HubError(400, 'INVALID_TERMS', 'Whole token supply must be between 1,000 and 1e15.')
      if (description.length > 500 || image.length > 512) throw new HubError(400, 'INVALID_METADATA', 'Description or image URL is too long.')
      terms = { name, symbol, wholeSupply, metadataURI: metadataURI(description, image) }
      data = encodeFunctionData({ abi: foreverFactoryAbi, functionName: 'createVault', args: [name, symbol, supply, terms.metadataURI] })
    } else {
      if (typeof input.vault !== 'string' || !isAddress(input.vault)) throw new HubError(400, 'INVALID_VAULT', 'Unexpected vault identity.')
      vault = getAddress(input.vault)
      to = vault
      const listed = await rpc.readContract({ address: factory, abi: foreverFactoryAbi, functionName: 'isVault', args: [vault] })
      if (!listed) throw new HubError(422, 'FOREIGN_VAULT', 'Vault is not registered on this ForeverFactory.')
      const onChainToken = await rpc.readContract({ address: vault, abi: foreverVaultAbi, functionName: 'token' })
      if (action === 'buy' || action === 'addDepth' || action === 'tip') {
        if (typeof input.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(input.amount) || BigInt(input.amount) >= (1n << 256n)) throw new HubError(400, 'INVALID_AMOUNT', 'Invalid amount.')
        amount = input.amount
        value = BigInt(amount)
        if (action === 'tip') {
          if (typeof input.streamer !== 'string' || !isAddress(input.streamer)) throw new HubError(400, 'INVALID_STREAMER', 'Unexpected streamer.')
          streamer = getAddress(input.streamer)
          data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'tip', args: [streamer] })
        } else data = encodeFunctionData({ abi: foreverVaultAbi, functionName: action === 'buy' ? 'buy' : 'addDepth' })
      } else if (action === 'sell') {
        if (typeof input.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(input.amount) || BigInt(input.amount) >= (1n << 256n)) throw new HubError(400, 'INVALID_AMOUNT', 'Unexpected sell.')
        if (typeof input.token !== 'string' || !isAddress(input.token)) throw new HubError(400, 'INVALID_TOKEN', 'Unexpected sell.')
        token = getAddress(input.token)
        if (token.toLowerCase() !== onChainToken.toLowerCase()) throw new HubError(422, 'TOKEN_MISMATCH', 'Vault token does not match this ForeverFactory vault.')
        amount = input.amount
        data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'sell', args: [BigInt(amount), owner] })
        approvals.push({ to: token, value: '0', data: encodeFunctionData({ abi: foreverTokenAbi, functionName: 'approve', args: [vault, BigInt(amount)] }) })
      } else if (action === 'claimRewards') {
        data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'claimRewards', args: [owner] })
      } else if (action === 'claimStream') {
        data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'claimStreamEarnings', args: [owner] })
      } else if (action === 'goLive') {
        title = typeof input.title === 'string' ? input.title.trim() : ''
        if (!title || title.length > 80) throw new HubError(400, 'INVALID_TITLE', 'Enter a stream title of at most 80 characters.')
        data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'goLive', args: [title] })
      } else {
        data = encodeFunctionData({ abi: foreverVaultAbi, functionName: 'endLive' })
      }
    }
    const transaction = { to, data, value: value.toString() }
    const [balance, price] = await Promise.all([rpc.getBalance({ address: owner, blockTag: 'pending' }), rpc.getGasPrice()])
    if (price <= 0n) throw new HubError(503, 'FEE_UNAVAILABLE', 'Network fee estimate is unavailable.')
    let gas: bigint
    try { gas = await rpc.estimateGas({ account: owner, to: transaction.to, data, value }) }
    catch { throw new HubError(422, 'FOREVER_SIMULATION', 'This action cannot currently execute. Check vault status, wallet permissions, amount and ETH for gas.') }
    if (gas <= 0n) throw new HubError(503, 'FEE_UNAVAILABLE', 'Network gas estimate is unavailable.')
    const reserve = (gas * price * 3n + 1n) / 2n
    if (balance < value + reserve) throw new HubError(422, 'GAS_RESERVE', 'Leave enough ETH for the sealed action and network fees.')
    this.guard()
    const now = Date.now(), planId = randomUUID()
    this.options.journal.recordWalletPlan({
      id: planId,
      chainId: this.options.chainId,
      account: owner,
      createdAt: now,
      expiresAt: now + 60_000,
      actions: [
        ...approvals.map(a => ({ kind: 'approval' as const, to: a.to, data: a.data, value: '0' })),
        { kind: kinds[action], ...transaction },
      ],
    })
    this.options.journal.recordDecision({ agentId: 'hub:manual', ts: now, kind: 'observe', detail: 'Unsigned forever action prepared: ' + titles[action], meta: { mode: 'manual', planId, owner, action, factory } })
    return {
      kind: 'forever-plan',
      signing: 'user-wallet',
      planId,
      chainId: this.options.chainId,
      account: owner,
      action,
      factory,
      vault,
      token,
      streamer,
      title,
      terms,
      amount,
      expiresAt: now + 60_000,
      transaction,
      approvals,
      simulation: 'passed' as const,
      gasEstimate: gas.toString(),
      estimatedNetworkFeeWei: (gas * price).toString(),
      gasReserveWei: reserve.toString(),
    }
  }
}
