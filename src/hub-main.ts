import { WalletReceipts } from './hub/wallet-receipts.js'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadFleetConfig, loadLlmConfig, loadLlmMinConfidence } from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { LaunchSniper } from './strategies/launch-sniper.js'
import { Momentum } from './strategies/momentum.js'
import { PremiumWatch } from './strategies/premium-watch.js'
import { LlmStrategist } from './strategies/llm-strategist.js'
import { ArbitrageMonitor } from './hub/arbitrage-monitor.js'
import { createHubHandler, respond } from './server/hub.js'

// Keep user-wallet preparation and autonomous execution on separate signing paths.
const config = { ...loadFleetConfig(), mode: 'paper' as const, privateKey: undefined, hasWallet: false }
const fleet = new Fleet(config)
fleet.addAgents([
  { id: 'sniper-1', strategy: new LaunchSniper(), tickIntervalMs: 4000 },
  { id: 'momentum-1', strategy: new Momentum(), tickIntervalMs: 15000 },
  { id: 'premium-1', strategy: new PremiumWatch(), tickIntervalMs: 30000 },
])
let llmConfigurationError=false
try {
  const llm=loadLlmConfig()
  if(llm)fleet.addAgents([{id:'llm-1',strategy:new LlmStrategist({llm,minConfidence:loadLlmMinConfidence()}),tickIntervalMs:20000}])
} catch { llmConfigurationError=true }
const arbitrage=config.network==='mainnet' ? new ArbitrageMonitor(process.env.HUB_ARB_REPO || fileURLToPath(new URL('../../RobinHood-Arbitrage-Bot/',import.meta.url)),fleet.journal,config.rpcUrl) : undefined
fleet.kill.onKill(()=>{void arbitrage?.stop().catch(()=>console.error('Arbitrage monitor termination was not acknowledged.'))})
fleet.kill.arm()
const receipts=new WalletReceipts(fleet.market,fleet.journal,config.network==='testnet'?46630:4663)
receipts.start()
const handle = createHubHandler(fleet,undefined,{arbitrage,llmConfigurationError,receipts})
handle.startObservations()
const server = createServer(async (req, res) => {
  if (!await handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) respond(res,404,{error:{code:'NOT_AVAILABLE',message:'Unknown Hub API endpoint.'}})
})
server.requestTimeout=15000
server.listen(config.dashboardPort,'127.0.0.1',()=>console.log('Hub API: http://127.0.0.1:'+config.dashboardPort+'; paper strategies and arbitrage monitor stopped until requested'))
let closing=false
async function close() {
 if(closing)return
 closing=true;fleet.stop()
 const drained=new Promise<void>(resolve=>server.close(()=>resolve()))
 server.closeIdleConnections()
 try { await Promise.all([arbitrage?.stop(),receipts.stop(),handle.stopObservations(),drained]) } finally { fleet.close() }
}
process.once('SIGINT',()=>void close())
process.once('SIGTERM',()=>void close())
