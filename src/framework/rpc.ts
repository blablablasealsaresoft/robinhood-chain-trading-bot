import { custom, type Transport } from 'viem'
import { robinhood, robinhoodTestnet } from 'viem/chains'
import type { HoodNetwork } from 'hoodchain'

export interface RpcDiagnosticsSnapshot {
  activeEndpoint: number | null
  endpoints: Array<{ index:number; healthy:boolean; wrongChain:boolean; failures:number; latencyMs:number|null; lastError:string|null }>
  requests: number
  retries: number
  failovers: number
  coalesced: number
  cacheHits: number
}

export interface ReliableRpcOptions {
  network: HoodNetwork
  primaryUrl?: string
  fallbackUrls?: string[]
  maxConcurrency?: number
  readRetries?: number
  timeoutMs?: number
  fetchFn?: typeof fetch
}

type RpcArgs={method:string;params?:readonly unknown[]}
type Endpoint={url:string;validated:boolean;wrongChain:boolean;failures:number;latencyMs:number|null;lastError:string|null;cooldownUntil:number}
type CacheEntry={expiresAt:number;value:unknown}

class RpcTransportError extends Error {
  constructor(message:string, readonly retryable:boolean){super(message)}
}
class RpcResponseError extends Error {
  code?:number
  data?:unknown
  constructor(message:string,code?:number,data?:unknown,retryable=false){super(message);this.code=code;this.data=data;this.retryable=retryable}
  readonly retryable:boolean
}

class Semaphore {
  private active=0
  private queue:Array<()=>void>=[]
  constructor(private readonly limit:number){}
  async run<T>(work:()=>Promise<T>):Promise<T>{
    if(this.active>=this.limit)await new Promise<void>(resolve=>this.queue.push(resolve))
    this.active++
    try{return await work()}
    finally{
      this.active--
      this.queue.shift()?.()
    }
  }
}

const UNSAFE=/^(eth_send|eth_sign|personal_|wallet_|debug_|engine_|miner_)/
const RETRYABLE_MESSAGE=/rate.?limit|too many requests|timeout|temporar|busy|unavailable|overload/i

function cacheTtl(method:string):number {
  if(method==='eth_chainId')return 300_000
  if(method==='eth_blockNumber')return 750
  if(method==='eth_getCode')return 30_000
  return 0
}
function errorLabel(error:unknown):string {
  if(error instanceof RpcResponseError&&error.code!==undefined)return 'rpc '+error.code
  if(error instanceof Error)return error.name||'Error'
  return 'unknown'
}
function normalizedUrls(options:ReliableRpcOptions):string[] {
  const chain=options.network==='testnet'?robinhoodTestnet:robinhood
  const primary=options.primaryUrl||chain.rpcUrls.default.http[0]
  const all=[primary,...(options.fallbackUrls??[])].filter((x):x is string=>!!x)
  const unique:string[]=[]
  for(const url of all){
    let parsed:URL
    try{parsed=new URL(url)}catch{throw new Error('RPC URL must be an absolute http(s) URL')}
    if(!/^https?:$/.test(parsed.protocol))throw new Error('RPC URL must use http or https')
    if(!unique.includes(url))unique.push(url)
  }
  if(!unique.length)throw new Error('At least one RPC URL is required')
  return unique
}

