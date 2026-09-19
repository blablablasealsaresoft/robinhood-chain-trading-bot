import { appendFileSync,copyFileSync,mkdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFleetConfig } from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { LaunchSniper } from './strategies/launch-sniper.js'
import { Momentum } from './strategies/momentum.js'
import { PremiumWatch } from './strategies/premium-watch.js'
import { ArbitrageMonitor } from './hub/arbitrage-monitor.js'
import { createHubHandler } from './server/hub.js'

const output=resolve(process.env.SHADOW_OUTPUT_DIR||'./data/shadow')
const durationMinutes=boundedInt(process.env.SHADOW_DURATION_MINUTES,55,1,180)
const snapshotSeconds=boundedInt(process.env.SHADOW_SNAPSHOT_SECONDS,60,15,300)
mkdirSync(output,{recursive:true})
const dbPath=join(output,'shadow.db')
const eventPath=join(output,'shadow-events.jsonl')

const base=loadFleetConfig()
const config={...base,network:'mainnet' as const,mode:'paper' as const,hasWallet:false,privateKey:undefined,dbPath}
const fleet=new Fleet(config)
fleet.addAgents([
  {id:'sniper-1',strategy:new LaunchSniper(),tickIntervalMs:4000},
  {id:'momentum-1',strategy:new Momentum(),tickIntervalMs:15000},
  // Stock Token eligibility remains authoritative. With the flag false, Premium Watch
  // still observes/alerts but does not invent acquisition intents.
  {id:'premium-1',strategy:new PremiumWatch({enableTrading:config.stockTokenEligible}),tickIntervalMs:30000},
])

const arbRepo=process.env.HUB_ARB_REPO||fileURLToPath(new URL('../../RobinHood-Arbitrage-Bot/',import.meta.url))
const arbitrage=new ArbitrageMonitor(arbRepo,fleet.journal,config.rpcUrl)
const handle=createHubHandler(fleet,undefined,{arbitrage})
let snapshotTimer:ReturnType<typeof setInterval>|null=null
let stopping=false
const startedAt=Date.now()

