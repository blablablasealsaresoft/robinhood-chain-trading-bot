import { getAddress,isAddress,zeroAddress,type Address } from 'viem'

const ASSETS_URL='https://api.robinhood.com/rhj/assets'
const PRICE_URL='https://api.robinhood.com/rhj/prices/'
const ASSET_CACHE_MS=60_000
const PRICE_MAX_AGE_MS=60_000

export interface StockComplianceAttestation {
  account:Address
  nonUsPerson:boolean
  jurisdictionEligible:boolean
  appropriatenessPassed:boolean
  riskDisclosuresAccepted:boolean
  taxCertificationComplete:boolean
  verifiedAt:number
  expiresAt:number
}
type AssetRow={
  tokenSymbol?:unknown;status?:unknown;deployments?:unknown;tradingCapabilities?:unknown
}
type PriceRow={tokenSymbol?:unknown;deployments?:unknown;isTradingHalt?:unknown;generatedAt?:unknown}
export type StockPolicyCheck={
  symbol:string;address:Address;direction:'acquire'|'dispose';assetStatus:string
  fractionalTradability:string|null;allDayTradability:string|null;extendedHoursFractionalTradability:boolean|null
  isTradingHalt:boolean;priceGeneratedAt:number;checkedAt:number
}

export class StockCompliancePolicy {
  private readonly attestations=new Map<string,StockComplianceAttestation>()
  private assetCache:{at:number;rows:AssetRow[]}|null=null
  private priceCache=new Map<string,{at:number;row:PriceRow}>()
  constructor(raw:string|undefined,private readonly fetcher:typeof fetch=fetch,private readonly clock:()=>number=Date.now){
    for(const a of parseAttestations(raw))this.attestations.set(a.account.toLowerCase(),a)
  }
  get configured(){return this.attestations.size>0}

  publicStatus(account:string){
    if(!isAddress(account)||account.toLowerCase()===zeroAddress)return {configured:this.attestations.size>0,eligible:false,expiresAt:null,checks:null}
    const a=this.attestations.get(getAddress(account).toLowerCase()),now=this.clock()
    if(!a)return {configured:this.attestations.size>0,eligible:false,expiresAt:null,checks:null}
    const checks={
      nonUsPerson:a.nonUsPerson,jurisdictionEligible:a.jurisdictionEligible,appropriatenessPassed:a.appropriatenessPassed,
      riskDisclosuresAccepted:a.riskDisclosuresAccepted,taxCertificationComplete:a.taxCertificationComplete,
    }
    return {configured:true,eligible:Object.values(checks).every(Boolean)&&a.verifiedAt<=now&&a.expiresAt>now,expiresAt:a.expiresAt,checks}
  }

  requireAcquisition(account:Address):StockComplianceAttestation {
    const a=this.attestations.get(account.toLowerCase()),now=this.clock()
    if(!a)throw new StockComplianceError('STOCK_COMPLIANCE_REQUIRED','This wallet does not have a current external Stock Token compliance attestation.')
    if(!Number.isSafeInteger(a.verifiedAt)||a.verifiedAt>now||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=now)
      throw new StockComplianceError('STOCK_COMPLIANCE_EXPIRED','This wallet Stock Token compliance attestation is expired or not yet valid.')
    if(!a.nonUsPerson||!a.jurisdictionEligible||!a.appropriatenessPassed||!a.riskDisclosuresAccepted||!a.taxCertificationComplete)
      throw new StockComplianceError('STOCK_COMPLIANCE_INCOMPLETE','Stock Token acquisition requires all configured compliance checks to be satisfied.')
    return a
  }

