import { loadFleetConfig,loadLiveAutomationConfig } from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { LaunchSniper } from './strategies/launch-sniper.js'
import { Momentum } from './strategies/momentum.js'
import { PremiumWatch } from './strategies/premium-watch.js'

const HARD={fleetDaily:50,agentDaily:25,position:10,slippageBps:100,minCooldownSeconds:60}

function requireControlledConfig(){
  const base=loadFleetConfig()
  const live=loadLiveAutomationConfig()
  const liveDb=process.env.HUB_LIVE_AUTOMATION_DB?.trim()
  if(!liveDb)throw new Error('HUB_LIVE_AUTOMATION_DB is required so live signer state is isolated from the Hub Journal.')
  const config={...base,dbPath:liveDb}
  if(!live.enabled)throw new Error('Controlled live automation is disabled. Set HUB_LIVE_AUTOMATION=I_UNDERSTAND_REAL_FUNDS explicitly.')
  if(config.mode!=='live'||!config.hasWallet||!config.privateKey)throw new Error('Controlled live automation requires HOOD_TRADERS_LIVE=1 and a valid dedicated ROBINHOOD_CHAIN_PRIVATE_KEY.')
  if(config.fleetMaxDailySpendUsdg<=0||config.fleetMaxDailySpendUsdg>HARD.fleetDaily)throw new Error('FLEET_MAX_DAILY_SPEND_USDG must be >0 and <= '+HARD.fleetDaily+' for controlled live automation.')
  if(config.defaultLimits.maxDailySpendUsdg<=0||config.defaultLimits.maxDailySpendUsdg>HARD.agentDaily)throw new Error('AGENT_MAX_DAILY_SPEND_USDG must be >0 and <= '+HARD.agentDaily+'.')
  if(config.defaultLimits.maxPositionUsdg<=0||config.defaultLimits.maxPositionUsdg>HARD.position)throw new Error('AGENT_MAX_POSITION_USDG must be >0 and <= '+HARD.position+'.')
  if(config.defaultLimits.maxSlippageBps<0||config.defaultLimits.maxSlippageBps>HARD.slippageBps)throw new Error('AGENT_MAX_SLIPPAGE_BPS must be <= '+HARD.slippageBps+'.')
  if(config.defaultLimits.cooldownSeconds<HARD.minCooldownSeconds)throw new Error('AGENT_COOLDOWN_SECONDS must be >= '+HARD.minCooldownSeconds+'.')
  return {config,live}
}

async function main(){
  const {config,live}=requireControlledConfig()
  const fleet=new Fleet(config)
  const specs={
    'sniper-1':{id:'sniper-1',strategy:new LaunchSniper(),tickIntervalMs:4000},
    'momentum-1':{id:'momentum-1',strategy:new Momentum(),tickIntervalMs:15000},
    'premium-1':{id:'premium-1',strategy:new PremiumWatch(),tickIntervalMs:30000},
  } as const
  fleet.addAgents(live.agents.map(id=>specs[id as keyof typeof specs]))
  const chain=await fleet.market.client.public.getChainId()
  const expected=config.network==='testnet'?46630:4663
  if(chain!==expected){fleet.close();throw new Error('RPC chain mismatch before live automation start.')}
  const address=fleet.market.client.account?.address
  if(!address){fleet.close();throw new Error('Dedicated automation signer is unavailable.')}

  console.log([
    'CONTROLLED LIVE AUTOMATION',
    'network='+config.network+' chainId='+chain,
    'signer='+address,
    'agents='+live.agents.join(','),
    'fleetDailyCapUsd='+config.fleetMaxDailySpendUsdg,
    'agentDailyCapUsd='+config.defaultLimits.maxDailySpendUsdg,
    'positionCapUsd='+config.defaultLimits.maxPositionUsdg,
    'slippageCapBps='+config.defaultLimits.maxSlippageBps,
    'cooldownSeconds='+config.defaultLimits.cooldownSeconds,
    'approvals=manual-preapproval-required',
    'killFile='+config.killFile,
  ].join('\n'))

  await fleet.start()
  let closing=false
  const close=()=>{
    if(closing)return
    closing=true
    fleet.close()
    process.exit(0)
  }
  process.once('SIGINT',close)
  process.once('SIGTERM',close)
}
main().catch(error=>{
  console.error('controlled live automation refused to start:',error instanceof Error?error.message:String(error))
  process.exit(1)
})
