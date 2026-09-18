import {it,expect,vi} from 'vitest'
import {HubReadModel} from '../../src/hub/read-model.js'
function setup(count:number,liquid=true){
 const assets=Array.from({length:count},(_,i)=>({address:('0x'+(i+1).toString(16).padStart(40,'0')) as `0x${string}`,symbol:'TOKEN'+i,name:'Token',decimals:18,type:'launch-token',chainId:4663,source:'fixture',tradable:false,id:'token'+i}))
 const spotPrice=vi.fn(async(address:string)=>liquid?{token:address,priceUsd:2,via:'usdg',ts:Date.now()}:null)
 const market={weth:'0x8888888888888888888888888888888888888888',usdg:'0x9999999999999999999999999999999999999999',ethUsd:async()=>2000,spotPrice,client:{public:{getChainId:async()=>4663,getBlockNumber:async()=>123n,getBalance:async()=>0n,multicall:async()=>assets.map(()=>({status:'success',result:1000000000000000000n}))}}}
 const read=new HubReadModel({journal:{recordPortfolioSnapshot:()=>{}},agentStatuses:()=>[],summary:()=>({})} as never,market as never,{chainId:4663,list:()=>assets} as never)
 return {read,spotPrice,assets}
}
const account='0x1111111111111111111111111111111111111111'
it('review: cache hits should leave room to price the 25th held token',async()=>{
 const {read,assets}=setup(25);await read.portfolio(account);const next=await read.portfolio(account)
 expect(next.holdings.find(h=>h.asset.address===assets[24]!.address)?.priceUsd).toBe(2)
})
it('review: a no-route result should be cached across immediate refreshes',async()=>{
 const {read,spotPrice}=setup(1,false);await read.portfolio(account);await read.portfolio(account)
 expect(spotPrice).toHaveBeenCalledTimes(1)
})
