import { createDashboardServer } from '../../src/server/dashboard.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fleet } from '../../src/framework/fleet.js'
import { HubReadModel } from '../../src/hub/read-model.js'
import { AssetRegistry } from '../../src/hub/assets.js'
import type { FleetConfig } from '../../src/framework/config.js'
import { createHubHandler } from '../../src/server/hub.js'
import { createServer, type Server } from 'node:http'
import { getAddress } from 'viem'
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
 it('values held non-stock registry tokens from live DEX spot probes and caches the result',async()=>{
  const {fleet,registry,read}=fixture()
  const token=getAddress('0x3333333333333333333333333333333333333333')
  registry.registerDiscovered({address:token,symbol:'NEW',name:'New token',decimals:18,type:'launch-token',source:'test',tradable:false})
  vi.spyOn(fleet.market.client.public,'getBalance').mockResolvedValue(0n)
  vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map(a=>({status:'success',result:a.address===token?2000000000000000000n:0n})) as never)
  const spot=vi.spyOn(fleet.market,'spotPrice').mockResolvedValue({token,priceUsd:2.5,via:'usdg',ts:Date.now()})
  const account='0x1111111111111111111111111111111111111111'
  const first=await read.portfolio(account)
  const holding=first.holdings.find(h=>h.asset.address===token)
  expect(holding).toMatchObject({priceUsd:2.5,valueUsd:5,priceSource:'DEX token/USDG probe'})
  await read.portfolio(account)
  expect(spot).toHaveBeenCalledTimes(1)
 })
 it('uses WETH-routed spot marks and leaves illiquid held tokens explicitly unpriced',async()=>{
  const {fleet,registry,read}=fixture()
  const routed=getAddress('0x3333333333333333333333333333333333333333')
  const illiquid=getAddress('0x4444444444444444444444444444444444444444')
  registry.registerDiscovered({address:routed,symbol:'ROUTE',name:'Routed',decimals:18,type:'crypto',source:'test',tradable:false})
  registry.registerDiscovered({address:illiquid,symbol:'NONE',name:'No route',decimals:18,type:'crypto',source:'test',tradable:false})
  vi.spyOn(fleet.market.client.public,'getBalance').mockResolvedValue(0n)
  vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map(a=>({status:'success',result:a.address===routed?1000000000000000000n:a.address===illiquid?1000000000000000000n:0n})) as never)
  vi.spyOn(fleet.market,'spotPrice').mockImplementation(async address=>address===routed?{token:routed,priceUsd:4,via:'weth',ts:Date.now()}:null)
  const p=await read.portfolio('0x1111111111111111111111111111111111111111')
  expect(p.holdings.find(h=>h.asset.address===routed)).toMatchObject({valueUsd:4,priceSource:'DEX token/WETH → USDG probe'})
  expect(p.holdings.find(h=>h.asset.address===illiquid)).toMatchObject({priceUsd:null,valueUsd:null,priceSource:'No liquid USD route'})
  expect(p.incomplete).toBe(true)
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
it('merges a wallet launch receipt and its factory event, preserving later verification downgrades',async()=>{
 const {fleet,read}=fixture(),hash='0x'+'a'.repeat(64),owner='0x1111111111111111111111111111111111111111'
 const wallet={planId:'plan',chainId:4663,account:owner,txHash:hash,kind:'launch-create' as const,status:'confirmed' as const,at:100,observedAt:200,blockNumber:'10',blockHash:'0x'+'b'.repeat(64)}
 fleet.journal.recordWalletActivity(wallet)
 fleet.journal.recordExternalEvent({id:'launch:4663:'+hash+':1',type:'launch',source:'hub-launchpad',chainId:4663,txHash:hash,owner,at:100,observedAt:201,status:'confirmed',verification:'chain-event',title:'NEW launched',detail:'Factory event',data:{}})
 expect(read.activity().filter(e=>e.txHash===hash)).toHaveLength(1)
 expect(read.activity().find(e=>e.txHash===hash)?.title).toBe('NEW launched')
 fleet.journal.recordWalletActivity({...wallet,status:'unverified',observedAt:202})
 expect(read.activity().find(e=>e.txHash===hash)?.status).toBe('unverified')
})

describe('portfolio history',()=>{
 it('records snapshots and reports observed value change without claiming cost-basis P&L',async()=>{
  const {fleet,registry,read}=fixture()
  vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map((_,i)=>({status:'success',result:i===1?1000000n:0n})) as never)
  const account='0x1111111111111111111111111111111111111111'
  await read.portfolio(account)
  vi.mocked(fleet.market.client.public.getBlockNumber).mockResolvedValue(124n)
  vi.mocked(fleet.market.client.public.multicall).mockResolvedValue(registry.list().map((_,i)=>({status:'success',result:i===1?3000000n:0n})) as never)
  await read.portfolio(account)
  const h=read.portfolioHistory(account,24,10)
  expect(h.points).toHaveLength(2)
  expect(h.changeUsd).toBe(2)
  expect(h.changePct).toBeCloseTo(2/2001*100,8)
  expect(h.metric).toBe('observed-priced-value-change')
  expect(h.note).toContain('not cost basis')
 })
 it('validates history bounds',()=>{
  const {read}=fixture()
  const account='0x1111111111111111111111111111111111111111'
  expect(()=>read.portfolioHistory(account,0,10)).toThrow()
  expect(()=>read.portfolioHistory(account,24,1)).toThrow()
 })
})

