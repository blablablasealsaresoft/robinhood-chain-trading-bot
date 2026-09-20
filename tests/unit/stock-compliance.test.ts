import { describe,expect,it,vi } from 'vitest'
import { getAddress } from 'viem'
import { StockCompliancePolicy,parseAttestations } from '../../src/hub/stock-compliance.js'

const account=getAddress('0x1111111111111111111111111111111111111111')
const token=getAddress('0x3333333333333333333333333333333333333333')
const now=Date.UTC(2026,8,19,3,0,0)

function attestation(overrides:Record<string,unknown>={}){
 return {account,nonUsPerson:true,jurisdictionEligible:true,appropriatenessPassed:true,riskDisclosuresAccepted:true,taxCertificationComplete:true,verifiedAt:now-1000,expiresAt:now+86400000,...overrides}
}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})}
function policy(opts:{att?:unknown[];asset?:Record<string,unknown>;price?:Record<string,unknown>}={}){
 const asset={tokenSymbol:'AAPL',status:'ASSET_STATUS_ACTIVE',deployments:[{chainId:4663,contractAddress:token}],tradingCapabilities:{fractionalTradability:'tradable',allDayTradability:'tradable',extendedHoursFractionalTradability:true},...opts.asset}
 const price={tokenSymbol:'AAPL',deployments:[{chainId:4663,contractAddress:token}],isTradingHalt:false,generatedAt:new Date(now-5000).toISOString(),...opts.price}
 const fetcher=vi.fn(async(url:string|URL)=>String(url).includes('/assets')?json({assets:[asset]}):json({quotes:[price]})) as unknown as typeof fetch
 return {service:new StockCompliancePolicy(JSON.stringify(opts.att??[attestation()]),fetcher,()=>now),fetcher}
}

describe('Stock Token compliance attestations',()=>{
 it('requires complete wallet-scoped checks and valid timestamps',()=>{
  const {service}=policy()
  expect(service.publicStatus(account)).toMatchObject({configured:true,eligible:true,expiresAt:now+86400000})
  expect(service.requireAcquisition(account).account).toBe(account)
  const missing=new StockCompliancePolicy(undefined,fetch,()=>now)
  expect(()=>missing.requireAcquisition(account)).toThrow(/current external/)
  const incomplete=new StockCompliancePolicy(JSON.stringify([attestation({appropriatenessPassed:false})]),fetch,()=>now)
  expect(()=>incomplete.requireAcquisition(account)).toThrow(/all configured compliance checks/)
  const expired=new StockCompliancePolicy(JSON.stringify([attestation({expiresAt:now})]),fetch,()=>now)
  expect(()=>expired.requireAcquisition(account)).toThrow(/expired/)
 })
 it('rejects identity-like or unknown fields instead of collecting them',()=>{
  expect(()=>parseAttestations(JSON.stringify([{...attestation(),tin:'123'}]))).toThrow('unsupported fields')
  expect(()=>parseAttestations(JSON.stringify([{...attestation(),country:'US'}]))).toThrow('unsupported fields')
 })
})

describe('Robinhood RHJ asset policy',()=>{
 it('accepts the exact active chain deployment when trading is open and fresh',async()=>{
  const {service}=policy()
  await expect(service.verifyAsset('AAPL',token,'acquire')).resolves.toMatchObject({
   symbol:'AAPL',address:token,direction:'acquire',assetStatus:'ASSET_STATUS_ACTIVE',fractionalTradability:'tradable',allDayTradability:'tradable',isTradingHalt:false
  })
 })
 it('fails closed on inactive assets, deployment mismatch, halt, stale status, or unavailable capabilities',async()=>{
  await expect(policy({asset:{status:'ASSET_STATUS_INACTIVE'}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_ASSET_INACTIVE'})
  await expect(policy({asset:{deployments:[{chainId:4663,contractAddress:'0x4444444444444444444444444444444444444444'}]}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_DEPLOYMENT_MISMATCH'})
  await expect(policy({price:{isTradingHalt:true}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_TRADING_HALTED'})
  await expect(policy({price:{generatedAt:new Date(now-120000).toISOString()}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_MARKET_STATUS_STALE'})
  await expect(policy({asset:{tradingCapabilities:{}}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_CAPABILITY_UNAVAILABLE'})
 })
 it('respects direction-specific opening and closing restrictions',async()=>{
  await expect(policy({asset:{tradingCapabilities:{fractionalTradability:'position_opening_only',allDayTradability:'tradable'}}}).service.verifyAsset('AAPL',token,'dispose')).rejects.toMatchObject({code:'STOCK_CLOSING_UNAVAILABLE'})
  await expect(policy({asset:{tradingCapabilities:{fractionalTradability:'tradable',allDayTradability:'position_closing_only'}}}).service.verifyAsset('AAPL',token,'acquire')).rejects.toMatchObject({code:'STOCK_OPENING_UNAVAILABLE'})
  await expect(policy({asset:{tradingCapabilities:{fractionalTradability:'tradable',allDayTradability:'position_closing_only'}}}).service.verifyAsset('AAPL',token,'dispose')).resolves.toMatchObject({direction:'dispose'})
 })
 it('caches asset metadata briefly but keeps price status on a tighter window',async()=>{
  const {service,fetcher}=policy()
  await service.verifyAsset('AAPL',token,'acquire')
  await service.verifyAsset('AAPL',token,'acquire')
  expect(fetcher).toHaveBeenCalledTimes(2)
 })
})
