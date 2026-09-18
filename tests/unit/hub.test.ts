import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { decodeFunctionData, encodePacked, getAddress, type Address } from 'viem'
import { erc20Abi, swapRouter02Abi } from 'hoodchain'
import { Market } from '../../src/framework/market.js'
import type { FleetConfig } from '../../src/framework/config.js'
import type { Fleet } from '../../src/framework/fleet.js'
import { ManualSwapService } from '../../src/hub/manual-swaps.js'
import { createHubHandler } from '../../src/server/hub.js'

const account = getAddress('0x1111111111111111111111111111111111111111')
const another = getAddress('0x2222222222222222222222222222222222222222')
const config: FleetConfig = { network: 'mainnet', rpcUrl: undefined, mode: 'paper', hasWallet: false, privateKey: undefined, stockTokenEligible: false, fleetMaxDailySpendUsdg: 250, dashboardPort: 4670, killFile: './KILL', dbPath: ':memory:', defaultLimits: { maxPositionUsdg: 50, maxDailySpendUsdg: 100, maxSlippageBps: 100, cooldownSeconds: 60 } }

function fixture() {
  const market = new Market(config)
  let killed = false, now = Date.now(), allowance = 0n, balance = 100000000n
  vi.spyOn(market.client.public, 'getChainId').mockResolvedValue(4663)
  vi.spyOn(market.client.public, 'getGasPrice').mockResolvedValue(1000000000n)
  vi.spyOn(market.client.public, 'estimateGas').mockResolvedValue(150000n)
  vi.spyOn(market.client.public, 'readContract').mockImplementation(async ({ functionName }) => functionName === 'balanceOf' ? balance : allowance)
  vi.spyOn(market, 'quoteBuy').mockImplementation(async (input, output, amount) => ({ amountIn: amount, amountOut: 500000000000000n, gasEstimate: 150000n, route: { path: [input, output], fees: [3000], encodedPath: encodePacked(['address', 'uint24', 'address'], [input, 3000, output]) } }))
  const journal = { recordDecision: vi.fn(() => 1) }
  const service = new ManualSwapService(market, { chainId: 4663, maxSlippageBps: 100, isKilled: () => killed, journal, clock: () => now })
  const params = { chainId: '4663', tokenIn: market.usdg, tokenOut: market.weth, amountIn: '1000000', account, slippageBps: '50' }
  return { market, service, params, journal, kill: () => { killed = true }, advance: (ms: number) => { now += ms }, allowance: (amount: bigint) => { allowance = amount }, balance: (amount: bigint) => { balance = amount } }
}
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))); vi.restoreAllMocks() })

