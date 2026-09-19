import { spawn } from 'node:child_process'

const intervalMinutes=boundedInt(process.env.SHADOW_SCHEDULE_INTERVAL_MINUTES,240,60,1440)
const durationMinutes=boundedInt(process.env.SHADOW_DURATION_MINUTES,55,1,180)
const retryMinutes=boundedInt(process.env.SHADOW_RETRY_MINUTES,15,1,60)
let stopping=false
let child:ReturnType<typeof spawn>|null=null

function safeEnv():NodeJS.ProcessEnv {
  const env={...process.env}
  env.HOOD_NETWORK='mainnet'
  env.HOOD_TRADERS_LIVE='0'
  env.ROBINHOOD_CHAIN_PRIVATE_KEY=''
  env.HOOD_STOCK_TOKEN_ELIGIBLE='false'
  env.SHADOW_DURATION_MINUTES=String(durationMinutes)
  env.SHADOW_OUTPUT_DIR=env.SHADOW_OUTPUT_DIR||'/app/data/shadow'
  return env
}

async function runSession(){
  const startedAt=Date.now()
  console.log(JSON.stringify({shadowScheduler:'session-start',startedAt,durationMinutes,intervalMinutes}))
  const code=await new Promise<number|null>((resolve,reject)=>{
    const proc=spawn(process.execPath,['dist/shadow-main.js'],{env:safeEnv(),stdio:'inherit'})
    child=proc
    proc.once('error',reject)
    proc.once('exit',resolve)
  }).finally(()=>{child=null})
  const elapsed=Date.now()-startedAt
  console.log(JSON.stringify({shadowScheduler:'session-exit',code,elapsedMs:elapsed}))
  return {code,startedAt,elapsed}
}

async function main(){
  for(;;){
    if(stopping)break
    let code:number|null=null,startedAt=Date.now()
    try{
      const result=await runSession();code=result.code;startedAt=result.startedAt
    }catch(error){
      console.error(JSON.stringify({shadowScheduler:'session-error',message:error instanceof Error?error.message:String(error)}))
    }
    if(stopping)break
    const target=code===0?startedAt+intervalMinutes*60_000:Date.now()+retryMinutes*60_000
    const wait=Math.max(1000,target-Date.now())
    console.log(JSON.stringify({shadowScheduler:'sleep',waitMs:wait,nextStartAt:Date.now()+wait,reason:code===0?'cadence':'retry'}))
    await sleep(wait)
  }
}

function stop(signal:string){
  if(stopping)return
  stopping=true
  console.log(JSON.stringify({shadowScheduler:'stopping',signal}))
  child?.kill('SIGTERM')
}
process.once('SIGINT',()=>stop('SIGINT'))
process.once('SIGTERM',()=>stop('SIGTERM'))
void main().catch(error=>{console.error(error);process.exitCode=1})

function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms))}
function boundedInt(raw:string|undefined,fallback:number,min:number,max:number){
  if(raw===undefined||raw==='')return fallback
  const value=Number(raw)
  if(!Number.isInteger(value)||value<min||value>max)throw new Error('Shadow scheduler setting must be '+min+'-'+max)
  return value
}