export function createReliableRpc(options:ReliableRpcOptions):{
  transport:Transport
  request:(args:RpcArgs)=>Promise<unknown>
  diagnostics:()=>RpcDiagnosticsSnapshot
}{
  const expectedChainId=options.network==='testnet'?46630:4663
  const endpoints=normalizedUrls(options).map<Endpoint>(url=>({url,validated:false,wrongChain:false,failures:0,latencyMs:null,lastError:null,cooldownUntil:0}))
  const maxConcurrency=Math.max(1,Math.min(32,options.maxConcurrency??8))
  const readRetries=Math.max(0,Math.min(3,options.readRetries??1))
  const timeoutMs=Math.max(500,Math.min(30_000,options.timeoutMs??8_000))
  const fetchFn=options.fetchFn??fetch
  const semaphore=new Semaphore(maxConcurrency)
  const pending=new Map<string,Promise<unknown>>()
  const cache=new Map<string,CacheEntry>()
  let activeEndpoint:number|null=null,requests=0,retries=0,failovers=0,coalesced=0,cacheHits=0,id=0

  async function raw(endpoint:Endpoint,args:RpcArgs):Promise<unknown>{
    return semaphore.run(async()=>{
      const controller=new AbortController()
      const timer=setTimeout(()=>controller.abort(),timeoutMs)
      const started=Date.now()
      try{
        const response=await fetchFn(endpoint.url,{
          method:'POST',
          headers:{'content-type':'application/json','accept':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:++id,method:args.method,params:args.params??[]}),
          signal:controller.signal,
        })
        endpoint.latencyMs=Date.now()-started
        if(response.status===429||response.status>=500)throw new RpcTransportError('RPC HTTP '+response.status,true)
        if(!response.ok)throw new RpcTransportError('RPC HTTP '+response.status,false)
        const contentType=response.headers.get('content-type')||''
        if(!/json/i.test(contentType))throw new RpcTransportError('RPC response was not JSON',true)
        let body:any
        try{body=await response.json()}catch{throw new RpcTransportError('RPC returned invalid JSON',true)}
        if(!body||body.jsonrpc!=='2.0')throw new RpcTransportError('RPC returned an invalid JSON-RPC envelope',true)
        if(body.error){
          const code=typeof body.error.code==='number'?body.error.code:undefined
          const message=typeof body.error.message==='string'?body.error.message:'RPC request failed'
          const retryable=code===-32005||RETRYABLE_MESSAGE.test(message)
          throw new RpcResponseError(message,code,body.error.data,retryable)
        }
        return body.result
      } catch(error){
        if(error instanceof RpcTransportError||error instanceof RpcResponseError)throw error
        if((error as {name?:string})?.name==='AbortError')throw new RpcTransportError('RPC request timed out',true)
        throw new RpcTransportError('RPC network request failed',true)
      } finally {clearTimeout(timer)}
    })
  }

  async function validate(endpoint:Endpoint):Promise<void>{
    if(endpoint.validated)return
    if(endpoint.wrongChain)throw new RpcTransportError('RPC endpoint is on the wrong chain',false)
    const result=await raw(endpoint,{method:'eth_chainId'})
    const chainId=typeof result==='string'?Number.parseInt(result,16):Number.NaN
    if(chainId!==expectedChainId){
      endpoint.wrongChain=true
      endpoint.lastError='wrong-chain'
      throw new RpcTransportError('RPC endpoint is on the wrong chain',false)
    }
    endpoint.validated=true
  }

  async function runRead(args:RpcArgs):Promise<unknown>{
    let last:unknown
    const now=Date.now()
    for(let index=0;index<endpoints.length;index++){
      const endpoint=endpoints[index]!
      if(endpoint.wrongChain||endpoint.cooldownUntil>now)continue
      try{await validate(endpoint)}catch(error){
        endpoint.failures++;endpoint.lastError=errorLabel(error);last=error
        if(endpoint.wrongChain)continue
        if(!(error as {retryable?:boolean}).retryable)throw error
        endpoint.cooldownUntil=Date.now()+Math.min(30_000,1_000*Math.max(1,endpoint.failures))
        continue
      }
      for(let attempt=0;attempt<=readRetries;attempt++){
        try{
          requests++
          const value=await raw(endpoint,args)
          endpoint.failures=0;endpoint.lastError=null;endpoint.cooldownUntil=0
          if(activeEndpoint!==null&&activeEndpoint!==index)failovers++
          activeEndpoint=index
          return value
        }catch(error){
          last=error
          endpoint.failures++;endpoint.lastError=errorLabel(error)
          const retryable=(error as {retryable?:boolean}).retryable===true
          if(!retryable)throw error
          if(attempt<readRetries){retries++;continue}
          endpoint.cooldownUntil=Date.now()+Math.min(30_000,1_000*Math.max(1,endpoint.failures))
        }
      }
    }
    throw last instanceof Error?last:new RpcTransportError('No healthy RPC endpoint is available',true)
  }

  async function runUnsafe(args:RpcArgs):Promise<unknown>{
    const endpoint=endpoints.find(x=>!x.wrongChain&&x.cooldownUntil<=Date.now())??endpoints.find(x=>!x.wrongChain)
    if(!endpoint)throw new RpcTransportError('No RPC endpoint is available',false)
    await validate(endpoint)
    requests++
    // Deliberately one request to one endpoint: retry/failover after an ambiguous submission
    // can duplicate a transaction.
    const value=await raw(endpoint,args)
    activeEndpoint=endpoints.indexOf(endpoint)
    return value
  }

  async function request(args:RpcArgs):Promise<unknown>{
    const unsafe=UNSAFE.test(args.method)
    if(unsafe)return runUnsafe(args)
    const key=args.method+':'+JSON.stringify(args.params??[])
    const ttl=cacheTtl(args.method),cached=cache.get(key)
    if(cached&&cached.expiresAt>Date.now()){cacheHits++;return cached.value}
    const existing=pending.get(key)
    if(existing){coalesced++;return existing}
    const work=runRead(args).then(value=>{
      if(ttl>0){
        cache.set(key,{expiresAt:Date.now()+ttl,value})
        if(cache.size>256)cache.delete(cache.keys().next().value!)
      }
      return value
    }).finally(()=>pending.delete(key))
    pending.set(key,work)
    return work
  }

  const provider={request}
  return {
    transport:custom(provider),
    request,
    diagnostics:()=>({
      activeEndpoint,
      endpoints:endpoints.map((e,index)=>({index,healthy:e.validated&&!e.wrongChain&&e.cooldownUntil<=Date.now(),wrongChain:e.wrongChain,failures:e.failures,latencyMs:e.latencyMs,lastError:e.lastError})),
      requests,retries,failovers,coalesced,cacheHits,
    }),
  }
}
