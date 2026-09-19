import { formatUnits,getAddress,isAddress,parseUnits,zeroAddress,type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

const LEVELS=[10,25,50,100,250,500] as const
type DepthLevel={notionalUsd:number;available:boolean;executionPriceUsd:number|null;amountIn:string|null;amountOut:string|null;slippageBps:number|null;gasEstimate:string|null;routeHops:number|null;routeFees:number[]|null}

export class MarketDepthService {
  constructor(private market:Market,private registry:AssetRegistry,private clock:()=>number=Date.now){}
  async read(rawAsset:string|null){
    if(this.registry.chainId!==4663)throw new HubError(422,'MARKET_DEPTH_NETWORK','Market depth is available on Robinhood Chain mainnet only.')
    if(!rawAsset||!isAddress(rawAsset)||rawAsset.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ASSET','Supply a valid registered asset address.')
    const address=getAddress(rawAsset),asset=this.registry.get(address)
    if(!asset)throw new HubError(404,'UNKNOWN_ASSET','Asset is not in the Hub registry.')
    if(address.toLowerCase()===this.market.usdg.toLowerCase())throw new HubError(422,'QUOTE_ASSET','USDG is the quote asset for market depth.')

    const observedAt=this.clock()
    const reference=asset.type==='stock-token'
      ?(await this.market.stockChainlinkPrice(asset.symbol))?.priceUsd??null
      :(await this.market.spotPrice(address,asset.decimals,observedAt))?.priceUsd??null
    if(reference===null||!Number.isFinite(reference)||reference<=0)throw new HubError(422,'DEPTH_REFERENCE_UNAVAILABLE','A live reference price is unavailable for this asset.')

    const buys:DepthLevel[]=[],sells:DepthLevel[]=[]
    for(const notional of LEVELS){
      const usdgIn=parseUnits(String(notional),this.market.usdgDecimals)
      const buy=await this.market.quoteBuy(this.market.usdg,address,usdgIn)
      if(!buy||buy.amountOut<=0n)buys.push(unavailable(notional))
      else{
        const tokens=Number(formatUnits(buy.amountOut,asset.decimals))
        const execution=tokens>0?notional/tokens:null
        buys.push(level(notional,buy.amountIn,buy.amountOut,execution,buy.gasEstimate,buy.route.fees))
      }

      const tokenAmount=notional/reference
      let tokenIn:bigint
      try{tokenIn=parseUnits(decimalInput(tokenAmount,asset.decimals),asset.decimals)}catch{tokenIn=0n}
      if(tokenIn<=0n){sells.push(unavailable(notional));continue}
      const sell=await this.market.quoteSell(address,this.market.usdg,tokenIn)
      if(!sell||sell.amountOut<=0n)sells.push(unavailable(notional))
      else{
        const usdOut=Number(formatUnits(sell.amountOut,this.market.usdgDecimals))
        const tokens=Number(formatUnits(sell.amountIn,asset.decimals))
        const execution=tokens>0?usdOut/tokens:null
        sells.push(level(notional,sell.amountIn,sell.amountOut,execution,sell.gasEstimate,sell.route.fees))
      }
    }
    applySlippage(buys,'buy')
    applySlippage(sells,'sell')
    return {
      chainId:4663,observedAt,
      asset:{address:asset.address,symbol:asset.symbol,name:asset.name,decimals:asset.decimals,type:asset.type},
      quote:{address:this.market.usdg,symbol:'USDG',decimals:this.market.usdgDecimals},
      referencePriceUsd:reference,
      levelsUsd:[...LEVELS],
      buy:buys,sell:sells,
      maxExecutableBuyUsd:maxAvailable(buys),maxExecutableSellUsd:maxAvailable(sells),
      source:'hoodchain/uniswap-v3-quoter',
      note:'Executable quote-depth probes against live Uniswap v3 routing. This is not an order book, committed liquidity, or a guarantee that a later transaction receives the same price.',
    }
  }
}
function unavailable(notionalUsd:number):DepthLevel{return{notionalUsd,available:false,executionPriceUsd:null,amountIn:null,amountOut:null,slippageBps:null,gasEstimate:null,routeHops:null,routeFees:null}}
function level(notionalUsd:number,amountIn:bigint,amountOut:bigint,executionPriceUsd:number|null,gasEstimate:bigint,fees:number[]):DepthLevel{
 return{notionalUsd,available:executionPriceUsd!==null&&Number.isFinite(executionPriceUsd)&&executionPriceUsd>0,executionPriceUsd,amountIn:amountIn.toString(),amountOut:amountOut.toString(),slippageBps:null,gasEstimate:gasEstimate.toString(),routeHops:fees.length,routeFees:[...fees]}
}
function applySlippage(rows:DepthLevel[],side:'buy'|'sell'){
 const baseline=rows.find(x=>x.available&&x.executionPriceUsd!==null)?.executionPriceUsd
 if(!baseline)return
 for(const row of rows)if(row.available&&row.executionPriceUsd!==null){
   const raw=side==='buy'?(row.executionPriceUsd/baseline-1):(1-row.executionPriceUsd/baseline)
   row.slippageBps=Math.max(0,Math.round(raw*10000))
 }
}
function maxAvailable(rows:DepthLevel[]):number|null{return rows.filter(x=>x.available).at(-1)?.notionalUsd??null}
function decimalInput(value:number,decimals:number):string{
 if(!Number.isFinite(value)||value<=0)throw new Error('invalid amount')
 const precision=Math.min(decimals,18)
 const fixed=value.toFixed(precision).replace(/0+$/,'').replace(/.$/,'')
 return fixed==='0'?Math.pow(10,-precision).toFixed(precision):fixed
}