describe('persistent operator auth',()=>{
 it('authorizes paper controls with a server-side bearer token without disclosing it',async()=>{
  const {fleet}=fixture()
  const start=vi.fn(),stop=vi.fn()
  fleet.addAgents([{id:'operator-test',strategy:{id:'operator-test',title:'Operator Test',quote:'usdg',meta:{edge:'Test',failureModes:[],params:{}},start,stop,tick:async()=>({intents:[],alerts:[]})},tickIntervalMs:60000}])
  const secret='operator-token-1234567890-abcdefghijklmnopqrstuvwxyz'
  const handle=createHubHandler(fleet,undefined,{operatorToken:secret})
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const status=await (await fetch(base+'/api/status')).json() as {operatorAuthConfigured:boolean;controlToken:string}
  expect(status.operatorAuthConfigured).toBe(true)
  expect(JSON.stringify(status)).not.toContain(secret)
  const post=(token?:string)=>fetch(base+'/api/strategies/operator-test/start',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:'{}'})
  expect((await post()).status).toBe(403)
  expect((await post('wrong-token-1234567890-abcdefghijklmnopqrstuvwxyz')).status).toBe(403)
  expect((await post(secret)).status).toBe(200)
  expect(start).toHaveBeenCalledOnce()
  expect(status.controlToken).toBeNull()
  expect((await fetch(base+'/api/strategies/operator-test/stop',{method:'POST',headers:{'content-type':'application/json','x-hub-control':'null'},body:'{}'})).status).toBe(403)
  expect((await fetch(base+'/api/strategies/operator-test/stop',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+secret},body:'{}'})).status).toBe(200)
  expect(stop).toHaveBeenCalledOnce()
 })
 it('rejects unsafe persistent operator token configuration',()=>{
  const {fleet}=fixture()
  expect(()=>createHubHandler(fleet,undefined,{operatorToken:'short'})).toThrow('32-256')
  expect(()=>createHubHandler(fleet,undefined,{operatorToken:'x'.repeat(31)+'\n'})).toThrow('line breaks')
 })
})

it('values canonical currencies by address instead of accepting duplicate symbols',async()=>{
 const {fleet,registry,read}=fixture()
 const fake=getAddress('0x5555555555555555555555555555555555555555')
 registry.registerReviewed({address:fake,symbol:'USDG',name:'Not canonical USDG',decimals:18,type:'crypto'})
 vi.spyOn(fleet.market.client.public,'getBalance').mockResolvedValue(0n)
 vi.spyOn(fleet.market.client.public,'multicall').mockResolvedValue(registry.list().map(a=>({status:'success',result:a.address===fake?1000000000000000000n:0n})) as never)
 vi.spyOn(fleet.market,'spotPrice').mockResolvedValue(null)
 const result=await read.portfolio('0x1111111111111111111111111111111111111111')
 expect(result.holdings.find(h=>h.asset.address===fake)).toMatchObject({priceUsd:null,valueUsd:null})
 expect(result.incomplete).toBe(true)
})

