import { describe, expect, it, vi } from 'vitest'
import { createReliableRpc } from '../../src/framework/rpc.js'

function json(body:unknown,status=200){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
}
function html(status=200){
  return new Response('<html>upstream error</html>',{status,headers:{'content-type':'text/html'}})
}
function rpcResult(id:number,result:unknown){return {jsonrpc:'2.0',id,result}}

describe('reliable RPC transport',()=>{
  it('falls back when the primary returns HTML and records the failover without leaking URLs',async()=>{
    const fetchFn=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input),body=JSON.parse(String(init?.body)) as {id:number;method:string}
      if(url.includes('primary'))return html()
      if(body.method==='eth_chainId')return json(rpcResult(body.id,'0x1237'))
      return json(rpcResult(body.id,'0x10'))
    })
    const rpc=createReliableRpc({network:'mainnet',primaryUrl:'https://primary.example',fallbackUrls:['https://fallback.example'],readRetries:0,fetchFn})
    expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x10')
    const diagnostics=rpc.diagnostics()
    expect(diagnostics.activeEndpoint).toBe(1)
    expect(diagnostics.endpoints[0]).toMatchObject({healthy:false,failures:1})
    expect(JSON.stringify(diagnostics)).not.toContain('primary.example')
    expect(JSON.stringify(diagnostics)).not.toContain('fallback.example')
  })

  it('skips a wrong-chain endpoint and uses a validated fallback',async()=>{
    const fetchFn=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input),body=JSON.parse(String(init?.body)) as {id:number;method:string}
      if(body.method==='eth_chainId')return json(rpcResult(body.id,url.includes('wrong')?'0x1':'0x1237'))
      return json(rpcResult(body.id,'0x20'))
    })
    const rpc=createReliableRpc({network:'mainnet',primaryUrl:'https://wrong.example',fallbackUrls:['https://good.example'],readRetries:0,fetchFn})
    expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x20')
    expect(rpc.diagnostics().endpoints[0]).toMatchObject({wrongChain:true,healthy:false})
  })

  it('retries safe reads after a rate limit and coalesces concurrent identical reads',async()=>{
    let blockCalls=0
    const fetchFn=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)) as {id:number;method:string}
      if(body.method==='eth_chainId')return json(rpcResult(body.id,'0x1237'))
      if(body.method==='eth_getBalance'){
        blockCalls++
        if(blockCalls===1)return json({jsonrpc:'2.0',id:body.id,error:{code:-32005,message:'rate limit'}})
        await new Promise(resolve=>setTimeout(resolve,5))
        return json(rpcResult(body.id,'0x5'))
      }
      return json(rpcResult(body.id,'0x1'))
    })
    const rpc=createReliableRpc({network:'mainnet',primaryUrl:'https://primary.example',readRetries:1,fetchFn})
    const args={method:'eth_getBalance',params:['0x1111111111111111111111111111111111111111','latest'] as const}
    const [a,b]=await Promise.all([rpc.request(args),rpc.request(args)])
    expect(a).toBe('0x5');expect(b).toBe('0x5')
    expect(blockCalls).toBe(2)
    expect(rpc.diagnostics()).toMatchObject({retries:1,coalesced:1})
  })

  it('caches short-lived block-number reads',async()=>{
    let calls=0
    const fetchFn=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)) as {id:number;method:string}
      if(body.method==='eth_chainId')return json(rpcResult(body.id,'0x1237'))
      calls++;return json(rpcResult(body.id,'0x30'))
    })
    const rpc=createReliableRpc({network:'mainnet',primaryUrl:'https://primary.example',readRetries:0,fetchFn})
    expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x30')
    expect(await rpc.request({method:'eth_blockNumber'})).toBe('0x30')
    expect(calls).toBe(1)
    expect(rpc.diagnostics().cacheHits).toBe(1)
  })

  it('never retries or fails over an ambiguous transaction submission',async()=>{
    let sendCalls=0
    const fetchFn=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)) as {id:number;method:string}
      if(body.method==='eth_chainId')return json(rpcResult(body.id,'0x1237'))
      if(body.method==='eth_sendRawTransaction'){
        sendCalls++
        throw new TypeError('socket closed after write')
      }
      return json(rpcResult(body.id,null))
    })
    const rpc=createReliableRpc({network:'mainnet',primaryUrl:'https://primary.example',fallbackUrls:['https://fallback.example'],readRetries:2,fetchFn})
    await expect(rpc.request({method:'eth_sendRawTransaction',params:['0xdeadbeef']})).rejects.toThrow()
    expect(sendCalls).toBe(1)
    expect(fetchFn.mock.calls.some(([url])=>String(url).includes('fallback.example'))).toBe(false)
  })
})
