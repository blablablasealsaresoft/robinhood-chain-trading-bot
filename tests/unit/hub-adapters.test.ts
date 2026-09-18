import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { getRecentLaunches } from 'hoodchain'
import { ArbitrageMonitor, monitorEnvironment } from '../../src/hub/arbitrage-monitor.js'
import { LaunchDiscovery } from '../../src/hub/launch-discovery.js'
import { AssetRegistry } from '../../src/hub/assets.js'
import type { Market } from '../../src/framework/market.js'
vi.mock('hoodchain',async original=>({...await original<object>(),getRecentLaunches:vi.fn()}))
const weth=getAddress('0x1111111111111111111111111111111111111111')
const usdg=getAddress('0x2222222222222222222222222222222222222222')
const token=getAddress('0x3333333333333333333333333333333333333333')
const market=()=>({weth,usdg,usdgDecimals:6,pricedStockTokens:()=>[],client:{public:{getChainId:vi.fn(async()=>4663),readContract:vi.fn(async({functionName}:{functionName:string})=>functionName==='decimals'?18:functionName==='symbol'?'NEW':'New token')}}}) as unknown as Market
afterEach(()=>vi.resetAllMocks())
describe('launch discovery integration',()=>{
 it('coalesces calls, caches results and never grants manual trading permission',async()=>{
  const m=market(),registry=new AssetRegistry(4663,m),discovery=new LaunchDiscovery(m,registry)
  vi.mocked(getRecentLaunches).mockResolvedValue([{launchpad:'noxa',token,creator:weth,pool:null,blockNumber:123n,transactionHash:'0x123'}] as never)
  const [a,b]=await Promise.all([discovery.recent(),discovery.recent()])
  expect(a).toBe(b);expect(await discovery.recent()).toBe(a)
  expect(getRecentLaunches).toHaveBeenCalledExactlyOnceWith(m.client,{lookbackBlocks:30000n,chunkSize:10000n})
  expect(registry.get(token)).toMatchObject({type:'launch-token',tradable:false})
 })
 it('fails closed for mismatched networks and leaves unreadable metadata unknown',async()=>{
  const m=market();vi.mocked(m.client.public.getChainId).mockResolvedValueOnce(1)
  await expect(new LaunchDiscovery(m,new AssetRegistry(4663,m)).recent()).rejects.toMatchObject({code:'CHAIN_MISMATCH'})
  expect(getRecentLaunches).not.toHaveBeenCalled()
  await expect(new LaunchDiscovery(m,new AssetRegistry(46630,m)).recent()).rejects.toMatchObject({code:'DISCOVERY_NETWORK'})
  vi.mocked(getRecentLaunches).mockResolvedValue([{launchpad:'noxa',token,creator:weth,pool:null,blockNumber:123n,transactionHash:'0x123'}] as never)
  vi.mocked(m.client.public.readContract).mockRejectedValue(new Error('revert'))
  const registry=new AssetRegistry(4663,m)
  expect(await new LaunchDiscovery(m,registry).recent()).toMatchObject({launches:[{asset:null,tradeEnabled:false}]})
  expect(registry.get(token)).toBeUndefined()
 })
 it('bounds discovery without evicting manually enabled assets',()=>{
  const registry=new AssetRegistry(4663,market())
  for(let i=1;i<=230;i++)registry.registerDiscovered({address:getAddress('0x'+i.toString(16).padStart(40,'0')),symbol:'NEW',name:'New',decimals:18,type:'launch-token',source:'discovery',tradable:true})
  expect(registry.list()).toHaveLength(200)
  expect(registry.get(weth)?.tradable).toBe(true)
  expect(registry.get(usdg)?.tradable).toBe(true)
  expect(registry.list().filter(a=>a.type==='launch-token').every(a=>!a.tradable)).toBe(true)
 })
})
describe('separate arbitrage monitor',()=>{
 it('excludes secrets, dotenv preload and notification credentials',()=>{
  const env=monitorEnvironment({PATH:'test-path',PRIVATE_KEY:'secret',ROBINHOOD_CHAIN_PRIVATE_KEY:'secret',NODE_OPTIONS:'--import ./signer.js',LIVE:'1',TELEGRAM_BOT_TOKEN:'secret',HOOD_LLM_API_KEY:'secret'},'https://example.invalid')
  expect(env.PATH).toBe('test-path');expect(env.PRIVATE_KEY).toBe('');expect(env.LIVE).toBe('0')
  expect(JSON.stringify(env)).not.toContain('secret');expect(env.NODE_OPTIONS).toBeUndefined()
  expect(env.DOTENV_CONFIG_PATH).toBe(process.platform==='win32'?'NUL':'/dev/null')
 })
 it('starts and stops an isolated worker and journals acknowledged lifecycle',async()=>{
  const repo=mkdtempSync(join(tmpdir(),'hub-monitor-'))
  mkdirSync(join(repo,'node_modules/ethers'),{recursive:true})
  writeFileSync(join(repo,'node_modules/ethers/package.json'),'{}')
  writeFileSync(join(repo,'arb.js'),"if(process.env.PRIVATE_KEY || process.env.LIVE!=='0' || !process.argv.includes('--dry-run'))process.exit(5); console.log('DRY-RUN https://secret.example/key'); setInterval(()=>{},1000)")
  const journal={recordDecision:vi.fn(()=>1)},monitor=new ArbitrageMonitor(repo,journal)
  try {
   await Promise.all([monitor.start(),monitor.start()])
   await vi.waitFor(()=>expect(monitor.status().status).toBe('running'))
   expect(monitor.status().signing).toBe(false)
   expect(monitor.status().logs.join(' ')).not.toContain('secret.example')
   await Promise.all([monitor.stop(),monitor.stop()])
   expect(monitor.status()).toMatchObject({running:false,status:'stopped'})
   expect(journal.recordDecision).toHaveBeenCalledTimes(2)
  } finally {await monitor.stop();rmSync(repo,{recursive:true,force:true})}
 },10000)
})
