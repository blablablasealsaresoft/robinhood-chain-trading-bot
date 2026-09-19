import { afterEach,describe,expect,it } from 'vitest'
import { Agent } from '../../src/framework/agent.js'
import { loadLiveAutomationConfig } from '../../src/framework/config.js'
import { Journal } from '../../src/framework/journal.js'
import { KillSwitch } from '../../src/framework/kill.js'
import type { Market } from '../../src/framework/market.js'
import type { Strategy } from '../../src/framework/strategy.js'
import { FakeMarket } from './helpers/fake-market.js'

const strategy:Strategy={
  id:'safe-test',title:'Safe test',quote:'usdg',meta:{edge:'test',failureModes:[],params:{}},
  async tick(){return {intents:[],alerts:[]}}
}
const limits={maxPositionUsdg:10,maxDailySpendUsdg:25,maxSlippageBps:100,cooldownSeconds:60}
const open:{journal?:Journal;kill?:KillSwitch}={}
afterEach(()=>{open.journal?.close();open.kill?.dispose();open.journal=undefined;open.kill=undefined})

function liveAgent(journal:Journal,kill:KillSwitch){
 return new Agent({id:'live-1',strategy,market:new FakeMarket() as unknown as Market,limits,journal,kill,mode:'live',account:null,
  fleetMaxDailySpendUsdg:50,fleetSpentTodayUsd:()=>0,reportFleetSpend:()=>{},tickIntervalMs:999999,stateScope:'live:test'})
}

describe('controlled live automation config',()=>{
 it('stays disabled unless the exact acknowledgement is present',()=>{
  expect(loadLiveAutomationConfig({})).toEqual({enabled:false,agents:[]})
  expect(loadLiveAutomationConfig({HUB_LIVE_AUTOMATION:'1',HUB_LIVE_AUTOMATION_AGENTS:'momentum-1'})).toEqual({enabled:false,agents:[]})
 })
 it('requires an explicit supported strategy allowlist',()=>{
  expect(()=>loadLiveAutomationConfig({HUB_LIVE_AUTOMATION:'I_UNDERSTAND_REAL_FUNDS'})).toThrow('AGENTS')
  expect(()=>loadLiveAutomationConfig({HUB_LIVE_AUTOMATION:'I_UNDERSTAND_REAL_FUNDS',HUB_LIVE_AUTOMATION_AGENTS:'llm-1'})).toThrow('unsupported')
  expect(loadLiveAutomationConfig({HUB_LIVE_AUTOMATION:'I_UNDERSTAND_REAL_FUNDS',HUB_LIVE_AUTOMATION_AGENTS:'momentum-1,premium-1'})).toEqual({enabled:true,agents:['momentum-1','premium-1']})
 })
})

describe('live automation restart reconciliation',()=>{
 it('refuses startup when a live trade exists without matching persisted state',()=>{
  const journal=open.journal=new Journal(':memory:'),kill=open.kill=new KillSwitch('/nonexistent/KILL')
  journal.recordTrade({agentId:'live-1',mode:'live',ts:100,side:'buy',token:'0x2222222222222222222222222222222222222222',tokenSymbol:'TEST',quoteToken:'0x3333333333333333333333333333333333333333',quoteSymbol:'USDG',amountIn:1n,amountOut:1n,txHash:'0x'+'a'.repeat(64) as `0x${string}`,reason:'test',slippageBps:1,gasEstimate:1n,meta:{notionalUsd:1}})
  expect(()=>liveAgent(journal,kill)).toThrow('existing trades require reconciliation')
 })
 it('refuses startup when a submission marker is unresolved',()=>{
  const journal=open.journal=new Journal(':memory:'),kill=open.kill=new KillSwitch('/nonexistent/KILL')
  journal.recordAgentState({version:1,agentId:'live-1',strategyId:'safe-test',mode:'live',updatedAt:100,lastTradeId:0,stateScope:'live:test',spentDay:0,spentTodayUsd:0,lastTradeAt:null,realizedUsd:0,ticks:0,trades:0,refusals:0,lastTickAt:null,pendingLive:{phase:'submitted',nonce:7,hash:'0x'+'b'.repeat(64),at:90},positions:[]})
  expect(()=>liveAgent(journal,kill)).toThrow('unresolved')
 })
 it('restores live daily spend from recorded notional metadata',()=>{
  const journal=open.journal=new Journal(':memory:')
  journal.recordTrade({agentId:'live-1',mode:'live',ts:100,side:'buy',token:'0x2222222222222222222222222222222222222222',tokenSymbol:'TEST',quoteToken:'0x3333333333333333333333333333333333333333',quoteSymbol:'USDG',amountIn:1n,amountOut:1n,txHash:'0x'+'c'.repeat(64) as `0x${string}`,reason:'test',slippageBps:1,gasEstimate:1n,meta:{notionalUsd:7.5}})
  expect(journal.liveSpentSince(0)).toBe(7.5)
 })
})
