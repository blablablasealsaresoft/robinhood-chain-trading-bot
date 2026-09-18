import { loadFleetConfig } from '../src/framework/config.js'
import { Market } from '../src/framework/market.js'
import { Journal } from '../src/framework/journal.js'
import { BridgeObservations } from '../src/hub/bridge-observations.js'
import { LaunchDiscovery } from '../src/hub/launch-discovery.js'
import { AssetRegistry } from '../src/hub/assets.js'
const config={...loadFleetConfig(),mode:'paper' as const,privateKey:undefined,hasWallet:false}
const market=new Market(config),journal=new Journal(':memory:')
const reference={fromChainId:8453,toChainId:4663,txHash:'0x'+'f'.repeat(64)}
try{
 const jobs=[
  ['provider-connectivity',async()=>{
   const response=await fetch('https://li.quest/v1/status?fromChain=8453&toChain=4663&txHash='+reference.txHash,{signal:AbortSignal.timeout(12000),redirect:'error'})
   if(!response.ok)return {httpStatus:response.status}
   const body=await response.json() as {status?:string}
   return {httpStatus:response.status,providerStatus:body.status}
  }],
  ['bridge-observation',async()=>{const e=await new BridgeObservations(market,journal).verify(reference);return {status:e.status,verification:e.verification}}],
  ['launch-discovery',async()=>await new LaunchDiscovery(market,new AssetRegistry(4663,market),journal).recent()]
 ] as const
 for(const [name,work] of jobs){
  try{console.log(JSON.stringify({check:name,result:await work(),persistentDatabaseTouched:false,broadcast:false},(_,v)=>typeof v==='bigint'?v.toString():v))}
  catch(error){const e=error as {shortMessage?:string;status?:number;code?:string};console.log(JSON.stringify({check:name,available:false,message:e.shortMessage||'Read unavailable',httpStatus:e.status,code:e.code}));process.exitCode=1}
 }
}finally{journal.close()}
