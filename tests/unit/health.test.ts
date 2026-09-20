import {expect,it,vi} from 'vitest'
import {probeRpc} from '../../src/hub/health.js'
it('bounds a hung RPC while retaining the independently successful probe',async()=>{
 vi.useFakeTimers()
 try{
  const report=probeRpc({getChainId:async()=>4663,getBlockNumber:()=>new Promise<bigint>(()=>{})},4663,3000)
  await vi.advanceTimersByTimeAsync(3000)
  expect(await report).toEqual({ok:false,chainId:4663,blockNumber:null,latencyMs:3000})
 }finally{vi.useRealTimers()}
})