function writeEvent(type:string,data:unknown){
 appendFileSync(eventPath,JSON.stringify({at:Date.now(),type,data})+'\n','utf8')
}
function decisionSummary(id:string){
 const rows=fleet.journal.recentDecisions(id,200)
 const kinds:Record<string,number>={}
 const refusals:Record<string,number>={}
 for(const row of rows){
  kinds[row.kind]=(kinds[row.kind]||0)+1
  const reason=typeof row.meta?.reason==='string'?row.meta.reason:null
  if(row.kind==='refused'&&reason)refusals[reason]=(refusals[reason]||0)+1
 }
 return {recent:rows.length,kinds,refusals}
}
async function snapshot(){
 const [block,rpcChain]=await Promise.all([
  fleet.market.client.public.getBlockNumber().catch(()=>null),
  fleet.market.client.public.getChainId().catch(()=>null),
 ])
 const agents=fleet.agentStatuses().map(s=>({
  id:s.id,strategy:s.strategy,running:s.running,killed:s.killed,ticks:s.ticks,trades:s.trades,refusals:s.refusals,
  spentTodayUsd:s.spentTodayUsd,realizedUsd:s.realizedUsd,openValueUsd:s.openValueUsd,equityUsd:s.equityUsd,
  positions:s.positions.map(p=>({token:p.token,tokenSymbol:p.tokenSymbol,amount:p.amount.toString(),investedUsd:p.investedUsd,markUsd:p.markUsd,openedAt:p.openedAt})),
  decisions:decisionSummary(s.id),
 }))
 writeEvent('snapshot',{
  chainId:rpcChain,block:block?.toString()??null,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),
  agents,
  launchMonitor:{
   configured:!!process.env.HUB_LAUNCH_FACTORY,
   recentEvents:fleet.journal.externalEvents('launch',20,4663).map(e=>({id:e.id,source:e.source,status:e.status,token:e.data.token??null,at:e.at,observedAt:e.observedAt})),
  },
  arbitrage:arbitrage.status(),
 })
}
function summary(){
 const agents=fleet.agentStatuses().map(s=>{
  const trades=fleet.journal.recentTrades(s.id,500)
  return {
   id:s.id,strategy:s.strategy,ticks:s.ticks,trades:s.trades,refusals:s.refusals,realizedUsd:s.realizedUsd,openValueUsd:s.openValueUsd,equityUsd:s.equityUsd,
   decisions:decisionSummary(s.id),
   simulatedTrades:trades.map(t=>({ts:t.ts,side:t.side,token:t.token,tokenSymbol:t.tokenSymbol,quoteSymbol:t.quoteSymbol,amountIn:t.amountIn.toString(),amountOut:t.amountOut.toString(),reason:t.reason,slippageBps:t.slippageBps,meta:t.meta})),
   refinementReady:trades.length>=20,
   refinementNote:trades.length>=20?'Enough simulated fills for a parameter review; do not tune without forward-outcome analysis.':'Collect at least 20 simulated fills before proposing parameter changes.',
  }
 })
 return {
  version:1,mode:'shadow-mainnet',signing:false,broadcasting:false,startedAt,endedAt:Date.now(),durationMinutes:(Date.now()-startedAt)/60000,
  stockTokenEligibilityAcknowledged:config.stockTokenEligible,
  agents,
  monitors:{
   launch:{configured:!!process.env.HUB_LAUNCH_FACTORY,recentEvents:fleet.journal.externalEvents('launch',100,4663).length},
   arbitrage:arbitrage.status(),
  },
  guardrails:{privateKeyPresent:false,mode:config.mode,network:config.network},
 }
}
async function stop(reason:string){
 if(stopping)return
 stopping=true
 if(snapshotTimer)clearInterval(snapshotTimer)
 writeEvent('stopping',{reason})
 try{await snapshot()}catch(error){writeEvent('snapshot-error',{message:error instanceof Error?error.message:String(error)})}
 fleet.stop()
 try{await Promise.all([handle.stopObservations(),arbitrage.stop()])}catch(error){writeEvent('monitor-stop-error',{message:error instanceof Error?error.message:String(error)})}
 const report=summary()
 writeFileSync(join(output,'shadow-summary.json'),JSON.stringify(report,null,2))
 fleet.close()
 // WAL is checkpointed/closed before the artifact copy so committed rows cannot be stranded in -wal.
 try{copyFileSync(dbPath,join(output,'shadow-journal.sqlite'))}catch{}
 console.log(JSON.stringify({shadow:'complete',reason,output,agents:report.agents.map(a=>({id:a.id,trades:a.trades,refusals:a.refusals,equityUsd:a.equityUsd})),monitors:report.monitors},null,2))
}
async function main(){
 if(base.privateKey||base.hasWallet||base.mode==='live')console.warn('Shadow runner discarded live-signing configuration; no signer will be constructed.')
 const chain=await fleet.market.client.public.getChainId()
 if(chain!==4663)throw new Error('Shadow runner requires Robinhood Chain mainnet (4663).')
 writeEvent('started',{chainId:chain,durationMinutes,snapshotSeconds,agents:['sniper-1','momentum-1','premium-1'],stockTokenEligibilityAcknowledged:config.stockTokenEligible,arbitrageAvailable:arbitrage.available()})
 await fleet.start()
 handle.startObservations()
 if(arbitrage.available()){
  try{await arbitrage.start()}catch(error){writeEvent('arbitrage-start-error',{message:error instanceof Error?error.message:String(error)})}
 } else writeEvent('arbitrage-unavailable',{repository:arbRepo})
 await snapshot()
 snapshotTimer=setInterval(()=>{void snapshot().catch(error=>writeEvent('snapshot-error',{message:error instanceof Error?error.message:String(error)}))},snapshotSeconds*1000)
 snapshotTimer.unref?.()
 const timer=setTimeout(()=>void stop('duration-complete'),durationMinutes*60_000)
 process.once('SIGINT',()=>{clearTimeout(timer);void stop('SIGINT')})
 process.once('SIGTERM',()=>{clearTimeout(timer);void stop('SIGTERM')})
}
main().catch(async error=>{
 writeEvent('fatal',{message:error instanceof Error?error.message:String(error)})
 await stop('fatal').catch(()=>undefined)
 process.exitCode=1
})

function boundedInt(raw:string|undefined,fallback:number,min:number,max:number){
 if(raw===undefined||raw==='')return fallback
 const value=Number(raw)
 if(!Number.isInteger(value)||value<min||value>max)throw new Error('Shadow integer setting must be '+min+'-'+max)
 return value
}
