
import { createHoodClient,MAINNET_ADDRESSES,weth9Abi } from 'hoodchain'
import { encodeFunctionData } from 'viem'
const client=createHoodClient({chain:'mainnet'}).public
const account='0x1111111111111111111111111111111111111111' as const
const chain=await client.getChainId()
if(chain!==4663)throw new Error('Wrong chain')
const weth=MAINNET_ADDRESSES.weth
const code=await client.getCode({address:weth})
const gas=await client.estimateGas({account,to:weth,data:encodeFunctionData({abi:weth9Abi,functionName:'deposit'}),value:10000000000000000n,stateOverride:[{address:account,balance:10n**18n}]})
const status=await fetch('http://127.0.0.1:4670/api/status').then(r=>r.json()) as {capabilities:Record<string,boolean>}
const invalid=await fetch('http://127.0.0.1:4670/api/wrap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chainId:4663,account,direction:'wrap',amount:'0'})})
const unknown=await fetch('http://127.0.0.1:4670/api/activity/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId:'unknown-smoke',transactionHash:'0x'+'a'.repeat(64)})})
console.log(JSON.stringify({chain,wethContractExists:!!code&&code!=='0x',depositSimulationGas:gas.toString(),simulationUsesTemporaryBalanceOverride:true,capabilities:{nativeWrap:status.capabilities.nativeWrap,walletReceiptVerification:status.capabilities.walletReceiptVerification},invalidAmountRejected:invalid.status===400,unknownPlanRejected:unknown.status===404,broadcast:false}))
