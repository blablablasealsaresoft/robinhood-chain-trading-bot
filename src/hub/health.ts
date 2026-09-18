import type { Fleet } from '../framework/fleet.js'
import type { ArbitrageMonitor } from './arbitrage-monitor.js'

async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new Error('probe timeout')),timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}
export async function probeRpc(client: {getChainId():Promise<number>;getBlockNumber():Promise<bigint>}, expectedChainId:number, timeoutMs=3000) {
  const started=Date.now()
  const [chain,block]=await Promise.allSettled([
    bounded(()=>client.getChainId(),timeoutMs),bounded(()=>client.getBlockNumber(),timeoutMs),
  ])
  const chainId=chain.status==='fulfilled'?chain.value:null
  const blockNumber=block.status==='fulfilled'?block.value.toString():null
  return {ok:chainId===expectedChainId&&blockNumber!==null,chainId,blockNumber,latencyMs:Date.now()-started}
}
export async function hubHealth(fleet:Fleet,expectedChainId:number,arbitrage?:ArbitrageMonitor) {
  const rpc=await probeRpc(fleet.market.client.public,expectedChainId)
  const journal=fleet.journal.healthProbe()
  let observations:{available:boolean;pendingBridges:number|null;pendingLaunches:number|null}={available:false,pendingBridges:null,pendingLaunches:null}
  if(journal.readable) {
    try { observations={available:true,pendingBridges:fleet.journal.pendingExternalCount('bridge'),pendingLaunches:fleet.journal.pendingExternalCount('launch')} } catch { /* preserve diagnostics on table failure */ }
  }
  const arb=arbitrage?.status()
  return {
    ok:rpc.ok&&journal.readable&&journal.writable&&observations.available,
    observedAt:Date.now(),expectedChainId,rpc,journal,observations,
    mode:fleet.config.mode,killed:fleet.kill.isKilled(),
    arbitrage:arb?{configured:true,running:!!arb.running,status:arb.status}:{configured:false,running:false,status:'not-connected'},
  }
}
