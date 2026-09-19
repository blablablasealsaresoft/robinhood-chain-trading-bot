import { afterEach,describe,expect,it } from 'vitest'
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shadowStatus } from '../../src/hub/shadow-status.js'

const dirs:string[]=[]
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})

describe('shadowStatus',()=>{
 it('returns a sanitized fresh shadow summary without raw trades or files',()=>{
  const root=mkdtempSync(join(tmpdir(),'shadow-status-'));dirs.push(root);mkdirSync(root,{recursive:true})
  const now=Date.now()
  writeFileSync(join(root,'shadow-summary.json'),JSON.stringify({
   mode:'shadow-mainnet',signing:false,broadcasting:false,startedAt:now-60000,endedAt:now-1000,durationMinutes:1,
   stockTokenEligibilityAcknowledged:false,
   agents:[{id:'momentum-1',strategy:'momentum',ticks:10,trades:2,refusals:3,realizedUsd:1,openValueUsd:2,equityUsd:3,refinementReady:false,simulatedTrades:[{secret:'raw'}]}],
   monitors:{launch:{configured:true,recentEvents:4},arbitrage:{status:'not-installed',running:false,logs:['raw log']}},
  }))
  const result=shadowStatus(root,now) as any
  expect(result).toMatchObject({configured:true,available:true,running:false,stale:false,summary:{mode:'shadow-mainnet',signing:false,broadcasting:false}})
  expect(result.summary.agents[0]).toEqual({id:'momentum-1',strategy:'momentum',ticks:10,trades:2,refusals:3,realizedUsd:1,openValueUsd:2,equityUsd:3,refinementReady:false})
  expect(JSON.stringify(result)).not.toContain('simulatedTrades')
  expect(JSON.stringify(result)).not.toContain('raw log')
 })
 it('reports a live running session from shadow-events before the final summary exists',()=>{
  const root=mkdtempSync(join(tmpdir(),'shadow-status-'));dirs.push(root)
  const now=Date.now()
  writeFileSync(join(root,'shadow-events.jsonl'),[
   JSON.stringify({at:now-60000,type:'started',data:{chainId:4663,durationMinutes:55,stockTokenEligibilityAcknowledged:false,agents:['sniper-1','momentum-1','premium-1'],arbitrageAvailable:false}}),
   JSON.stringify({at:now-1000,type:'snapshot',data:{agents:[
    {id:'sniper-1',strategy:'launch-sniper',ticks:7,trades:1,refusals:2,realizedUsd:0,openValueUsd:3,equityUsd:3},
    {id:'momentum-1',strategy:'momentum',ticks:4,trades:0,refusals:1,realizedUsd:0,openValueUsd:0,equityUsd:0},
    {id:'premium-1',strategy:'premium-watch',ticks:2,trades:0,refusals:0,realizedUsd:0,openValueUsd:0,equityUsd:0},
   ],launchMonitor:{configured:true,recentEvents:[]},arbitrage:{status:'not-installed',running:false}}})
  ].join('\n')+'\n')
  const result=shadowStatus(root,now) as any
  expect(result).toMatchObject({configured:true,available:true,running:true,stale:false,summary:{mode:'shadow-mainnet',signing:false,broadcasting:false,durationMinutes:55}})
  expect(result.summary.agents.find((a:any)=>a.id==='sniper-1')).toMatchObject({ticks:7,trades:1,refusals:2})
 })

 it('fails closed when the summary is absent or stale',()=>{
  const root=mkdtempSync(join(tmpdir(),'shadow-status-'));dirs.push(root)
  expect(shadowStatus(root)).toMatchObject({configured:true,available:false,running:false,stale:true,summary:null})
  const now=Date.now()
  writeFileSync(join(root,'shadow-summary.json'),JSON.stringify({mode:'shadow-mainnet',endedAt:now-7*60*60*1000,agents:[],monitors:{}}))
  expect(shadowStatus(root,now)).toMatchObject({configured:true,available:true,stale:true})
 })
})
