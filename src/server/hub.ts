import { hubHealth } from '../hub/health.js'
import { LaunchpadService } from '../hub/launchpad.js'
import { LaunchpadV2Service } from '../hub/launchpad-v2.js'
import { ForeverService } from '../hub/forever.js'
import { ForeverRewardsService } from '../hub/forever-rewards.js'
import { StreamAuthService } from '../hub/stream-auth.js'
import { BridgeObservations } from '../hub/bridge-observations.js'
import { NativeWrapService } from '../hub/native-wrap.js'
import { WalletReceipts } from '../hub/wallet-receipts.js'
import { isAddress, getAddress } from 'viem'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Fleet } from '../framework/fleet.js'
import { Market } from '../framework/market.js'
import { HubError, ManualSwapService } from '../hub/manual-swaps.js'
import { HubReadModel } from '../hub/read-model.js'
import { LaunchDiscovery } from '../hub/launch-discovery.js'
import type { ArbitrageMonitor } from '../hub/arbitrage-monitor.js'
import type { ReviewedTradeAsset } from '../hub/assets.js'
import { LiquidityService } from '../hub/liquidity.js'
import { MarketSeriesService } from '../hub/market-series.js'
import { MarketActivityService } from '../hub/market-activity.js'
import { MarketDepthService } from '../hub/market-depth.js'
import { StockCompliancePolicy } from '../hub/stock-compliance.js'
import { shadowStatus } from '../hub/shadow-status.js'

