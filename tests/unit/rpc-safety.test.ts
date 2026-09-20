import {describe,it,expect,vi} from 'vitest'
import {createPublicClient,encodeAbiParameters,encodeEventTopics,parseAbi} from 'viem'
import {robinhood} from 'viem/chains'
import {createReliableRpc,getSharedReliableRpc,rpcOptionsFromEnv} from '../../src/framework/rpc.js'
import {loadFleetConfig} from '../../src/framework/config.js'
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
const answer=(id:number,result:unknown)=>json({jsonrpc:'2.0',id,result})
const primaryUrl='https://primary.invalid',fallbackUrls=['https://fallback.invalid']

describe('RPC safety regressions',()=>{
 it.each(['eth_newFilter','eth_newBlockFilter','eth_newPendingTransactionFilter','eth_getFilterChanges','eth_getFilterLogs','eth_uninstallFilter'])('rejects stateful %s before network I/O',async method=>{
  const fetchFn=vi.fn()
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fetchFn})
  const results=await Promise.allSettled([rpc.request({method,params:['0x1']}),rpc.request({method,params:['0x1']})])
  expect(results.every(r=>r.status==='rejected'&&r.reason.code===-32004)).toBe(true)
  expect(fetchFn).not.toHaveBeenCalled()
 })
 it.each([
  ['missing result',(id:number)=>({jsonrpc:'2.0',id})],
  ['wrong id',(id:number)=>({jsonrpc:'2.0',id:id+999,result:'0xffff'})],
  ['result plus error',(id:number)=>({jsonrpc:'2.0',id,result:null,error:{code:-32000,message:'bad'}})],
  ['invalid error',(id:number)=>({jsonrpc:'2.0',id,error:{code:'429',message:'bad'}})],
  ['null error',(id:number)=>({jsonrpc:'2.0',id,error:null})],
 ] as const)('fails over invalid read envelope: %s',async(_name,envelope)=>{
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:0,fetchFn:vi.fn(async(url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   if(method==='eth_chainId')return answer(id,'0x1237')
   return String(url)===primaryUrl?json(envelope(id)):answer(id,'0x20')
  })})
  expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x20')
  expect(rpc.diagnostics().activeEndpoint).toBe(1)
 })
 it('preserves a legitimate null transaction receipt',async()=>{
  const fetchFn=vi.fn(async(_url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   return answer(id,method==='eth_chainId'?'0x1237':null)
  })
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fetchFn})
  expect(await rpc.request({method:'eth_getTransactionReceipt',params:['0x1234']})).toBeNull()
  expect(fetchFn).toHaveBeenCalledTimes(2)
 })
 it('single-flights cold endpoint validation and enforces concurrency',async()=>{
  let validations=0,active=0,peak=0
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,maxConcurrency:2,fetchFn:vi.fn(async(_url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   active++;peak=Math.max(peak,active)
   await new Promise(resolve=>setTimeout(resolve,1))
   active--
   if(method==='eth_chainId'){validations++;return answer(id,'0x1237')}
   return answer(id,'0x1')
  })})
  await Promise.all(Array.from({length:12},(_,n)=>rpc.request({method:'eth_getBalance',params:['0x'+n,'latest']})))
  expect(peak).toBeLessThanOrEqual(2)
  expect(validations).toBe(1)
 })
 it('clears failed validation and retries it after cooldown without a probe storm',async()=>{
  vi.useFakeTimers()
  try{
   let healthy=false,validations=0
   const rpc=createReliableRpc({network:'mainnet',primaryUrl,readRetries:0,fetchFn:vi.fn(async(_url,init)=>{
    const {method,id}=JSON.parse(String(init?.body))
    if(method==='eth_chainId'){
     validations++
     if(!healthy)throw new TypeError('offline')
     return answer(id,'0x1237')
    }
    return answer(id,'0x1')
   })})
   const first=await Promise.allSettled([rpc.request({method:'eth_getBalance',params:['a']}),rpc.request({method:'eth_getBalance',params:['b']})])
   expect(first.every(r=>r.status==='rejected')).toBe(true)
   expect(validations).toBe(1)
   expect(rpc.diagnostics().endpoints[0]?.failures).toBe(1)
   healthy=true
   await vi.advanceTimersByTimeAsync(1001)
   expect(await rpc.request({method:'eth_getBalance',params:['a']})).toBe('0x1')
   expect(validations).toBe(2)
  }finally{vi.useRealTimers()}
 })
 it.each(['0x1237garbage','4663','0x'])('rejects malformed chain IDs %s',async chain=>{
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:0,fetchFn:vi.fn(async(url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   return answer(id,method==='eth_chainId'?(String(url)===primaryUrl?chain:'0x1237'):'0x20')
  })})
  expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x20')
 })
 it.each(['disconnect','malformed','rate-limit','timeout'])('actual viem submission is single-attempt on %s',async failure=>{
  let sends=0,fallback=0
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:3,timeoutMs:500,fetchFn:vi.fn(async(url,init)=>{
   if(String(url)!==primaryUrl)fallback++
   const {method,id}=JSON.parse(String(init?.body))
   if(method==='eth_chainId')return answer(id,'0x1237')
   sends++
   if(failure==='malformed')return answer(id+1,'0x1234')
   if(failure==='rate-limit')return new Response('busy',{status:429})
   if(failure==='timeout')return new Promise<Response>((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})
   })
   throw new TypeError('response lost after write')
  })})
  const client=createPublicClient({chain:robinhood,transport:rpc.transport})
  await expect(client.sendRawTransaction({serializedTransaction:'0xdeadbeef'})).rejects.toThrow()
  expect(sends).toBe(1);expect(fallback).toBe(0)
 })
 it('does not retry or coalesce unknown mutating RPC methods',async()=>{
  let calls=0
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:3,fetchFn:vi.fn(async(_url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   if(method==='eth_chainId')return answer(id,'0x1237')
   calls++
   throw new TypeError('ambiguous vendor write')
  })})
  await Promise.allSettled([rpc.request({method:'vendor_mutate'}),rpc.request({method:'vendor_mutate'})])
  expect(calls).toBe(2)
  expect(rpc.diagnostics().coalesced).toBe(0)
 })
 it('keeps submission on the primary even after a read selects fallback',async()=>{
  let sends=0
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:0,fetchFn:vi.fn(async(url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   if(method.startsWith('eth_send')){sends++;return answer(id,'0x1234')}
   if(String(url)===primaryUrl)throw new TypeError('offline')
   return answer(id,method==='eth_chainId'?'0x1237':'0x1')
  })})
  await rpc.request({method:'eth_blockNumber'})
  await expect(rpc.request({method:'eth_sendRawTransaction',params:['0xdeadbeef']})).rejects.toThrow()
  expect(sends).toBe(0)
 })
 it('does not cache moving latest/pending bytecode or empty results',async()=>{
  let codeCalls=0
  const rpc=createReliableRpc({network:'mainnet',primaryUrl,fetchFn:vi.fn(async(_url,init)=>{
   const {method,id}=JSON.parse(String(init?.body))
   if(method==='eth_chainId')return answer(id,'0x1237')
   return answer(id,++codeCalls===1?'0x':'0x1234')
  })})
  for(const tag of ['latest','pending']){
   await rpc.request({method:'eth_getCode',params:['address',tag]})
   expect(await rpc.request({method:'eth_getCode',params:['address',tag]})).toBe('0x1234')
  }
  expect(codeCalls).toBe(4)
 })
 it('loads the supplied RPC environment identically for Fleet and startup',()=>{
  const env={HOOD_RPC_URL:primaryUrl,HOOD_RPC_FALLBACK_URLS:fallbackUrls[0],HOOD_RPC_MAX_CONCURRENCY:'2',HOOD_RPC_READ_RETRIES:'0',HOOD_RPC_TIMEOUT_MS:'900'}
  const options=rpcOptionsFromEnv(env),fleet=loadFleetConfig(env)
  expect(options).toMatchObject({maxConcurrency:2,readRetries:0,timeoutMs:900})
  expect(fleet).toMatchObject({rpcMaxConcurrency:2,rpcReadRetries:0,rpcTimeoutMs:900})
  expect(getSharedReliableRpc(options)).toBe(getSharedReliableRpc({network:fleet.network,primaryUrl:fleet.rpcUrl,fallbackUrls:fleet.rpcFallbackUrls,maxConcurrency:fleet.rpcMaxConcurrency,readRetries:fleet.rpcReadRetries,timeoutMs:fleet.rpcTimeoutMs}))
  expect(()=>rpcOptionsFromEnv({HOOD_RPC_MAX_CONCURRENCY:'1.5'})).toThrow()
 })

 it('two viem watchers backfill after RPC failure, fail over, and stop independently',async()=>{
  vi.useFakeTimers()
  const stops:Array<()=>void>=[]
  try {
   const abi=parseAbi(['event Ping(uint256 value)'])
   const address='0x1111111111111111111111111111111111111111' as const
   let head=10,unavailable=true
   const filterCalls:string[]=[],ranges:Array<{url:string;from:number;to:number}>=[]
   const rpc=createReliableRpc({network:'mainnet',primaryUrl,fallbackUrls,readRetries:0,fetchFn:vi.fn(async(url,init)=>{
    const {method,id,params}=JSON.parse(String(init?.body))
    if(/Filter/.test(method))filterCalls.push(method)
    if(method==='eth_chainId')return answer(id,'0x1237')
    if(method==='eth_blockNumber')return answer(id,'0x'+head.toString(16))
    if(method==='eth_getLogs'){
     const from=Number(BigInt(params[0].fromBlock)),to=Number(BigInt(params[0].toBlock))
     ranges.push({url:String(url),from,to})
     if(unavailable||String(url)===primaryUrl)return new Response('offline',{status:503})
     return answer(id,Array.from({length:to-from+1},(_,n)=>{
      const block=from+n
      return {address,blockNumber:'0x'+block.toString(16),blockHash:'0x'+'aa'.repeat(32),transactionHash:'0x'+'bb'.repeat(32),transactionIndex:'0x0',logIndex:'0x0',removed:false,topics:encodeEventTopics({abi,eventName:'Ping'}),data:encodeAbiParameters([{type:'uint256'}],[BigInt(block)])}
     }))
    }
    throw new Error('Unexpected RPC method '+method)
   })})
   const seen1:bigint[]=[],seen2:bigint[]=[],errors:unknown[]=[]
   for(const seen of [seen1,seen2]){
    const client=createPublicClient({chain:robinhood,transport:rpc.transport,cacheTime:0})
    stops.push(client.watchContractEvent({address,abi,eventName:'Ping',fromBlock:10n,pollingInterval:1000,onLogs:logs=>seen.push(...logs.map(log=>log.args.value!)),onError:error=>errors.push(error)}))
   }
   await vi.advanceTimersByTimeAsync(1001)
   expect(errors.length).toBeGreaterThan(0)
   expect(seen1).toEqual([]);expect(seen2).toEqual([])
   unavailable=false;head=11
   await vi.advanceTimersByTimeAsync(2000)
   expect(seen1).toEqual([10n,11n]);expect(seen2).toEqual([10n,11n])
   expect(ranges.some(r=>r.url===fallbackUrls[0]&&r.from===10&&r.to===11)).toBe(true)
   stops[0]!()
   head=12
   await vi.advanceTimersByTimeAsync(1000)
   expect(seen1).toEqual([10n,11n]);expect(seen2).toEqual([10n,11n,12n])
   expect(filterCalls).toEqual([])
  } finally {
   for(const stop of stops)stop()
   await vi.advanceTimersByTimeAsync(0)
   vi.useRealTimers()
  }
 })
})