  async verifyAsset(symbol:string,address:Address,direction:'acquire'|'dispose'):Promise<StockPolicyCheck>{
    const [assets,price]=await Promise.all([this.assets(),this.price(symbol)])
    const asset=assets.find(row=>typeof row.tokenSymbol==='string'&&row.tokenSymbol.toUpperCase()===symbol.toUpperCase())
    if(!asset)throw new StockComplianceError('STOCK_ASSET_UNVERIFIED','Robinhood RHJ metadata does not list this Stock Token.')
    if(asset.status!=='ASSET_STATUS_ACTIVE')throw new StockComplianceError('STOCK_ASSET_INACTIVE','Robinhood RHJ metadata does not mark this Stock Token active.')
    const deployments=Array.isArray(asset.deployments)?asset.deployments:[]
    const matched=deployments.some((d:any)=>d&&d.chainId===4663&&typeof d.contractAddress==='string'&&isAddress(d.contractAddress)&&getAddress(d.contractAddress).toLowerCase()===address.toLowerCase())
    if(!matched)throw new StockComplianceError('STOCK_DEPLOYMENT_MISMATCH','Robinhood RHJ metadata does not match this Robinhood Chain Stock Token contract.')

    const caps=asset.tradingCapabilities&&typeof asset.tradingCapabilities==='object'?asset.tradingCapabilities as Record<string,unknown>:{}
    const fractional=typeof caps.fractionalTradability==='string'?caps.fractionalTradability.toLowerCase():null
    const allDay=typeof caps.allDayTradability==='string'?caps.allDayTradability.toLowerCase():null
    const extended=typeof caps.extendedHoursFractionalTradability==='boolean'?caps.extendedHoursFractionalTradability:null
    if(!fractional)throw new StockComplianceError('STOCK_CAPABILITY_UNAVAILABLE','Robinhood RHJ trading capabilities are unavailable for this Stock Token.')
    if(direction==='acquire'&&!['tradable','position_opening_only'].includes(fractional))
      throw new StockComplianceError('STOCK_OPENING_UNAVAILABLE','Robinhood RHJ trading capabilities do not currently permit opening this fractional Stock Token position.')
    if(direction==='dispose'&&!['tradable','position_closing_only'].includes(fractional))
      throw new StockComplianceError('STOCK_CLOSING_UNAVAILABLE','Robinhood RHJ trading capabilities do not currently permit closing this fractional Stock Token position.')
    if(direction==='acquire'&&allDay==='position_closing_only')
      throw new StockComplianceError('STOCK_OPENING_UNAVAILABLE','Robinhood RHJ all-day capability is currently closing-only for this Stock Token.')

    if(price.isTradingHalt!==false)throw new StockComplianceError('STOCK_TRADING_HALTED','Robinhood RHJ reports a trading halt or unavailable halt status for this Stock Token.')
    const generated=typeof price.generatedAt==='string'?Date.parse(price.generatedAt):NaN
    const now=this.clock()
    if(!Number.isFinite(generated)||generated>now+5000||now-generated>PRICE_MAX_AGE_MS)
      throw new StockComplianceError('STOCK_MARKET_STATUS_STALE','Robinhood RHJ trading status is stale; refresh before trading.')
    const priceDeployments=Array.isArray(price.deployments)?price.deployments:[]
    if(!priceDeployments.some((d:any)=>d&&d.chainId===4663&&typeof d.contractAddress==='string'&&isAddress(d.contractAddress)&&getAddress(d.contractAddress).toLowerCase()===address.toLowerCase()))
      throw new StockComplianceError('STOCK_PRICE_DEPLOYMENT_MISMATCH','Robinhood RHJ price metadata does not match this Robinhood Chain Stock Token contract.')

    return {symbol,address,direction,assetStatus:String(asset.status),fractionalTradability:fractional,allDayTradability:allDay,
      extendedHoursFractionalTradability:extended,isTradingHalt:false,priceGeneratedAt:generated,checkedAt:now}
  }

