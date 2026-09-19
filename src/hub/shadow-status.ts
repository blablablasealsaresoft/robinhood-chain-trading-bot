import { readFileSync,statSync } from 'node:fs'
import { resolve } from 'node:path'

export function shadowStatus(rawDir:string|undefined,now=Date.now()){
  if(!rawDir)return {configured:false,available:false,stale:true,summary:null}
  const path=resolve(rawDir,'shadow-summary.json')
  try{
    const stat=statSync(path)
    const parsed=JSON.parse(readFileSync(path,'utf8')) as any
    const agents=Array.isArray(parsed?.agents)?parsed.agents.map((a:any)=>({
      id:String(a.id??''),
      strategy:String(a.strategy??''),
      ticks:Number(a.ticks??0),
      trades:Number(a.trades??0),
      refusals:Number(a.refusals??0),
      realizedUsd:Number(a.realizedUsd??0),
      openValueUsd:Number(a.openValueUsd??0),
      equityUsd:Number(a.equityUsd??0),
      refinementReady:!!a.refinementReady,
    })):[]
    const endedAt=Number(parsed?.endedAt??0)
    return {
      configured:true,available:true,stale:!Number.isFinite(endedAt)||endedAt<=0||now-endedAt>6*60*60*1000,
      updatedAt:stat.mtimeMs,
      summary:{
        mode:parsed?.mode==='shadow-mainnet'?'shadow-mainnet':'unknown',
        signing:parsed?.signing===true,
        broadcasting:parsed?.broadcasting===true,
        startedAt:Number(parsed?.startedAt??0),
        endedAt,
        durationMinutes:Number(parsed?.durationMinutes??0),
        stockTokenEligibilityAcknowledged:!!parsed?.stockTokenEligibilityAcknowledged,
        agents,
        monitors:{
          launch:{configured:!!parsed?.monitors?.launch?.configured,recentEvents:Number(parsed?.monitors?.launch?.recentEvents??0)},
          arbitrage:{status:String(parsed?.monitors?.arbitrage?.status??'unknown'),running:!!parsed?.monitors?.arbitrage?.running},
        },
      },
    }
  }catch{
    return {configured:true,available:false,stale:true,summary:null}
  }
}
