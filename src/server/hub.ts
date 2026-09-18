import { BridgeObservations } from '../hub/bridge-observations.js'
import { NativeWrapService } from '../hub/native-wrap.js'
import { WalletReceipts } from '../hub/wallet-receipts.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Fleet } from '../framework/fleet.js'
import { Market } from '../framework/market.js'
import { HubError, ManualSwapService } from '../hub/manual-swaps.js'
import { HubReadModel } from '../hub/read-model.js'
import { LaunchDiscovery } from '../hub/launch-discovery.js'
import type { ArbitrageMonitor } from '../hub/arbitrage-monitor.js'

export function createHubHandler(fleet: Fleet, service?: ManualSwapService, options: {arbitrage?: ArbitrageMonitor; llmConfigurationError?: boolean; receipts?:WalletReceipts} = {}) {
  const market = new Market(fleet.config)
  const swaps = service ?? new ManualSwapService(market, {
    chainId: fleet.config.network === 'testnet' ? 46630 : 4663,
    maxSlippageBps: fleet.config.defaultLimits.maxSlippageBps,
    isKilled: () => fleet.kill.isKilled(), journal: fleet.journal,
  })
  const read = new HubReadModel(fleet, market, swaps.registry)
  const discovery = new LaunchDiscovery(market,swaps.registry,fleet.journal)
  const bridges=new BridgeObservations(market,fleet.journal)
  const wraps=new NativeWrapService(market,{chainId:swaps.registry.chainId,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal})
  const receipts=options.receipts ?? new WalletReceipts(market,fleet.journal,swaps.registry.chainId)
  const controlToken = randomUUID()
  const controls = fleet.config.mode === 'paper' && !fleet.config.privateKey
  const handle=async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!/^\/api\/(status|assets|quote|swap|wrap|launches|portfolio|positions|activity(?:\/verify)?|bridges\/verify|risk|kill|strategies(?:\/[^/]+(?:\/(?:start|stop))?)?|stocks\/[^/]+)$/.test(url.pathname)) return false
    try {
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) throw new HubError(403, 'ORIGIN_NOT_ALLOWED', 'Use the configured same-origin Hub API proxy.')
      const path = url.pathname
      if (path === '/api/status' && req.method === 'GET') {
        const summary = fleet.summary()
        respond(res, 200, { apiVersion: 1, chainId: swaps.registry.chainId, mode: summary.mode, killed: summary.killed, controlToken: controls ? controlToken : null,
          capabilities: { quote: true, manualSwapPreparation: true, manualBroadcast: false, nativeWrap: true, walletReceiptVerification: true, bridgeObservation: true, launchJournal: true, portfolio: true, stockPricing: true, stockTrading: false, strategyControl: controls } })
      } else if (path === '/api/assets' && req.method === 'GET') {
        respond(res, 200, { chainId: swaps.registry.chainId, assets: swaps.registry.list() })
      } else if (path === '/api/launches' && req.method === 'GET') {
        respond(res,200,await discovery.recent())
      } else if (path === '/api/portfolio' && req.method === 'GET') {
        respond(res, 200, await read.portfolio(url.searchParams.get('account')))
      } else if (path === '/api/positions' && req.method === 'GET') {
        respond(res, 200, { positions: read.positions(), scope: 'current-process', mode: fleet.config.mode })
      } else if (path === '/api/activity' && req.method === 'GET') {
        respond(res, 200, { events: read.activity() })
      } else if (path === '/api/risk' && req.method === 'GET') {
        respond(res, 200, { ...fleet.summary(), limits: fleet.config.defaultLimits, stockTradingEnabled: false, scope: 'primary-fleet-and-owned-monitor', arbitrageMonitorStopped: options.arbitrage ? !options.arbitrage.status().running : null, onchainExecutorPaused: null })
      } else if (path.startsWith('/api/stocks/') && req.method === 'GET') {
        respond(res, 200, await read.stock(decodeURIComponent(path.split('/')[3]!)))
      } else if (path.startsWith('/api/strategies') && req.method === 'GET') {
        const strategies = read.strategies()
        if (path === '/api/strategies') respond(res, 200, { strategies, services: [
          ...(strategies.some(s=>s.strategy==='llm-strategist') ? [] : [{ id: 'llm', name: 'LLM strategist', status: options.llmConfigurationError?'configuration-error':'not-configured', detail: 'Uses the existing provider configuration. Set HOOD_LLM_PROVIDER and HOOD_LLM_API_KEY on the backend to make this strategy available.' }]),
          options.arbitrage?.status() ?? { id: 'arbitrage', name: 'RobinFun / Uniswap v4 arbitrage', status: 'not-connected', detail: 'The separate worker adapter is not configured for this service.' },
        ] })
        else if(path === '/api/strategies/arbitrage' && options.arbitrage) respond(res,200,{service:options.arbitrage.status()})
        else {
          const strategy = strategies.find(a => a.id === path.split('/')[3])
          if (!strategy || path.split('/').length !== 4) throw new HubError(404, 'UNKNOWN_STRATEGY', 'Strategy not found.')
          respond(res, 200, { strategy })
        }
      } else if ((path === '/api/kill' || /^\/api\/strategies\/[^/]+\/(start|stop)$/.test(path)) && req.method === 'POST') {
        if (!controls || req.headers['x-hub-control'] !== controlToken) throw new HubError(403, 'CONTROL_DISABLED', 'A local paper-control session is required. Live control is not enabled.')
        const body = await readBody(req)
        if (Object.keys(body).length) throw new HubError(400, 'UNEXPECTED_FIELD', 'This control accepts an empty JSON object.')
        if (path === '/api/kill') { fleet.tripKill('Hub operator halted the paper fleet'); fleet.stop(); await options.arbitrage?.stop(); respond(res, 200, { killed: true, scope: 'primary-fleet-and-owned-monitor', arbitrageMonitorStopped: options.arbitrage ? !options.arbitrage.status().running : null }) }
        else {
          const [, , , id, action] = path.split('/')
          if (id==='arbitrage' && options.arbitrage) {
            if(action==='start' && fleet.kill.isKilled())throw new HubError(409,'HALTED','The primary kill switch is active.')
            if(action==='start') { await read.checkChain(); if(fleet.kill.isKilled())throw new HubError(409,'HALTED','The primary kill switch is active.'); await options.arbitrage.start() } else await options.arbitrage.stop()
            respond(res,200,{service:options.arbitrage.status()})
            return true
          }
          if (!fleet.agentStatuses().some(a => a.id === id)) throw new HubError(404, 'UNKNOWN_STRATEGY', 'Strategy not found.')
          if (action === 'start' && fleet.kill.isKilled()) throw new HubError(409, 'HALTED', 'The kill switch is active. Restart the local service to re-arm.')
          await fleet.controlPaperAgent(id!, action as 'start' | 'stop')
          respond(res, 200, { strategy: read.strategies().find(a => a.id === id) })
        }
      } else if (path === '/api/quote' && req.method === 'GET') {
        const input: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(input, key)) throw new HubError(400, 'DUPLICATE_PARAMETER', 'Query parameters must not be repeated.')
          input[key] = value
        }
        respond(res, 200, await swaps.quote(input))
      } else if(path === '/api/bridges/verify' && req.method === 'POST') {
        if(swaps.registry.chainId!==4663)throw new HubError(422,'BRIDGE_NETWORK','Bridge tracking requires the mainnet Hub.')
        respond(res,200,{event:await bridges.verify(await readBody(req))})
      } else if(path === '/api/wrap' && req.method === 'POST') {
        respond(res,200,await wraps.prepare(await readBody(req)))
      } else if(path === '/api/activity/verify' && req.method === 'POST') {
        respond(res,200,{event:await receipts.verify(await readBody(req))})
      } else if (path === '/api/swap' && req.method === 'POST') {
        respond(res, 200, await swaps.prepare(await readBody(req)))
      } else respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } })
    } catch (error) {
      const known = error instanceof HubError
      respond(res, known ? error.status : 503, { error: { code: known ? error.code : 'UPSTREAM_UNAVAILABLE', message: known ? error.message : 'The Hub could not complete this request. Retry after checking the service and RPC.' } })
    }
    return true
  }
  return Object.assign(handle,{startObservations:()=>{bridges.start();discovery.start()},stopObservations:async()=>{await Promise.all([bridges.stop(),discovery.stop()])}})
}
export function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value))
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HubError(415, 'CONTENT_TYPE', 'Use application/json.')
  if (Number(req.headers['content-length']) > 4096) throw new HubError(413, 'BODY_TOO_LARGE', 'Request body exceeds 4096 bytes.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 4096) throw new HubError(413, 'BODY_TOO_LARGE', 'Request body exceeds 4096 bytes.')
    chunks.push(Buffer.from(chunk))
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body as Record<string, unknown>
  } catch { throw new HubError(400, 'INVALID_JSON', 'Provide a JSON object.') }
}