describe('Hub health endpoint',()=>{
 it('reports RPC and Journal health without exposing RPC configuration',async()=>{
  const {fleet}=fixture()
  const handle=createHubHandler(fleet)
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const response=await fetch(base+'/api/health')
  expect(response.status).toBe(200)
  const body=await response.json() as Record<string,unknown>
  expect(body).toMatchObject({ok:true,expectedChainId:4663,journal:{readable:true,writable:true},mode:'paper'})
  expect(JSON.stringify(body)).not.toContain('rpcUrl')
  expect(JSON.stringify(body)).not.toContain('HOOD_RPC_URL')
 })

 it('returns 503 for a wrong-chain or unavailable RPC and does not leak raw errors',async()=>{
  const {fleet}=fixture()
  vi.mocked(fleet.market.client.public.getChainId).mockResolvedValueOnce(1)
  const handle=createHubHandler(fleet)
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const wrong=await fetch(base+'/api/health')
  expect(wrong.status).toBe(503)
  expect(await wrong.json()).toMatchObject({ok:false,rpc:{ok:false,chainId:1}})
  vi.mocked(fleet.market.client.public.getChainId).mockRejectedValueOnce(new Error('https://secret-rpc.invalid/key'))
  const failed=await fetch(base+'/api/health')
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain('secret-rpc')
 })
})
it('routes standalone dashboard health through diagnostics and preserves successful RPC fields',async()=>{
 const {fleet}=fixture()
 vi.mocked(fleet.market.client.public.getBlockNumber).mockRejectedValue(new Error('secret-block-rpc'))
 const server=createDashboardServer(fleet,'./dashboard');servers.push(server)
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/health')
 expect(response.status).toBe(503)
 const body=await response.json()
 expect(body).toMatchObject({ok:false,rpc:{ok:false,chainId:4663,blockNumber:null},journal:{readable:true,writable:true}})
 expect(JSON.stringify(body)).not.toContain('secret-block')
})
it('returns structured health when the Journal or observation table fails',async()=>{
 const {fleet}=fixture()
 const handle=createHubHandler(fleet)
 const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/health'
 const count=vi.spyOn(fleet.journal,'pendingExternalCount').mockImplementation(()=>{throw new Error('secret-db-path')})
 let response=await fetch(url);expect(response.status).toBe(503)
 expect(await response.json()).toMatchObject({rpc:{ok:true},journal:{readable:true,writable:true},observations:{available:false,pendingBridges:null}})
 count.mockRestore()
 fleet.journal.close()
 response=await fetch(url);expect(response.status).toBe(503)
 const body=await response.json()
 expect(body).toMatchObject({rpc:{ok:true},journal:{readable:false,writable:false},observations:{available:false,pendingBridges:null,pendingLaunches:null}})
 expect(JSON.stringify(body)).not.toContain('secret-db')
 // Prevent fixture teardown from double-closing the intentionally closed DB.
 vi.spyOn(fleet.journal,'close').mockImplementation(()=>{})
})


describe('wallet-scoped Activity pagination',()=>{
 const a='0x1111111111111111111111111111111111111111'
 const b='0x2222222222222222222222222222222222222222'
 const hash=(n:string)=>('0x'+n.repeat(64)) as `0x${string}`

 it('isolates wallet-owned records from other wallets and global bot decisions',()=>{
  const {fleet,read}=fixture()
  fleet.journal.recordWalletActivity({planId:'a-plan',chainId:4663,account:a,txHash:hash('a'),kind:'swap',status:'confirmed',at:3000,observedAt:3100,blockNumber:'10',blockHash:hash('b')})
  fleet.journal.recordWalletActivity({planId:'b-plan',chainId:4663,account:b,txHash:hash('c'),kind:'wrap',status:'confirmed',at:2900,observedAt:3000,blockNumber:'9',blockHash:hash('d')})
  fleet.journal.recordExternalEvent({id:'bridge-a',type:'bridge',source:'lifi',chainId:1,txHash:hash('e'),owner:a,at:2800,observedAt:2850,status:'completed',verification:'provider',title:'Bridge A',detail:'A only',data:{reference:{fromChainId:1}}})
  fleet.journal.recordExternalEvent({id:'bridge-b',type:'bridge',source:'lifi',chainId:1,txHash:hash('f'),owner:b,at:2700,observedAt:2750,status:'completed',verification:'provider',title:'Bridge B',detail:'B only',data:{reference:{fromChainId:1}}})
  fleet.journal.recordDecision({agentId:'hub:manual',ts:2600,kind:'observe',detail:'A prepared',meta:{owner:a}})
  fleet.journal.recordDecision({agentId:'bot-1',ts:2500,kind:'alert',detail:'global bot',meta:{}})
  const page=read.activityPage(a,20)
  expect(page).toMatchObject({account:getAddress(a),scope:'wallet',nextCursor:null})
  expect(page.events.map((e:any)=>e.title)).toContain('Wallet swap')
  expect(page.events.map((e:any)=>e.title)).toContain('Bridge A')
  expect(page.events.map((e:any)=>e.title)).toContain('Wallet transaction prepared')
  expect(JSON.stringify(page.events)).not.toContain('Bridge B')
  expect(JSON.stringify(page.events)).not.toContain('global bot')
  expect(JSON.stringify(page.events)).not.toContain(b)
 })

 it('uses the wallet receipt as the canonical user record when a launch factory event shares its hash',()=>{
  const {fleet,read}=fixture(),tx=hash('a')
  fleet.journal.recordWalletActivity({planId:'launch',chainId:4663,account:a,txHash:tx,kind:'launch-create',status:'confirmed',at:3000,observedAt:3100,blockNumber:'10',blockHash:hash('b')})
  fleet.journal.recordExternalEvent({id:'launch:4663:'+tx+':1',type:'launch',source:'hub-launchpad',chainId:4663,txHash:tx,owner:a,at:3000,observedAt:3200,status:'confirmed',verification:'chain-event',title:'NEW launched',detail:'factory event',data:{}})
  const events=read.activityPage(a,20).events.filter((e:any)=>e.txHash===tx)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({source:'user-wallet',title:'Token and sale created'})
 })

 it('paginates deterministically without duplicates or gaps at identical timestamps',()=>{
  const {fleet,read}=fixture()
  for(const [i,n] of ['a','b','c','d','e'].entries())fleet.journal.recordWalletActivity({
    planId:'p'+i,chainId:4663,account:a,txHash:hash(n),kind:'swap',status:'confirmed',at:5000,observedAt:5100+i,blockNumber:String(10+i),blockHash:hash('f'),
  })
  const first=read.activityPage(a,2)
  expect(first.events).toHaveLength(2);expect(first.nextCursor).toBeTruthy()
  const second=read.activityPage(a,2,first.nextCursor)
  expect(second.events).toHaveLength(2);expect(second.nextCursor).toBeTruthy()
  const third=read.activityPage(a,2,second.nextCursor)
  expect(third.events).toHaveLength(1);expect(third.nextCursor).toBeNull()
  const ids=[...first.events,...second.events,...third.events].map((e:any)=>e.id)
  expect(new Set(ids).size).toBe(5)
 })

 it('rejects malformed cursor and bounds',()=>{
  const {read}=fixture()
  expect(()=>read.activityPage(a,0)).toThrow()
  expect(()=>read.activityPage(a,101)).toThrow()
  expect(()=>read.activityPage(a,10,'not!base64')).toThrow()
 })
})


