import { readFileSync,statSync } from 'node:fs'
import { resolve } from 'node:path'

type ShadowAgent={id:string;strategy:string;ticks:number;trades:number;refusals:number;realizedUsd:number;openValueUsd:number;equityUsd:number;refinementReady:boolean}

export function shadowStatus(rawDir:string|undefined,now=Date.now()){
  if(!rawDir)return {configured:false,available:false,running:false,stale:true,summary:null}
  const summaryPath=resolve(rawDir,'shadow-summary.json')
  const eventsPath=resolve(rawDir,'shadow-events.jsonl')

  try{
    const parsed=JSON.parse(readFileSync(summaryPath,'utf8')) as any
    const stat=statSync(summaryPath)
    const endedAt=Number(parsed?.endedAt??0)
    const agents=sanitizeAgents(parsed?.agents)
    const fresh=Number.isFinite(endedAt)&&endedAt>0&&now-endedAt<=6*60*60*1000
    if(fresh)return {
      configured:true,available:true,running:false,stale:false,updatedAt:stat.mtimeMs,
      summary:sanitizeSummary(parsed,agents),
    }
  }catch{}

  const active=readActive(eventsPath,now)
  if(active)return active

  try{
    const parsed=JSON.parse(readFileSync(summaryPath,'utf8')) as any
    const stat=statSync(summaryPath)
    return {
      configured:true,available:true,running:false,stale:true,updatedAt:stat.mtimeMs,
      summary:sanitizeSummary(parsed,sanitizeAgents(parsed?.agents)),
    }
  }catch{
    return {configured:true,available:false,running:false,stale:true,summary:null}
  }
}

function readActive(path:string,now:number){
  try{
    const stat=statSync(path)
    const lines=readFileSync(path,'utf8').trim().split(/\r?\n/).slice(-500)
    let started:any=null,lastSnapshot:any=null,stopped=false
    for(const line of lines){
      let event:any
      try{event=JSON.parse(line)}catch{continue}
      if(event?.type==='started'){started=event;lastSnapshot=null;stopped=false}
      else if(event?.type==='snapshot'&&started){lastSnapshot=event}
      else if((event?.type==='stopping'||event?.type==='fatal')&&started)stopped=true
    }
    if(!started||stopped)return null
    const lastAt=Number(lastSnapshot?.at??started.at??0)
    if(!Number.isFinite(lastAt)||lastAt<=0||now-lastAt>10*60*1000)return null
    const data=lastSnapshot?.data??started.data??{}
    const agents=Array.isArray(data?.agents)?data.agents.map((a:any)=>({
      id:String(a.id??''),strategy:String(a.strategy??''),ticks:Number(a.ticks??0),trades:Number(a.trades??0),refusals:Number(a.refusals??0),
      realizedUsd:Number(a.realizedUsd??0),openValueUsd:Number(a.openValueUsd??0),equityUsd:Number(a.equityUsd??0),refinementReady:false,
    })):Array.isArray(started?.data?.agents)?started.data.agents.map((id:any)=>({id:String(id),strategy:'',ticks:0,trades:0,refusals:0,realizedUsd:0,openValueUsd:0,equityUsd:0,refinementReady:false})):[]
    return {
      configured:true,available:true,running:true,stale:false,updatedAt:stat.mtimeMs,
      summary:{
        mode:'shadow-mainnet',signing:false,broadcasting:false,
        startedAt:Number(started.at??0),endedAt:null,
        durationMinutes:Number(started?.data?.durationMinutes??0),
        stockTokenEligibilityAcknowledged:!!started?.data?.stockTokenEligibilityAcknowledged,
        agents,
        monitors:{
          launch:{configured:!!data?.launchMonitor?.configured,recentEvents:Array.isArray(data?.launchMonitor?.recentEvents)?data.launchMonitor.recentEvents.length:0},
          arbitrage:{status:String(data?.arbitrage?.status??(started?.data?.arbitrageAvailable?'starting':'not-installed')),running:!!data?.arbitrage?.running},
        },
      },
    }
  }catch{return null}
}

function sanitizeAgents(input:any):ShadowAgent[]{
  return Array.isArray(input)?input.map((a:any)=>({
    id:String(a.id??''),strategy:String(a.strategy??''),ticks:Number(a.ticks??0),trades:Number(a.trades??0),refusals:Number(a.refusals??0),
    realizedUsd:Number(a.realizedUsd??0),openValueUsd:Number(a.openValueUsd??0),equityUsd:Number(a.equityUsd??0),refinementReady:!!a.refinementReady,
  })):[]
}
function sanitizeSummary(parsed:any,agents:ShadowAgent[]){
  return {
    mode:parsed?.mode==='shadow-mainnet'?'shadow-mainnet':'unknown',
    signing:parsed?.signing===true,broadcasting:parsed?.broadcasting===true,
    startedAt:Number(parsed?.startedAt??0),endedAt:Number(parsed?.endedAt??0),durationMinutes:Number(parsed?.durationMinutes??0),
    stockTokenEligibilityAcknowledged:!!parsed?.stockTokenEligibilityAcknowledged,agents,
    monitors:{
      launch:{configured:!!parsed?.monitors?.launch?.configured,recentEvents:Number(parsed?.monitors?.launch?.recentEvents??0)},
      arbitrage:{status:String(parsed?.monitors?.arbitrage?.status??'unknown'),running:!!parsed?.monitors?.arbitrage?.running},
    },
  }
}
