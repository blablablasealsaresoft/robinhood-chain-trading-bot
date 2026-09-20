import {it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {existsSync,unlinkSync} from 'node:fs'
import {Fleet} from '../../src/framework/fleet.js'
import {utcDayStart} from '../../src/framework/risk.js'
import type {FleetConfig} from '../../src/framework/config.js'
const config:FleetConfig={network:'mainnet',rpcUrl:undefined,mode:'paper',hasWallet:false,privateKey:undefined,stockTokenEligible:false,fleetMaxDailySpendUsdg:250,dashboardPort:4670,killFile:'./REVIEW-NO-KILL',dbPath:':memory:',defaultLimits:{maxPositionUsdg:50,maxDailySpendUsdg:100,maxSlippageBps:100,cooldownSeconds:60}}
for(const restoreAgent of [false,true])it('restores global daily spend '+(restoreAgent?'without double counting an active agent':'even when the original agent is retired'),()=>{
 const path=join(tmpdir(),'hub-paper-'+randomUUID()+'.sqlite')
 let fleet:Fleet|undefined
 try{
  fleet=new Fleet({...config,dbPath:path})
  const now=Date.now(),usdg=fleet.market.usdg
  const id=fleet.journal.recordTrade({agentId:'saved',mode:'paper',ts:now,side:'buy',token:'0x2222222222222222222222222222222222222222',tokenSymbol:'T',quoteToken:usdg,quoteSymbol:'USDG',amountIn:40000000n,amountOut:1000000000000000000n,txHash:null,reason:'fixture',slippageBps:50,gasEstimate:1n,meta:{notionalUsd:40}})
  fleet.journal.recordAgentState({version:1,agentId:'saved',strategyId:'fixture',mode:'paper',updatedAt:now,lastTradeId:id,stateScope:'mainnet:'+usdg.toLowerCase(),spentDay:utcDayStart(now),spentTodayUsd:40,lastTradeAt:now,realizedUsd:0,ticks:1,trades:1,refusals:0,lastTickAt:now,positions:[]})
  fleet.close()
  fleet=new Fleet({...config,dbPath:path})
  if(restoreAgent)fleet.addAgents([{id:'saved',strategy:{id:'fixture',title:'Fixture',quote:'usdg',meta:{edge:'',failureModes:[],params:{}},tick:async()=>({intents:[],alerts:[]})}}])
  expect(fleet.summary().fleetSpentTodayUsd).toBe(40)
  if(restoreAgent)expect(fleet.agentStatuses()[0]?.spentTodayUsd).toBe(40)
 }finally{
  fleet?.close()
  for(const suffix of ['','-wal','-shm'])if(existsSync(path+suffix))unlinkSync(path+suffix)
 }
})
