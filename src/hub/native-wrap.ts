
import { randomUUID } from 'node:crypto'
import { weth9Abi } from 'hoodchain'
import { encodeFunctionData, getAddress, isAddress, zeroAddress } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'
import type { PreparedWrap } from './types.js'

/** Canonical WETH deposit/withdraw only. No router, approvals or backend signer. */
export class NativeWrapService {
  constructor(private market:Market,private options:{chainId:number;isKilled:()=>boolean;journal:Journal;clock?:()=>number}) {
    if(market.client.account || market.client.wallet)throw new Error('NativeWrapService requires a signer-free Market')
  }
  async prepare(input:Record<string,unknown>):Promise<PreparedWrap> {
    if(Object.keys(input).some(k=>!['chainId','account','amount','direction'].includes(k)))throw new HubError(400,'UNEXPECTED_FIELD','Unsupported conversion field.')
    if(String(input.chainId)!==String(this.options.chainId))throw new HubError(409,'CHAIN_MISMATCH','Choose the configured Robinhood Chain network.')
    if(typeof input.account!=='string'||!isAddress(input.account)||input.account.toLowerCase()===zeroAddress)throw new HubError(400,'INVALID_ACCOUNT','Connect a valid wallet.')
    if(input.direction!=='wrap'&&input.direction!=='unwrap')throw new HubError(400,'INVALID_DIRECTION','Choose wrap or unwrap.')
    if(typeof input.amount!=='string'||!/^[1-9]\d{0,77}$/.test(input.amount)||BigInt(input.amount)>=(1n<<256n))throw new HubError(400,'INVALID_AMOUNT','Supply a positive uint256 base-unit amount.')
    const guard=()=>{if(this.options.isKilled())throw new HubError(409,'KILLED','New transaction preparations are halted.')}
    guard()
    const client=this.market.client.public,account=getAddress(input.account),amount=BigInt(input.amount)
    if(await client.getChainId()!==this.options.chainId)throw new HubError(409,'CHAIN_MISMATCH','RPC network mismatch.')
    const [nativeBalance,gasPrice,code]=await Promise.all([client.getBalance({address:account,blockTag:'pending'}),client.getGasPrice(),client.getCode({address:this.market.weth})])
    if(!code||code==='0x')throw new HubError(503,'WETH_UNAVAILABLE','The configured wrapped ETH contract is unavailable.')
    if(gasPrice<=0n)throw new HubError(503,'FEE_UNAVAILABLE','A positive network fee estimate is required.')
    if(input.direction==='unwrap'){
      const balance=await client.readContract({address:this.market.weth,abi:weth9Abi,functionName:'balanceOf',args:[account]})
      if(balance<amount)throw new HubError(422,'INSUFFICIENT_BALANCE','Not enough WETH to unwrap.')
    } else if(nativeBalance<=amount)throw new HubError(422,'GAS_RESERVE','Leave ETH in your wallet to pay network fees.')
    const transaction={to:this.market.weth,data:input.direction==='wrap'?encodeFunctionData({abi:weth9Abi,functionName:'deposit'}):encodeFunctionData({abi:weth9Abi,functionName:'withdraw',args:[amount]}),value:input.direction==='wrap'?amount.toString():'0'}
    let gas:bigint
    try {gas=await client.estimateGas({account,to:transaction.to,data:transaction.data,value:BigInt(transaction.value)})}
    catch {throw new HubError(422,'SIMULATION_FAILED','Conversion simulation failed. Check funds and leave ETH for gas.')}
    if(gas<=0n)throw new HubError(503,'FEE_UNAVAILABLE','Network gas estimate is unavailable.')
    // A conservative reserve, not a guaranteed final transaction fee.
    const reserve=(gas*gasPrice*3n+1n)/2n
    if(nativeBalance<BigInt(transaction.value)+reserve)throw new HubError(422,'GAS_RESERVE','Reduce the amount and leave more ETH for network fees. Unwrapping also needs ETH for gas.')
    guard()
    const now=(this.options.clock??Date.now)(),id=randomUUID()
    const plan:PreparedWrap={kind:'native-wrap-plan',signing:'user-wallet',planId:id,chainId:this.options.chainId,account,
      direction:input.direction,amount:amount.toString(),weth:this.market.weth,transaction,expiresAt:now+60000,
      gasEstimate:gas.toString(),estimatedNetworkFeeWei:(gas*gasPrice).toString(),gasReserveWei:reserve.toString(),simulation:'passed'}
    this.options.journal.recordWalletPlan({id,chainId:plan.chainId,account,createdAt:now,expiresAt:plan.expiresAt,actions:[{kind:plan.direction,...transaction}]})
    this.options.journal.recordDecision({agentId:'hub:manual',ts:now,kind:'observe',detail:'Unsigned ETH/WETH conversion prepared',meta:{mode:'manual',planId:id,owner:account,direction:plan.direction,amount:plan.amount}})
    return plan
  }
}
