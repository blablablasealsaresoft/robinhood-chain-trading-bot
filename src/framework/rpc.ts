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


function integerOption(value:number|undefined,fallback:number,min:number,max:number):number {
  const result=value??fallback
  if(!Number.isInteger(result)||result<min||result>max)throw new Error('RPC numeric configuration is outside its supported integer range')
  return result
}

/** Shared by Market configuration and the verified launch startup path. */
export function rpcOptionsFromEnv(env:NodeJS.ProcessEnv=process.env):ReliableRpcOptions {
  const number=(name:string,fallback:number,min:number,max:number)=>
    integerOption(env[name]===undefined||env[name]===''?undefined:Number(env[name]),fallback,min,max)
  return {
    network:env.HOOD_NETWORK==='testnet'?'testnet':'mainnet',
    primaryUrl:env.HOOD_RPC_URL||undefined,
    fallbackUrls:(env.HOOD_RPC_FALLBACK_URLS||'').split(',').map(url=>url.trim()).filter(Boolean),
    maxConcurrency:number('HOOD_RPC_MAX_CONCURRENCY',8,1,32),
    readRetries:number('HOOD_RPC_READ_RETRIES',1,0,3),
    timeoutMs:number('HOOD_RPC_TIMEOUT_MS',8000,500,30000),
  }
}

type RpcArgs={method:string;params?:readonly unknown[]}
type Endpoint={url:string;validated:boolean;validation?:Promise<void>;wrongChain:boolean;failures:number;latencyMs:number|null;lastError:string|null;cooldownUntil:number}
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

// Only explicitly idempotent reads may retry, coalesce or use another endpoint.
const READ_METHODS=new Set([
  'eth_chainId','eth_blockNumber','eth_call','eth_estimateGas','eth_createAccessList',
  'eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_blobBaseFee',
  'eth_getBalance','eth_getCode','eth_getStorageAt','eth_getProof','eth_getTransactionCount',
  'eth_getBlockByHash','eth_getBlockByNumber','eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber','eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex','eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionReceipt','eth_getBlockReceipts','eth_getLogs',
  'eth_getUncleByBlockHashAndIndex','eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash','eth_getUncleCountByBlockNumber',
  'eth_syncing','net_version','net_listening','web3_clientVersion',
])
const FILTER_METHODS=new Set([
  'eth_newFilter','eth_newBlockFilter','eth_newPendingTransactionFilter',
  'eth_getFilterChanges','eth_getFilterLogs','eth_uninstallFilter',
])
const RETRYABLE_MESSAGE=/rate.?limit|too many requests|timeout|temporar|busy|unavailable|overload/i

