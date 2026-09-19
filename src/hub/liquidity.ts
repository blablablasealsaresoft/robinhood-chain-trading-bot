import { randomUUID } from 'node:crypto'
import { MAINNET_ADDRESSES,V3_FEE_TIERS,erc20Abi,uniswapV3FactoryAbi } from 'hoodchain'
import { encodeFunctionData,getAddress,isAddress,zeroAddress,type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'
import { positionManagerAbi } from './liquidity-abi.js'

const TICK_SPACING:Record<number,number>={100:1,500:10,3000:60,10000:200}
const MIN_SQRT_RATIO=4295128739n
const MAX_SQRT_RATIO=1461446703485210103287273052203988822378723970342n

export interface PreparedLiquidity {
  kind:'liquidity-plan';signing:'user-wallet';planId:string;chainId:number;account:Address
  token:Address;weth:Address;fee:number;positionManager:Address;factory:Address
  tokenAmount:string;wethAmount:string;slippageBps:number;expiresAt:number
  initialSqrtPriceX96:string;tickLower:number;tickUpper:number
  approvals:Array<{to:Address;data:`0x${string}`;value:'0';token:Address;amount:string;spender:Address}>
  transaction:{to:Address;data:`0x${string}`;value:'0'}
  simulation:'requires-approval'|'passed'
  tradeAdmission:'operator-reviewed-after-verified-pool'
}

export class LiquidityService {
  readonly positionManager=MAINNET_ADDRESSES.nonfungiblePositionManager
  readonly factory=MAINNET_ADDRESSES.uniswapV3Factory
  constructor(private market:Market,private registry:AssetRegistry,private options:{chainId:number;maxSlippageBps:number;isKilled:()=>boolean;journal:Journal;clock?:()=>number}){
    if(market.client.wallet||market.client.account)throw new Error('LiquidityService requires a signer-free Market')
  }
  private guard(){if(this.options.isKilled())throw new HubError(409,'KILLED','New liquidity preparations are halted.')}
  async prepare(input:Record<string,unknown>):Promise<PreparedLiquidity>{
    const allowed=['chainId','account','token','tokenAmount','wethAmount','fee','slippageBps']
    if(Object.keys(input).some(k=>!allowed.includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Unsupported liquidity field.')
    if(this.options.chainId!==4663||String(input.chainId)!=='4663')throw new HubError(422,'LIQUIDITY_NETWORK','Manual launch liquidity is enabled only on Robinhood Chain mainnet.')
    if(typeof input.account!=='string'||!isAddress(input.account)||input.account.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ACCOUNT','Connect a valid wallet.')
    if(typeof input.token!=='string'||!isAddress(input.token)||input.token.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_TOKEN','Choose a valid launch token.')
    const account=getAddress(input.account),token=getAddress(input.token),asset=this.registry.get(token)
    if(!asset||asset.type!=='launch-token')throw new HubError(422,'LAUNCH_TOKEN_REQUIRED','Liquidity creation is limited to verified Hub launch tokens.')
    if(asset.type==='stock-token')throw new HubError(422,'STOCK_TOKEN_BLOCKED','Stock Tokens cannot use launch liquidity.')
    const tokenAmount=uint(input.tokenAmount,'token amount'),wethAmount=uint(input.wethAmount,'WETH amount')
    const fee=Number(input.fee)
    if(!Number.isInteger(fee)||!V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number]))throw new HubError(400,'INVALID_FEE','Choose a supported Uniswap v3 fee tier.')
    const slippageBps=Number(input.slippageBps)
    if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>this.options.maxSlippageBps)throw new HubError(400,'SLIPPAGE_CAP','Liquidity slippage exceeds the configured cap.')
    this.guard()
    const rpc=this.market.client.public
    if(await rpc.getChainId()!==4663)throw new HubError(503,'CHAIN_MISMATCH','Liquidity RPC network mismatch.')
    const [managerCode,factoryCode,managerFactory,managerWeth,pool,decimals,tokenBalance,wethBalance,tokenAllowance,wethAllowance]=await Promise.all([
      rpc.getCode({address:this.positionManager}),rpc.getCode({address:this.factory}),
      rpc.readContract({address:this.positionManager,abi:positionManagerAbi,functionName:'factory'}),
      rpc.readContract({address:this.positionManager,abi:positionManagerAbi,functionName:'WETH9'}),
      rpc.readContract({address:this.factory,abi:uniswapV3FactoryAbi,functionName:'getPool',args:[token,this.market.weth,fee]}),
      rpc.readContract({address:token,abi:erc20Abi,functionName:'decimals'}),
      rpc.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[account]}),
      rpc.readContract({address:this.market.weth,abi:erc20Abi,functionName:'balanceOf',args:[account]}),
      rpc.readContract({address:token,abi:erc20Abi,functionName:'allowance',args:[account,this.positionManager]}),
      rpc.readContract({address:this.market.weth,abi:erc20Abi,functionName:'allowance',args:[account,this.positionManager]}),
    ])
    if(!managerCode||managerCode==='0x'||!factoryCode||factoryCode==='0x')throw new HubError(503,'AMM_UNAVAILABLE','The canonical Uniswap v3 contracts are unavailable.')
    if(managerFactory.toLowerCase()!==this.factory.toLowerCase()||managerWeth.toLowerCase()!==this.market.weth.toLowerCase())throw new HubError(503,'AMM_MISMATCH','The position manager is not linked to the reviewed factory/WETH deployment.')
    if(pool.toLowerCase()!==zeroAddress)throw new HubError(409,'POOL_EXISTS','A pool already exists for this token and fee tier. Existing-pool liquidity requires separate review.')
    if(Number(decimals)!==asset.decimals)throw new HubError(409,'ASSET_METADATA_MISMATCH','Launch token decimals do not match the verified registry.')
    if(tokenBalance<tokenAmount||wethBalance<wethAmount)throw new HubError(422,'INSUFFICIENT_BALANCE','Wallet does not hold the reviewed token and WETH amounts.')
    const token0=token.toLowerCase()<this.market.weth.toLowerCase()?token:this.market.weth
    const token1=token0===token?this.market.weth:token
    const amount0Desired=token0===token?tokenAmount:wethAmount
    const amount1Desired=token0===token?wethAmount:tokenAmount
    const sqrtPriceX96=isqrt((amount1Desired<<192n)/amount0Desired)
    if(sqrtPriceX96<=MIN_SQRT_RATIO||sqrtPriceX96>=MAX_SQRT_RATIO)throw new HubError(422,'PRICE_OUT_OF_RANGE','Selected token/WETH ratio is outside the supported Uniswap v3 price range.')
    const spacing=TICK_SPACING[fee]!,tickLower=Math.ceil(-887272/spacing)*spacing,tickUpper=Math.floor(887272/spacing)*spacing
    const amount0Min=amount0Desired*BigInt(10000-slippageBps)/10000n
    const amount1Min=amount1Desired*BigInt(10000-slippageBps)/10000n
    const now=(this.options.clock??Date.now)(),expiresAt=now+60_000,deadline=BigInt(Math.floor(expiresAt/1000))
    const create=encodeFunctionData({abi:positionManagerAbi,functionName:'createAndInitializePoolIfNecessary',args:[token0,token1,fee,sqrtPriceX96]})
    const mint=encodeFunctionData({abi:positionManagerAbi,functionName:'mint',args:[{token0,token1,fee,tickLower,tickUpper,amount0Desired,amount1Desired,amount0Min,amount1Min,recipient:account,deadline}]})
    const transaction={to:this.positionManager,data:encodeFunctionData({abi:positionManagerAbi,functionName:'multicall',args:[[create,mint]]}),value:'0' as const}
    const approvals:PreparedLiquidity['approvals']=[]
    for(const [assetAddress,allowance,amount] of [[token,tokenAllowance,tokenAmount],[this.market.weth,wethAllowance,wethAmount]] as const){
      if(allowance<amount){
        if(allowance>0n)approvals.push({to:assetAddress,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[this.positionManager,0n]}),value:'0',token:assetAddress,amount:'0',spender:this.positionManager})
        approvals.push({to:assetAddress,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[this.positionManager,amount]}),value:'0',token:assetAddress,amount:amount.toString(),spender:this.positionManager})
      }
    }
    if(!approvals.length){
      try{await rpc.estimateGas({account,to:transaction.to,data:transaction.data,value:0n})}
      catch{throw new HubError(422,'SIMULATION_FAILED','Liquidity creation simulation failed. Review token amounts, WETH balance and fee tier.')}
    }
    this.guard()
    const planId=randomUUID()
    this.options.journal.recordWalletPlan({id:planId,chainId:4663,account,createdAt:now,expiresAt,actions:[
      ...approvals.map(a=>({kind:'approval' as const,to:a.to,data:a.data,value:'0'})),
      {kind:'liquidity-add',to:transaction.to,data:transaction.data,value:'0'},
    ]})
    this.options.journal.recordDecision({agentId:'hub:manual',ts:now,kind:'observe',detail:'Unsigned launch liquidity plan prepared',meta:{mode:'manual',owner:account,planId,token,fee,tokenAmount:tokenAmount.toString(),wethAmount:wethAmount.toString()}})
    return {kind:'liquidity-plan',signing:'user-wallet',planId,chainId:4663,account,token,weth:this.market.weth,fee,positionManager:this.positionManager,factory:this.factory,
      tokenAmount:tokenAmount.toString(),wethAmount:wethAmount.toString(),slippageBps,expiresAt,initialSqrtPriceX96:sqrtPriceX96.toString(),tickLower,tickUpper,
      approvals,transaction,simulation:approvals.length?'requires-approval':'passed',tradeAdmission:'operator-reviewed-after-verified-pool'}
  }
}

function uint(value:unknown,label:string):bigint{
  if(typeof value!=='string'||!/^[1-9]\d{0,77}$/.test(value)||BigInt(value)>=(1n<<256n))throw new HubError(400,'INVALID_AMOUNT','Supply a positive '+label+' in base units.')
  return BigInt(value)
}
function isqrt(value:bigint):bigint{
  if(value<0n)throw new Error('negative square root')
  if(value<2n)return value
  let x0=1n<<(BigInt(value.toString(2).length)>>1n),x1=(x0+value/x0)>>1n
  while(x1<x0){x0=x1;x1=(x0+value/x0)>>1n}
  return x0
}