export function createHubHandler(fleet: Fleet, service?: ManualSwapService, options: {arbitrage?: ArbitrageMonitor; llmConfigurationError?: boolean; receipts?:WalletReceipts; reviewedAssets?:ReviewedTradeAsset[]; operatorToken?:string} = {}) {
  const market = new Market(fleet.config)
  const stockCompliance=new StockCompliancePolicy(process.env.HUB_STOCK_COMPLIANCE_ATTESTATIONS)
  const swaps = service ?? new ManualSwapService(market, {
    chainId: fleet.config.network === 'testnet' ? 46630 : 4663,
    maxSlippageBps: fleet.config.defaultLimits.maxSlippageBps,
    isKilled: () => fleet.kill.isKilled(), journal: fleet.journal, reviewedAssets:options.reviewedAssets,stockCompliance,
  })
  const read = new HubReadModel(fleet, market, swaps.registry,stockCompliance)
  const discovery = new LaunchDiscovery(market,swaps.registry,fleet.journal)
  const bridges=new BridgeObservations(market,fleet.journal)
  const wraps=new NativeWrapService(market,{chainId:swaps.registry.chainId,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal})
  const liquidity=new LiquidityService(market,swaps.registry,{chainId:swaps.registry.chainId,maxSlippageBps:fleet.config.defaultLimits.maxSlippageBps,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal})
  const marketSeries=new MarketSeriesService(market,swaps.registry,fleet.journal)
  const marketActivity=new MarketActivityService(market,swaps.registry,fleet.journal)
  const marketDepth=new MarketDepthService(market,swaps.registry)
  const receipts=options.receipts ?? new WalletReceipts(market,fleet.journal,swaps.registry.chainId)
  const factory=process.env.HUB_LAUNCH_FACTORY||process.env.HUB_LAUNCH_FACTORY_ADDRESS
  if(process.env.HUB_LAUNCH_FACTORY&&process.env.HUB_LAUNCH_FACTORY_ADDRESS&&process.env.HUB_LAUNCH_FACTORY.toLowerCase()!==process.env.HUB_LAUNCH_FACTORY_ADDRESS.toLowerCase())throw new Error('Conflicting Hub factory configuration')
  const launchpad=new LaunchpadService(market,{chainId:swaps.registry.chainId,factory,deploymentBlock:process.env.HUB_LAUNCH_FACTORY_BLOCK,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal,registry:swaps.registry})
  const launchpadV2=new LaunchpadV2Service(market,{chainId:swaps.registry.chainId,factory:process.env.HUB_LAUNCH_FACTORY_V2,deploymentBlock:process.env.HUB_LAUNCH_FACTORY_V2_BLOCK,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal,registry:swaps.registry})
  const forever=new ForeverService(market,{chainId:swaps.registry.chainId,factory:process.env.HUB_FOREVER_FACTORY,deploymentBlock:process.env.HUB_FOREVER_FACTORY_BLOCK,isKilled:()=>fleet.kill.isKilled(),journal:fleet.journal})
  const streamAuth=new StreamAuthService(fleet.journal,{chainId:swaps.registry.chainId,forever})
  const foreverEpochOperator=process.env.HUB_FOREVER_EPOCH_OPERATOR
  const foreverRewards=foreverEpochOperator&&/^0x[0-9a-fA-F]{40}$/.test(foreverEpochOperator)
    ? new ForeverRewardsService(market,{chainId:swaps.registry.chainId,journal:fleet.journal,epochOperator:foreverEpochOperator as `0x${string}`,streamAuth})
    : null
  receipts.observeWith(async event=>{await launchpad.observeWallet(event);await launchpadV2.observeWallet(event)})
  const controlToken = randomUUID()
  const controls = fleet.config.mode === 'paper' && !fleet.config.privateKey
  const operatorToken=validateOperatorToken(options.operatorToken)
  const authorizedControl=(req:IncomingMessage)=>{
    if(!controls)return false
    const preview=req.headers['x-hub-control']
    if(!operatorToken&&typeof preview==='string'&&preview===controlToken)return true
    if(!operatorToken)return false
    const auth=req.headers.authorization
    if(typeof auth!=='string'||!auth.startsWith('Bearer '))return false
    return secretEqual(auth.slice(7),operatorToken)
  }
  const handle=async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!/^\/api\/(status|health|shadow\/status|assets|market\/(?:series|activity|depth)|quote|swap|wrap|liquidity(?:\/prepare)?|launches|launchpad(?:\/(?:sales|prepare))?|launchpad-v2(?:\/(?:sales|prepare))?|forever(?:\/(?:prepare|vaults))?|stream\/(?:challenge|publish-token|viewer-token|session)|forever-community\/(?:attest\/(?:viewer|social)|epoch\/(?:prepare|confirm|allocation)|campaigns?|exclude)|stream\/webhook\/livekit|portfolio(?:\/history)?|positions|activity(?:\/verify)?|bridges\/verify|risk|kill|strategies(?:\/[^/]+(?:\/(?:start|stop))?)?|stocks\/[^/]+)$/.test(url.pathname)) return false
    try {
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) throw new HubError(403, 'ORIGIN_NOT_ALLOWED', 'Use the configured same-origin Hub API proxy.')
      const path = url.pathname
      if (path === '/api/status' && req.method === 'GET') {
        const summary = fleet.summary()
        respond(res, 200, { apiVersion: 1, chainId: swaps.registry.chainId, mode: summary.mode, killed: summary.killed, controlToken: controls && !operatorToken ? controlToken : null,
          operatorAuthConfigured: !!operatorToken, operatorAuthenticated: !!operatorToken && authorizedControl(req),
          capabilities: { quote: true, manualSwapPreparation: true, manualBroadcast: false, marketSeries: true, realSwapCandles: true, marketDepth: true, nativeWrap: true, walletReceiptVerification: true, bridgeObservation: true, launchJournal: true, launchpad: true, portfolio: true, stockPricing: true, stockTrading: swaps.registry.chainId===4663, stockAcquisition: swaps.registry.chainId===4663 && !!market.client.acknowledgeStockTokenEligibility && stockCompliance.configured, stockAcquisitionWalletScoped:true, manualLiquidityPreparation: swaps.registry.chainId===4663, strategyControl: controls } })
      } else if (path === '/api/health' && req.method === 'GET') {
        const report=await hubHealth(fleet,swaps.registry.chainId,options.arbitrage)
        respond(res,report.ok?200:503,report)
      } else if(path==='/api/shadow/status' && req.method==='GET') {
        respond(res,200,shadowStatus(process.env.SHADOW_STATUS_DIR))
      } else if (path === '/api/assets' && req.method === 'GET') {
        respond(res, 200, { chainId: swaps.registry.chainId, assets: swaps.registry.list() })
      } else if(path==='/api/market/series' && req.method==='GET') {
        const allowed=new Set(['asset','symbol','hours','limit'])
        for(const key of url.searchParams.keys())if(!allowed.has(key))throw new HubError(400,'UNEXPECTED_PARAMETER','Market series request contains unsupported parameters.')
        for(const key of allowed)if(url.searchParams.getAll(key).length>1)throw new HubError(400,'DUPLICATE_PARAMETER','Market series parameters must not be repeated.')
        const rawHours=url.searchParams.get('hours'),rawLimit=url.searchParams.get('limit')
        respond(res,200,await marketSeries.read({asset:url.searchParams.get('asset'),symbol:url.searchParams.get('symbol'),hours:rawHours===null?undefined:Number(rawHours),limit:rawLimit===null?undefined:Number(rawLimit)}))
      } else if(path==='/api/market/activity' && req.method==='GET') {
        const allowed=new Set(['asset','hours','interval','limit'])
        for(const key of url.searchParams.keys())if(!allowed.has(key))throw new HubError(400,'UNEXPECTED_PARAMETER','Market activity request contains unsupported parameters.')
        for(const key of allowed)if(url.searchParams.getAll(key).length>1)throw new HubError(400,'DUPLICATE_PARAMETER','Market activity parameters must not be repeated.')
        const rawHours=url.searchParams.get('hours'),rawInterval=url.searchParams.get('interval'),rawLimit=url.searchParams.get('limit')
        respond(res,200,await marketActivity.read({asset:url.searchParams.get('asset'),hours:rawHours===null?undefined:Number(rawHours),intervalSeconds:rawInterval===null?undefined:Number(rawInterval),tradeLimit:rawLimit===null?undefined:Number(rawLimit)}))
      } else if(path==='/api/market/depth' && req.method==='GET') {
        if(url.searchParams.getAll('asset').length!==1||[...url.searchParams.keys()].some(k=>k!=='asset'))throw new HubError(400,'INVALID_QUERY','Supply exactly one asset parameter.')
        respond(res,200,await marketDepth.read(url.searchParams.get('asset')))
      } else if(path === '/api/liquidity' && req.method === 'GET') {
        if(url.searchParams.getAll('token').length!==1||[...url.searchParams.keys()].some(k=>k!=='token'))throw new HubError(400,'INVALID_QUERY','Supply exactly one token parameter.')
        respond(res,200,await liquidity.inspect(url.searchParams.get('token')))
      } else if(path === '/api/liquidity/prepare' && req.method === 'POST') {
        respond(res,200,await liquidity.prepare(await readBody(req)))
      } else if(path === '/api/launchpad' && req.method === 'GET') {
        respond(res,200,await launchpad.status())
      } else if(path === '/api/launchpad/sales' && req.method === 'GET') {
        respond(res,200,await launchpad.list(url.searchParams.get('account')))
      } else if(path === '/api/launchpad/prepare' && req.method === 'POST') {
        respond(res,200,await launchpad.prepare(await readBody(req)))
      } else if (path === '/api/launchpad-v2' && req.method === 'GET') {
        respond(res,200,await launchpadV2.status())
      } else if (path === '/api/launchpad-v2/sales' && req.method === 'GET') {
        respond(res,200,await launchpadV2.list(url.searchParams.get('account')))
      } else if (path === '/api/launchpad-v2/prepare' && req.method === 'POST') {
        respond(res,200,await launchpadV2.prepare(await readBody(req)))
      } else if (path === '/api/stream/challenge' && req.method === 'POST') {
        respond(res,200,await streamAuth.challenge(await readBody(req)))
      } else if (path === '/api/stream/publish-token' && req.method === 'POST') {
        respond(res,200,await streamAuth.publishToken(await readBody(req)))
      } else if (path === '/api/stream/viewer-token' && req.method === 'POST') {
        respond(res,200,await streamAuth.viewerToken(await readBody(req)))
      } else if (path === '/api/stream/session' && req.method === 'GET') {
        respond(res,200,streamAuth.session(url.searchParams.get('vaultId'),url.searchParams.get('address')))
      } else if (path === '/api/forever-community/attest/viewer' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable viewer/social reward attestation.')
        respond(res,200,foreverRewards.recordViewerAttestation(await readBody(req)))
      } else if (path === '/api/forever-community/attest/social' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable viewer/social reward attestation.')
        respond(res,200,foreverRewards.recordSocialAttestation(await readBody(req)))
      } else if (path === '/api/forever-community/epoch/prepare' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable participation reward attestation.')
        if(!authorizedControl(req))throw new HubError(403,'OPERATOR_AUTH_REQUIRED','Committing a reward epoch requires an authenticated operator session.')
        const body=await readBody(req)
        if(typeof body.vault!=='string'||typeof body.potWei!=='string')throw new HubError(400,'INVALID_EPOCH_REQUEST','Provide vault and potWei.')
        respond(res,200,await foreverRewards.prepareEpoch(body.vault as `0x${string}`,body.potWei))
      } else if (path === '/api/forever-community/epoch/confirm' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable participation reward attestation.')
        if(!authorizedControl(req))throw new HubError(403,'OPERATOR_AUTH_REQUIRED','Confirming a reward epoch requires an authenticated operator session.')
        const body=await readBody(req)
        if(typeof body.vault!=='string'||!isAddress(body.vault)||typeof body.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(body.hash))throw new HubError(400,'INVALID_CONFIRM_REQUEST','Provide vault and a transaction hash.')
        respond(res,200,await foreverRewards.observeEpochCommit(getAddress(body.vault),body.hash as `0x${string}`))
      } else if (path === '/api/forever-community/epoch/allocation' && req.method === 'GET') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable participation reward attestation.')
        const vault=url.searchParams.get('vault'),root=url.searchParams.get('root')
        if(!vault||!isAddress(vault)||!root)throw new HubError(400,'INVALID_QUERY','Supply vault and root.')
        respond(res,200,foreverRewards.getAllocation(getAddress(vault),root))
      } else if (path === '/api/forever-community/campaigns' && req.method === 'GET') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable viewer/social reward attestation.')
        const vault=url.searchParams.get('vault')
        if(!vault||!isAddress(vault))throw new HubError(400,'INVALID_QUERY','Supply vault.')
        respond(res,200,{vault,campaigns:foreverRewards.listCampaigns(getAddress(vault))})
      } else if (path === '/api/forever-community/campaigns' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable viewer/social reward attestation.')
        if(!authorizedControl(req))throw new HubError(403,'OPERATOR_AUTH_REQUIRED','Creating a campaign requires an authenticated operator session.')
        respond(res,200,foreverRewards.createCampaign(await readBody(req)))
      } else if (path === '/api/forever-community/exclude' && req.method === 'POST') {
        if(!foreverRewards)throw new HubError(503,'FOREVER_REWARDS_NOT_CONFIGURED','Set HUB_FOREVER_EPOCH_OPERATOR to enable viewer/social reward attestation.')
        if(!authorizedControl(req))throw new HubError(403,'OPERATOR_AUTH_REQUIRED','Excluding an account requires an authenticated operator session.')
        respond(res,200,foreverRewards.excludeAccount(await readBody(req)))
      } else if (path === '/api/stream/webhook/livekit' && req.method === 'POST') {
        const raw=await readRawBody(req)
        if(!streamAuth.verifyWebhookSignature(raw,req.headers['x-livekit-signature'] as string|undefined))throw new HubError(401,'BAD_WEBHOOK_SIGNATURE','LiveKit webhook signature did not verify.')
        let payload:{event?:string;room?:{name?:string};participant?:{identity?:string}}
        try{payload=JSON.parse(raw)}catch{throw new HubError(400,'INVALID_JSON','Webhook body is not valid JSON.')}
        respond(res,200,streamAuth.handleLiveKitEvent(payload))
      } else if(path === '/api/forever' && req.method === 'GET') {
        respond(res,200,await forever.status())
      } else if(path === '/api/forever/vaults' && req.method === 'GET') {
        const allowed=new Set(['account'])
        for(const key of url.searchParams.keys())if(!allowed.has(key))throw new HubError(400,'UNEXPECTED_PARAMETER','Forever vault snapshot does not accept this parameter.')
        if(url.searchParams.getAll('account').length>1)throw new HubError(400,'DUPLICATE_PARAMETER','account must not be repeated.')
        respond(res,200,await forever.list(url.searchParams.get('account')))
      } else if(path === '/api/forever/prepare' && req.method === 'POST') {
        respond(res,200,await forever.prepare(await readBody(req)))
      } else if (path === '/api/launches' && req.method === 'GET') {
        const [sdkResult,hubResult,v2Result]=await Promise.allSettled([discovery.recent(),launchpad.recent(),launchpadV2.recent()])
        if(sdkResult.status==='rejected'&&hubResult.status==='rejected'&&v2Result.status==='rejected')throw sdkResult.reason
        const sdk=sdkResult.status==='fulfilled'?sdkResult.value as {launches:Array<{blockNumber:string|bigint}>}:null
        const local=hubResult.status==='fulfilled'?hubResult.value:[]
        const v2=v2Result.status==='fulfilled'?v2Result.value:[]
        const launches=[...local,...v2,...(sdk?.launches??[])].sort((a,b)=>BigInt(String(a.blockNumber))>BigInt(String(b.blockNumber))?-1:BigInt(String(a.blockNumber))<BigInt(String(b.blockNumber))?1:0).slice(0,48)
        respond(res,200,{chainId:swaps.registry.chainId,observedAt:Date.now(),lookbackBlocks:'30000',source:'hoodchain + Hub LaunchFactory + LaunchFactoryV2',launches,
          incomplete:sdkResult.status==='rejected'||hubResult.status==='rejected'||v2Result.status==='rejected',
          coverage:'Recent SDK launches and configured Hub V1/V2 sales. Unavailable sources are marked partial; discovery never grants trading permission.'})
      } else if (path === '/api/portfolio' && req.method === 'GET') {
        respond(res, 200, await read.portfolio(url.searchParams.get('account')))
      } else if (path === '/api/portfolio/history' && req.method === 'GET') {
        respond(res,200,read.portfolioHistory(url.searchParams.get('account'),Number(url.searchParams.get('hours')??24),Number(url.searchParams.get('limit')??288)))
      } else if (path === '/api/positions' && req.method === 'GET') {
        respond(res, 200, { positions: read.positions(), scope: fleet.config.mode === 'paper' ? 'persisted-paper-state' : 'current-process', mode: fleet.config.mode })
      } else if (path === '/api/activity' && req.method === 'GET') {
        const account=url.searchParams.get('account')
        if(account!==null){
          const allowed=new Set(['account','limit','cursor'])
          for(const key of url.searchParams.keys())if(!allowed.has(key))throw new HubError(400,'UNEXPECTED_PARAMETER','Activity request contains unsupported parameters.')
          for(const key of allowed)if(url.searchParams.getAll(key).length>1)throw new HubError(400,'DUPLICATE_PARAMETER','Activity query parameters must not be repeated.')
          const rawLimit=url.searchParams.get('limit')
          const limit=rawLimit===null?50:Number(rawLimit)
          respond(res,200,read.activityPage(account,limit,url.searchParams.get('cursor')))
        } else {
          if(operatorToken&&!authorizedControl(req))throw new HubError(403,'OPERATOR_AUTH_REQUIRED','Operator authentication is required for the global Activity feed.')
          respond(res, 200, { events: read.activity(), scope:'operator-global', nextCursor:null })
        }
      } else if (path === '/api/risk' && req.method === 'GET') {
        respond(res, 200, { ...fleet.summary(), limits: fleet.config.defaultLimits, stockTradingEnabled: swaps.registry.chainId===4663, stockAcquisitionEnabled: swaps.registry.chainId===4663&&fleet.config.stockTokenEligible&&stockCompliance.configured, stockAcquisitionWalletScoped:true, scope: 'primary-fleet-and-owned-monitor', arbitrageMonitorStopped: options.arbitrage ? !options.arbitrage.status().running : null, onchainExecutorPaused: null })
      } else if (path.startsWith('/api/stocks/') && req.method === 'GET') {
        if([...url.searchParams.keys()].length)throw new HubError(400,'INVALID_QUERY','Stock Token detail does not accept query parameters.')
        respond(res, 200, await read.stock(decodeURIComponent(path.split('/')[3]!)))
      } else if (path.startsWith('/api/strategies') && req.method === 'GET') {
        const strategies = read.strategies()
        if (path === '/api/strategies') respond(res, 200, { strategies, services: [
          launchpad.monitorStatus(),
          ...(strategies.some(s=>s.strategy==='llm-strategist') ? [] : [{ id: 'llm', name: 'LLM strategist', status: options.llmConfigurationError?'configuration-error':'not-configured', detail: 'Uses the existing provider configuration. Set HOOD_LLM_PROVIDER and HOOD_LLM_API_KEY on the backend to make this strategy available.' }]),
          options.arbitrage?.status() ?? { id: 'arbitrage', name: 'RobinFun / Uniswap v4 arbitrage', status: 'not-connected', detail: 'The separate worker adapter is not configured for this service.' },
        ] })
        else if(path === '/api/strategies/launch-monitor') respond(res,200,{service:launchpad.monitorStatus()})
        else if(path === '/api/strategies/arbitrage' && options.arbitrage) respond(res,200,{service:options.arbitrage.status()})
        else {
          const strategy = strategies.find(a => a.id === path.split('/')[3])
          if (!strategy || path.split('/').length !== 4) throw new HubError(404, 'UNKNOWN_STRATEGY', 'Strategy not found.')
          respond(res, 200, { strategy })
        }
      } else if ((path === '/api/kill' || /^\/api\/strategies\/[^/]+\/(start|stop)$/.test(path)) && req.method === 'POST') {
        if (!authorizedControl(req)) throw new HubError(403, 'CONTROL_DISABLED', operatorToken ? 'An authenticated operator session is required.' : 'A local paper-control session is required. Live control is not enabled.')
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
  return Object.assign(handle,{startObservations:()=>{bridges.start();discovery.start();launchpad.start();launchpadV2.start()},stopObservations:async()=>{await Promise.all([bridges.stop(),discovery.stop(),launchpad.stop(),launchpadV2.stop()])}})
}
export function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value))
}
async function readRawBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length']) > 16384) throw new HubError(413, 'BODY_TOO_LARGE', 'Webhook body exceeds 16384 bytes.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 16384) throw new HubError(413, 'BODY_TOO_LARGE', 'Webhook body exceeds 16384 bytes.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
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

function validateOperatorToken(value:string|undefined):string|undefined {
  if(value===undefined||value==='')return undefined
  if(value.length<32||value.length>256||/[\r\n]/.test(value))throw new Error('HUB_OPERATOR_TOKEN must be 32-256 characters without line breaks')
  return value
}
function secretEqual(value:string,expected:string):boolean {
  const a=Buffer.from(value),b=Buffer.from(expected)
  return a.length===b.length&&timingSafeEqual(a,b)
}
