import {it,expect} from 'vitest'
import {Agent} from '../../src/framework/agent.js'
import {Journal} from '../../src/framework/journal.js'
import {KillSwitch} from '../../src/framework/kill.js'
import {FakeMarket} from './helpers/fake-market.js'
const timestamp=Date.UTC(2026,8,18,12)
const token='0x2222222222222222222222222222222222222222',quote='0x1111111111111111111111111111111111111111'
for(const hasSnapshot of [true,false])it('review: reject an unrepresented trade with '+(hasSnapshot?'same tick timestamp':'no saved state'),()=>{
 const journal=new Journal(':memory:'),kill=new KillSwitch('./review-no-kill')
 try{
 if(hasSnapshot)journal.recordAgentState({version:1,agentId:'review',strategyId:'review',mode:'paper',updatedAt:timestamp,spentDay:Date.UTC(2026,8,18),spentTodayUsd:0,lastTradeAt:null,realizedUsd:0,ticks:0,trades:0,refusals:0,lastTickAt:null,positions:[]})
 journal.recordTrade({agentId:'review',mode:'paper',ts:timestamp,side:'buy',token,tokenSymbol:'T',quoteToken:quote,quoteSymbol:'USDG',amountIn:40000000n,amountOut:1000000000000000000n,txHash:null,reason:'crash between trade and state writes',slippageBps:0,gasEstimate:1n,meta:{notionalUsd:40}})
 expect(()=>new Agent({id:'review',strategy:{id:'review',title:'Review',quote:'usdg',meta:{edge:'',failureModes:[],params:{}},tick:async()=>({intents:[],alerts:[]})},market:new FakeMarket() as never,limits:{maxPositionUsdg:100,maxDailySpendUsdg:100,maxSlippageBps:100,cooldownSeconds:0},journal,kill,mode:'paper',account:null,fleetMaxDailySpendUsdg:250,fleetSpentTodayUsd:()=>0,reportFleetSpend:()=>{},tickIntervalMs:60000,clock:()=>timestamp+1000})).toThrow()
 }finally{journal.close();kill.dispose()}
})