describe('manual Hub adapter', () => {
  it('reuses Market quotes without loss of integer precision or fabricated impact', async () => {
    const f = fixture()
    const q = await f.service.quote({ ...f.params, amountIn: '900719925474099312345' })
    expect(f.market.quoteBuy).toHaveBeenCalledWith(f.market.usdg, f.market.weth, 900719925474099312345n)
    expect(q.amountIn).toBe('900719925474099312345')
    expect(q.minimumReceived).toBe('497500000000000')
    expect(q.priceImpactBps).toBeNull()
    expect(q.estimatedNetworkFeeWei).toBe('150000000000000')
    expect(q.expiresAt - q.createdAt).toBe(30000)
  })
  it.each(['0', '-1', '1.5', '1e18', '', '01', '9'.repeat(79), (1n << 256n).toString()])('rejects invalid base-unit amount %s', async amountIn => {
    const f = fixture()
    await expect(f.service.quote({ ...f.params, amountIn })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(f.market.quoteBuy).not.toHaveBeenCalled()
  })
  it('rejects chain, address, unknown fields and slippage mismatches before RPC', async () => {
    const f = fixture()
    for (const [overrides, code] of [[{ chainId: '1' }, 'CHAIN_MISMATCH'], [{ account: '0x0' }, 'INVALID_ADDRESS'], [{ slippageBps: '101' }, 'SLIPPAGE_CAP'], [{ slippageBps: '-1' }, 'INVALID_SLIPPAGE'], [{ slippageBps: '0.1' }, 'INVALID_SLIPPAGE'], [{ recipient: another }, 'UNEXPECTED_FIELD'], [{ tokenOut: f.market.usdg }, 'SAME_ASSET']] as const) await expect(f.service.quote({ ...f.params, ...overrides })).rejects.toMatchObject({ code })
    expect(f.market.quoteBuy).not.toHaveBeenCalled()
  })
  it('requires actual RPC chain identity', async () => {
    const f = fixture(); vi.mocked(f.market.client.public.getChainId).mockResolvedValue(1)
    await expect(f.service.quote(f.params)).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' })
  })
  it('does not turn discovery or operator stock eligibility into manual permission', async () => {
    const f = fixture()
    const stock = f.service.registry.list().find(x => x.type === 'stock-token')!
    expect(stock.tradable).toBe(false)
    f.market.client.acknowledgeStockTokenEligibility = true
    await expect(f.service.quote({ ...f.params, tokenOut: stock.address })).rejects.toMatchObject({ code: 'ASSET_NOT_ENABLED' })
    await expect(f.service.quote({ ...f.params, tokenOut: another })).rejects.toMatchObject({ code: 'ASSET_NOT_ENABLED' })
    const testnet = new Market({ ...config, network: 'testnet' })
    const service = new ManualSwapService(testnet, { chainId: 46630, maxSlippageBps: 100, isKilled: () => false, journal: f.journal })
    expect(service.registry.list().every(x => x.chainId === 46630 && x.type !== 'stock-token')).toBe(true)
  })
  it('rejects any signer-bearing Market client', () => {
    const f = fixture()
    Object.assign(f.market.client, { account: { address: another } })
    expect(() => new ManualSwapService(f.market, { chainId: 4663, maxSlippageBps: 100, isKilled: () => false, journal: f.journal })).toThrow('without an account or wallet')
  })
  it('fails closed when there is no liquid route or the provider returns inconsistent terms', async () => {
    const f = fixture(); vi.mocked(f.market.quoteBuy).mockResolvedValueOnce(null)
    await expect(f.service.quote(f.params)).rejects.toMatchObject({ code: 'NO_ROUTE' })
    vi.mocked(f.market.quoteBuy).mockResolvedValueOnce({ amountIn: 1n, amountOut: 10n, gasEstimate: 1n, route: { path: [], fees: [], encodedPath: '0x' } })
    await expect(f.service.quote(f.params)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_QUOTE' })
  })
  it('binds quote to account and rejects expired or unknown quotes', async () => {
    const f = fixture(); const q = await f.service.quote(f.params)
    await expect(f.service.prepare({ quoteId: q.quoteId, account: another })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
    await expect(f.service.prepare({ quoteId: 'missing', account })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' })
    f.advance(30000)
    await expect(f.service.prepare({ quoteId: q.quoteId, account })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
    expect(f.journal.recordDecision).not.toHaveBeenCalled()
  })
  it('ignores mutations to returned quote objects and accepts no caller-supplied calldata', async () => {
    const f = fixture(); const q = await f.service.quote(f.params)
    q.minimumReceived = '1'; q.route.path[1] = another; q.tokenOut.address = another
    const p = await f.service.prepare({ quoteId: q.quoteId, account })
    expect(p.minimumReceived).toBe('497500000000000')
    await expect(f.service.prepare({ quoteId: q.quoteId, account, data: '0x' })).rejects.toMatchObject({ code: 'UNEXPECTED_FIELD' })
  })
  it('builds exact approvals and canonical router calldata with the manual recipient', async () => {
    const f = fixture(); f.allowance(1n)
    const q = await f.service.quote(f.params); const p = await f.service.prepare({ quoteId: q.quoteId, account })
    expect(p.signing).toBe('user-wallet'); expect(p.approvals.map(a => a.amount)).toEqual(['0', '1000000'])
    expect(p.simulation).toBe('requires-approval'); expect(p.reQuoteAfterApproval).toBe(true)
    const approval = decodeFunctionData({ abi: erc20Abi, data: p.approvals[1]!.data })
    expect(approval.functionName).toBe('approve'); expect(approval.args).toEqual([f.market.addresses().router, 1000000n])
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: p.transaction.data })
    expect(outer.functionName).toBe('multicall')
    const calldata = (outer.args as readonly [bigint, readonly `0x${string}`[]])[1][0]!
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: calldata })
    expect(inner.functionName).toBe('exactInputSingle')
    expect(inner.args?.[0]).toMatchObject({ recipient: account, amountIn: 1000000n, amountOutMinimum: 497500000000000n, tokenOut: f.market.weth })
    expect(f.journal.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'hub:manual', kind: 'observe' }))
    expect(f.market.client.wallet).toBeNull()
  })
  it('preflights swap when allowance is sufficient, rejects low balance and failed simulation', async () => {
    const f = fixture(); f.allowance(1000000n)
    const q = await f.service.quote(f.params)
    expect((await f.service.prepare({ quoteId: q.quoteId, account })).simulation).toBe('passed')
    expect(f.market.client.public.estimateGas).toHaveBeenCalled()
    f.balance(1n)
    await expect(f.service.prepare({ quoteId: q.quoteId, account })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    f.balance(1000000n); vi.mocked(f.market.client.public.estimateGas).mockRejectedValue(new Error('revert'))
    await expect(f.service.prepare({ quoteId: q.quoteId, account })).rejects.toMatchObject({ code: 'SIMULATION_FAILED' })
  })
  it('honors kill before and during async requests, and expiry during preparation', async () => {
    const f = fixture(); const q = await f.service.quote(f.params); f.kill()
    await expect(f.service.quote(f.params)).rejects.toMatchObject({ code: 'KILLED' })
    await expect(f.service.prepare({ quoteId: q.quoteId, account })).rejects.toMatchObject({ code: 'KILLED' })
    const g = fixture(); const q2 = await g.service.quote(g.params); g.allowance(1000000n)
    vi.mocked(g.market.client.public.estimateGas).mockImplementation(async () => { g.kill(); return 1n })
    await expect(g.service.prepare({ quoteId: q2.quoteId, account })).rejects.toMatchObject({ code: 'KILLED' })
    const h = fixture(); const q3 = await h.service.quote(h.params); h.allowance(1000000n)
    vi.mocked(h.market.client.public.estimateGas).mockImplementation(async () => { h.advance(30001); return 1n })
    await expect(h.service.prepare({ quoteId: q3.quoteId, account })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  })
})

describe('HTTP adapter', () => {
  async function server() {
    const f = fixture()
    const fleet = { config, summary: () => ({ mode: 'paper', killed: false }) } as Fleet
    const handler = createHubHandler(fleet, f.service)
    const server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url!, 'http://localhost'))) { res.writeHead(404); res.end() } })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    return { ...f, base }
  }
  it('serves explicit capabilities and round-trips quote into an unsigned swap', async () => {
    const f = await server()
    const status = await fetch(f.base + '/api/status')
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toMatchObject({ capabilities: { manualBroadcast: false, stockTrading: false } })
    const q = await fetch(f.base + '/api/quote?' + new URLSearchParams(f.params)).then(r => r.json())
    const r = await fetch(f.base + '/api/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, account }) })
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ kind: 'wallet-transaction-plan', signing: 'user-wallet' })
  })
  it('rejects wrong methods, duplicate parameters, invalid JSON, cross-origin and oversized bodies', async () => {
    const f = await server()
    expect((await fetch(f.base + '/api/swap')).status).toBe(405)
    expect((await fetch(f.base + '/api/status', { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await fetch(f.base + '/api/quote?amountIn=1&amountIn=2')).status).toBe(400)
    expect((await fetch(f.base + '/api/swap', { method: 'POST', body: '{}' })).status).toBe(415)
    for (const body of ['{', '[]', 'null']) expect((await fetch(f.base + '/api/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(400)
    expect((await fetch(f.base + '/api/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(5000) }) })).status).toBe(413)
  })
  it('does not leak RPC credentials or raw exception details', async () => {
    const f = await server(); vi.mocked(f.market.client.public.getChainId).mockRejectedValue(new Error('private RPC secret-credential'))
    const result = await fetch(f.base + '/api/quote?' + new URLSearchParams(f.params))
    expect(result.status).toBe(503); expect(await result.text()).not.toContain('secret-credential')
  })
})