  private async assets():Promise<AssetRow[]> {
    const now=this.clock()
    if(this.assetCache&&now-this.assetCache.at<ASSET_CACHE_MS)return this.assetCache.rows
    const body=await getJson(this.fetcher,ASSETS_URL)
    const rows=Array.isArray((body as any)?.assets)?(body as any).assets as AssetRow[]:[]
    if(!rows.length)throw new StockComplianceError('STOCK_METADATA_UNAVAILABLE','Robinhood RHJ Stock Token metadata is unavailable.')
    this.assetCache={at:now,rows};return rows
  }
  private async price(symbol:string):Promise<PriceRow> {
    const key=symbol.toUpperCase(),now=this.clock(),cached=this.priceCache.get(key)
    if(cached&&now-cached.at<10_000)return cached.row
    const body=await getJson(this.fetcher,PRICE_URL+encodeURIComponent(key))
    const quotes=Array.isArray((body as any)?.quotes)?(body as any).quotes as PriceRow[]:[]
    const row=quotes.find(q=>typeof q.tokenSymbol==='string'&&q.tokenSymbol.toUpperCase()===key)
    if(!row)throw new StockComplianceError('STOCK_MARKET_STATUS_UNAVAILABLE','Robinhood RHJ market status is unavailable for this Stock Token.')
    this.priceCache.set(key,{at:now,row});return row
  }
}

export class StockComplianceError extends Error {
  constructor(readonly code:string,message:string){super(message)}
}

export function parseAttestations(raw:string|undefined):StockComplianceAttestation[] {
  if(!raw?.trim())return []
  let value:unknown
  try{value=JSON.parse(raw)}catch{throw new Error('HUB_STOCK_COMPLIANCE_ATTESTATIONS must be valid JSON')}
  if(!Array.isArray(value)||value.length>500)throw new Error('HUB_STOCK_COMPLIANCE_ATTESTATIONS must be an array of at most 500 wallet attestations')
  const seen=new Set<string>()
  return value.map((entry,index)=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('Stock compliance attestation '+index+' must be an object')
    const row=entry as Record<string,unknown>
    const allowed=['account','nonUsPerson','jurisdictionEligible','appropriatenessPassed','riskDisclosuresAccepted','taxCertificationComplete','verifiedAt','expiresAt']
    if(Object.keys(row).some(k=>!allowed.includes(k)))throw new Error('Stock compliance attestation '+index+' contains unsupported fields')
    if(typeof row.account!=='string'||!isAddress(row.account)||row.account.toLowerCase()===zeroAddress)throw new Error('Stock compliance attestation '+index+' account is invalid')
    const account=getAddress(row.account),key=account.toLowerCase()
    if(seen.has(key))throw new Error('Duplicate Stock Token compliance wallet '+account);seen.add(key)
    for(const k of ['nonUsPerson','jurisdictionEligible','appropriatenessPassed','riskDisclosuresAccepted','taxCertificationComplete'] as const)
      if(typeof row[k]!=='boolean')throw new Error('Stock compliance attestation '+index+' '+k+' must be boolean')
    if(!Number.isSafeInteger(row.verifiedAt)||Number(row.verifiedAt)<0||!Number.isSafeInteger(row.expiresAt)||Number(row.expiresAt)<=Number(row.verifiedAt))
      throw new Error('Stock compliance attestation '+index+' timestamps are invalid')
    return {account,nonUsPerson:row.nonUsPerson as boolean,jurisdictionEligible:row.jurisdictionEligible as boolean,appropriatenessPassed:row.appropriatenessPassed as boolean,
      riskDisclosuresAccepted:row.riskDisclosuresAccepted as boolean,taxCertificationComplete:row.taxCertificationComplete as boolean,verifiedAt:Number(row.verifiedAt),expiresAt:Number(row.expiresAt)}
  })
}

async function getJson(fetcher:typeof fetch,url:string):Promise<unknown>{
  let response:Response
  try{response=await fetcher(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(5000)})}
  catch{throw new StockComplianceError('STOCK_COMPLIANCE_UPSTREAM','Robinhood RHJ compliance metadata could not be reached.')}
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))
    throw new StockComplianceError('STOCK_COMPLIANCE_UPSTREAM','Robinhood RHJ compliance metadata returned an invalid response.')
  try{return await response.json()}catch{throw new StockComplianceError('STOCK_COMPLIANCE_UPSTREAM','Robinhood RHJ compliance metadata returned invalid JSON.')}
}