describe('wallet-scoped Activity HTTP boundary',()=>{
 it('returns wallet scope with pagination metadata and keeps legacy global feed separate',async()=>{
  const {fleet}=fixture()
  const account='0x1111111111111111111111111111111111111111'
  fleet.journal.recordWalletActivity({planId:'p1',chainId:4663,account,txHash:('0x'+'a'.repeat(64)) as `0x${string}`,kind:'swap',status:'confirmed',at:1000,observedAt:1100,blockNumber:'1',blockHash:('0x'+'b'.repeat(64)) as `0x${string}`})
  fleet.journal.recordDecision({agentId:'bot-1',ts:900,kind:'alert',detail:'operator event',meta:{}})
  const handle=createHubHandler(fleet)
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const scoped=await fetch(base+'/api/activity?account='+account+'&limit=10')
  expect(scoped.status).toBe(200)
  expect(await scoped.json()).toMatchObject({account:getAddress(account),scope:'wallet',limit:10,nextCursor:null,events:[{source:'user-wallet'}]})
  const global=await fetch(base+'/api/activity')
  expect(await global.json()).toMatchObject({scope:'operator-global',nextCursor:null})
 })

 it('rejects duplicate, unsupported and malformed pagination parameters',async()=>{
  const {fleet}=fixture()
  const handle=createHubHandler(fleet)
  const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port
  const account='0x1111111111111111111111111111111111111111'
  expect((await fetch(base+'/api/activity?account='+account+'&limit=2&limit=3')).status).toBe(400)
  expect((await fetch(base+'/api/activity?account='+account+'&extra=1')).status).toBe(400)
  expect((await fetch(base+'/api/activity?account='+account+'&cursor=bad!')).status).toBe(400)
 })
})


it('keeps wallet-scoped Activity public while gating the global feed when operator auth is configured',async()=>{
 const {fleet}=fixture()
 const secret='operator-token-1234567890-abcdefghijklmnopqrstuvwxyz'
 const handle=createHubHandler(fleet,undefined,{operatorToken:secret})
 const server=createServer(async(req,res)=>{await handle(req,res,new URL(req.url!,'http://localhost'))});servers.push(server)
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port
 const account='0x1111111111111111111111111111111111111111'
 expect((await fetch(base+'/api/activity')).status).toBe(403)
 expect((await fetch(base+'/api/activity?account='+account)).status).toBe(200)
 expect((await fetch(base+'/api/activity',{headers:{authorization:'Bearer '+secret}})).status).toBe(200)
})
