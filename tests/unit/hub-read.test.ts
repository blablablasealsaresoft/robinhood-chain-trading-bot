import { createDashboardServer } from '../../src/server/dashboard.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fleet } from '../../src/framework/fleet.js'
import { HubReadModel } from '../../src/hub/read-model.js'
import { AssetRegistry } from '../../src/hub/assets.js'
import type { FleetConfig } from '../../src/framework/config.js'
import { createHubHandler } from '../../src/server/hub.js'
import { createServer, type Server } from 'node:http'
const config: FleetConfig = { network:'mainnet', rpcUrl:undefined, mode:'paper', hasWallet:false, privateKey:undefined, stockTokenEligible:false, fleetMaxDailySpendUsdg:250, dashboardPort:4670, killFile:'./KILL-TEST-HUB-READ', dbPath:':memory:', defaultLimits:{maxPositionUsdg:50,maxDailySpendUsdg:100,maxSlippageBps:100,cooldownSeconds:60} }
const fleets:Fleet[]=[];const servers:Server[]=[]
function fixture() {
 const fleet=new Fleet(config);fleets.push(fleet)
 const registry=new AssetRegistry(4663,fleet.market)
 const read=new HubReadModel(fleet,fleet.market,registry)
 vi.spyOn(fleet.market.client.public,'getChainId').mockResolvedValue(4663)
 vi.spyOn(fleet.market.client.public,'getBlockNumber').mockResolvedValue(123n)
 vi.spyOn(fleet.market.client.public,'getBalance').mockResolvedValue(1000000000000000000n)
 vi.spyOn(fleet.market,'ethUsd').mockResolvedValue(2000)
 return {fleet,registry,read}
}
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}for(const f of fleets.splice(0))f.close();vi.restoreAllMocks()})
describe('Hub read adapters',()=>{
 it('keeps failed balances unknown and does not add bot position value to wallet totals',async()=>{
  const {fleet,registry,read}=fixture()
  vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map((_,i)=>i===0?{status:'failure',error:new Error('rpc')}:{status:'success',result:i===1?2000000n:0n}) as never)
  const p=await read.portfolio('0x1111111111111111111111111111111111111111')
  expect(p.pricedValueUsd).toBe(2002);expect(p.incomplete).toBe(true);expect(p.holdings[1]?.balance).toBeNull();expect(p.walletPnlUsd).toBeNull()
 })
 it('preserves exact stock units and uses reference price per token without multiplying again',async()=>{
  const {fleet,registry,read}=fixture()
  const stock=registry.list().findIndex(a=>a.type==='stock-token')
  vi.spyOn(fleet.market.client.public,'getBalance').mockResolvedValue(0n)
  vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map((_,i)=>({status:'success',result:i===stock?2000000000000000001n:0n})) as never)
  vi.spyOn(fleet.market,'stockChainlinkPrice').mockResolvedValue({priceUsd:100} as never)
  const p=await read.portfolio('0x1111111111111111111111111111111111111111')
  expect(p.holdings[stock+1]?.balance).toBe('2000000000000000001');expect(p.holdings[stock+1]?.valueUsd).toBe(200)
 })
 it('rejects invalid addresses and RPC network mismatches',async()=>{
  const {fleet,read}=fixture()
  await expect(read.portfolio('not-wallet')).rejects.toMatchObject({code:'INVALID_ACCOUNT'})
  vi.mocked(fleet.market.client.public.getChainId).mockResolvedValue(1)
  await expect(read.portfolio('0x1111111111111111111111111111111111111111')).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
 })
 it('keeps manual preparation unsigned and redacts diagnostic URLs from activity',()=>{
  const {fleet,read}=fixture()
  fleet.journal.recordDecision({agentId:'hub:manual',ts:1,kind:'observe',detail:'Unsigned plan',meta:{}})
  fleet.journal.recordDecision({agentId:'test',ts:2,kind:'observe',detail:'tick error https://rpc.secret/key',meta:{secret:'hidden'}})
  expect(read.activity()[0]?.detail).not.toContain('rpc.secret')
  expect(read.activity()[1]?.status).toBe('unsigned')
 })
})
describe('paper controls',()=>{
 it('requires the control session, respects kill, and delegates lifecycle to the existing strategy',async()=>{
  const {fleet}=fixture()
  const start=vi.fn(),stop=vi.fn()
  fleet.addAgents([{id:'test',strategy:{id:'test',title:'Test',quote:'usdg',meta:{edge:'Test',failureModes:[],params:{}},start,stop,tick:async()=>({intents:[],alerts:[]})},tickIntervalMs:60000}])
  const handle=createHubHandler(fleet)
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const address=server.address() as {port:number};const base='http://127.0.0.1:'+address.port
  const post=(path:string,token?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{'x-hub-control':token}:{})},body:'{}'})
  expect((await post('/api/strategies/test/start')).status).toBe(403)
  const status=await (await fetch(base+'/api/status')).json() as {controlToken:string}
  expect((await post('/api/strategies/test/start',status.controlToken)).status).toBe(200);expect(start).toHaveBeenCalledOnce()
  expect((await post('/api/strategies/test/stop',status.controlToken)).status).toBe(200);expect(stop).toHaveBeenCalledOnce()
  expect((await post('/api/kill',status.controlToken)).status).toBe(200)
  expect((await post('/api/strategies/test/start',status.controlToken)).status).toBe(409)
 })
})

describe('arbitrage service controls',()=>{
 it('requires a control token, verifies chain and acknowledges kill before preventing restart',async()=>{
  const {fleet}=fixture()
  const chain=vi.spyOn(HubReadModel.prototype,'checkChain').mockResolvedValue(undefined)
  let running=false
  const arbitrage={start:vi.fn(async()=>{running=true}),stop:vi.fn(async()=>{running=false}),status:()=>({id:'arbitrage',running,status:running?'running':'stopped'})}
  const handle=createHubHandler(fleet,undefined,{arbitrage:arbitrage as never})
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const post=(path:string,token?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{'x-hub-control':token}:{})},body:'{}'})
  expect((await post('/api/strategies/arbitrage/start')).status).toBe(403)
  expect(arbitrage.start).not.toHaveBeenCalled()
  const {controlToken}=await (await fetch(base+'/api/status')).json() as {controlToken:string}
  chain.mockRejectedValueOnce(new Error('network unavailable'))
  expect((await post('/api/strategies/arbitrage/start',controlToken)).status).toBe(503)
  expect(arbitrage.start).not.toHaveBeenCalled()
  expect((await post('/api/strategies/arbitrage/start',controlToken)).status).toBe(200)
  expect(arbitrage.start).toHaveBeenCalledOnce()
  expect(await (await post('/api/kill',controlToken)).json()).toMatchObject({killed:true,arbitrageMonitorStopped:true})
  expect(arbitrage.stop).toHaveBeenCalledOnce()
  expect((await post('/api/strategies/arbitrage/start',controlToken)).status).toBe(409)
  expect(arbitrage.start).toHaveBeenCalledOnce()
 })
})

describe('original dashboard compatibility',()=>{
 it('preserves its existing kill request without requiring the separate Hub paper token',async()=>{
  const fleet=new Fleet({...config,mode:'live'});fleets.push(fleet)
  const server=createDashboardServer(fleet,'./dashboard');servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const result=await fetch(base+'/api/kill',{method:'POST'})
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({killed:true,reason:'dashboard'})
  expect(fleet.kill.isKilled()).toBe(true)
 })
})