function cacheTtl(args:RpcArgs):number {
  const {method,params}=args
  if(method==='eth_chainId')return 300_000
  if(method==='eth_blockNumber')return 750
  // Moving latest/pending code (including negative results) must not be cached.
  if(method==='eth_getCode'&&typeof params?.[1]==='string'&&/^0x[0-9a-f]+$/i.test(params[1]))return 30_000
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

export type ReliableRpc={
  transport:Transport
  request:(args:RpcArgs)=>Promise<unknown>
  diagnostics:()=>RpcDiagnosticsSnapshot
}

const sharedRpc=new Map<string,ReliableRpc>()

export function getSharedReliableRpc(options:ReliableRpcOptions):ReliableRpc {
  if(options.fetchFn)return createReliableRpc(options)
  const key=JSON.stringify({
    network:options.network,
    primaryUrl:options.primaryUrl??null,
    fallbackUrls:options.fallbackUrls??[],
    maxConcurrency:options.maxConcurrency??8,
    readRetries:options.readRetries??1,
    timeoutMs:options.timeoutMs??8000,
  })
  const existing=sharedRpc.get(key)
  if(existing)return existing
  const created=createReliableRpc(options)
  sharedRpc.set(key,created)
  return created
}

export function createReliableRpc(options:ReliableRpcOptions):{
  transport:Transport
  request:(args:RpcArgs)=>Promise<unknown>
  diagnostics:()=>RpcDiagnosticsSnapshot
}{
  const expectedChainId=options.network==='testnet'?46630:4663
  const endpoints=normalizedUrls(options).map<Endpoint>(url=>({url,validated:false,wrongChain:false,failures:0,latencyMs:null,lastError:null,cooldownUntil:0}))
  const maxConcurrency=integerOption(options.maxConcurrency,8,1,32)
  const readRetries=integerOption(options.readRetries,1,0,3)
  const timeoutMs=integerOption(options.timeoutMs,8000,500,30000)
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
      const requestId=++id
      try{
        const response=await fetchFn(endpoint.url,{
          method:'POST',
          headers:{'content-type':'application/json','accept':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:requestId,method:args.method,params:args.params??[]}),
          signal:controller.signal,
        })
        endpoint.latencyMs=Date.now()-started
        if(response.status===429||response.status>=500)throw new RpcTransportError('RPC HTTP '+response.status,true)
        if(!response.ok)throw new RpcTransportError('RPC HTTP '+response.status,false)
        const contentType=response.headers.get('content-type')||''
        if(!/json/i.test(contentType))throw new RpcTransportError('RPC response was not JSON',true)
        let body:any
        try{body=await response.json()}catch{throw new RpcTransportError('RPC returned invalid JSON',true)}
        const hasResult=body&&Object.prototype.hasOwnProperty.call(body,'result')
        const hasError=body&&Object.prototype.hasOwnProperty.call(body,'error')
        if(!body||typeof body!=='object'||Array.isArray(body)||body.jsonrpc!=='2.0'||
          body.id!==requestId||hasResult===hasError)
          throw new RpcTransportError('RPC returned an invalid JSON-RPC envelope',true)
        if(hasError){
          if(!body.error||typeof body.error!=='object'||Array.isArray(body.error)||
            !Number.isInteger(body.error.code)||typeof body.error.message!=='string')
            throw new RpcTransportError('RPC returned an invalid error envelope',true)
          const {code,message,data}=body.error
          const retryable=code===-32005||code===429||RETRYABLE_MESSAGE.test(message)
          throw new RpcResponseError(message,code,data,retryable)
        }
        return body.result
      } catch(error){
        if(error instanceof RpcTransportError||error instanceof RpcResponseError)throw error
        if((error as {name?:string})?.name==='AbortError')throw new RpcTransportError('RPC request timed out',true)
        throw new RpcTransportError('RPC network request failed',true)
      } finally {clearTimeout(timer)}
    })
  }

  function failed(endpoint:Endpoint,error:unknown):void {
    endpoint.failures++
    endpoint.lastError=endpoint.wrongChain?'wrong-chain':errorLabel(error)
    if((error as {retryable?:boolean}).retryable)
      endpoint.cooldownUntil=Date.now()+Math.min(30_000,1_000*endpoint.failures)
  }

  async function validate(endpoint:Endpoint):Promise<void>{
    if(endpoint.wrongChain)throw new RpcTransportError('RPC endpoint is on the wrong chain',false)
    if(endpoint.validated)return
    if(!endpoint.validation){
      endpoint.validation=(async()=>{
        try {
          const result=await raw(endpoint,{method:'eth_chainId'})
          if(typeof result!=='string'||!/^0x[0-9a-f]+$/i.test(result))
            throw new RpcTransportError('RPC returned an invalid chain ID',true)
          if(BigInt(result)!==BigInt(expectedChainId)){
            endpoint.wrongChain=true
            throw new RpcTransportError('RPC endpoint is on the wrong chain',false)
          }
          endpoint.validated=true
        }catch(error){failed(endpoint,error);throw error}
      })().finally(()=>{endpoint.validation=undefined})
    }
    await endpoint.validation
  }

  async function runRead(args:RpcArgs):Promise<unknown>{
    let last:unknown
    const now=Date.now()
    for(let index=0;index<endpoints.length;index++){
      const endpoint=endpoints[index]!
      if(endpoint.wrongChain||endpoint.cooldownUntil>now)continue
      try{await validate(endpoint)}catch(error){
        last=error
        if(endpoint.wrongChain)continue
        if(!(error as {retryable?:boolean}).retryable)throw error
        continue
      }
      for(let attempt=0;attempt<=readRetries;attempt++){
        try{
          requests++
          const value=await raw(endpoint,args)
          endpoint.failures=0;endpoint.lastError=null;endpoint.cooldownUntil=0
          if((index>0||activeEndpoint!==null)&&activeEndpoint!==index)failovers++
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
    // Unknown methods and writes are primary-only, never coalesced or replayed.
    const endpoint=endpoints[0]!
    if(endpoint.wrongChain||endpoint.cooldownUntil>Date.now())
      throw new RpcTransportError('Primary RPC endpoint is unavailable for this operation',false)
    await validate(endpoint)
    requests++
    try {
      const value=await raw(endpoint,args)
      activeEndpoint=0
      endpoint.failures=0;endpoint.lastError=null;endpoint.cooldownUntil=0
      return value
    }catch(error){failed(endpoint,error);throw error}
  }

  async function request(args:RpcArgs):Promise<unknown>{
    // Node-local filter IDs cannot survive endpoint changes. Reject before any
    // I/O so viem's existing watchers use stateless block-range getLogs instead.
    if(FILTER_METHODS.has(args.method))
      throw new RpcResponseError('Stateful filters are unsupported; use block-range logs',-32004)
    if(!READ_METHODS.has(args.method))return runUnsafe(args)
    const key=args.method+':'+JSON.stringify(args.params??[])
    const ttl=cacheTtl(args),cached=cache.get(key)
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
    transport:custom(provider,{retryCount:0}),
    request,
    diagnostics:()=>({
      activeEndpoint,
      endpoints:endpoints.map((e,index)=>({index,healthy:e.validated&&!e.wrongChain&&e.cooldownUntil<=Date.now(),wrongChain:e.wrongChain,failures:e.failures,latencyMs:e.latencyMs,lastError:e.lastError})),
      requests,retries,failovers,coalesced,cacheHits,
    }),
  }
}
