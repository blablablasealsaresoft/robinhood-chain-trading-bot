import { LaunchJournal } from './launch-journal.js'
import type { Journal } from '../framework/journal.js'
import type { Asset } from './types.js'
import { erc20Abi, getRecentLaunches } from 'hoodchain'
import type { Market } from '../framework/market.js'
import type { AssetRegistry } from './assets.js'
import { HubError } from './manual-swaps.js'

export class LaunchDiscovery {

  private observer?:LaunchJournal
  private timer:ReturnType<typeof setInterval>|null=null
  private scanning:Promise<void>|null=null
  private stopping=false
  start(){
    if(this.timer||this.registry.chainId!==4663)return
    this.stopping=false
    const tick=()=>{
      if(this.scanning||this.stopping)return
      this.scanning=(async()=>{await this.observer?.recheck();if(!this.stopping)await this.recent()})().catch(()=>undefined).finally(()=>{this.scanning=null})
    }
    this.timer=setInterval(tick,60000);this.timer.unref();tick()
  }
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;await this.scanning;await this.pending?.catch(()=>undefined)}

  private cached: {at:number;result:unknown} | null = null
  private pending: Promise<unknown> | null = null
  constructor(private market:Market,private registry:AssetRegistry,journal?:Journal) {if(journal)this.observer=new LaunchJournal(market,registry,journal)}
  async recent() {
    if(this.registry.chainId!==4663)throw new HubError(422,'DISCOVERY_NETWORK','The existing launch registry supports mainnet only.')
    if(this.cached && Date.now()-this.cached.at<60000)return this.cached.result
    if(this.pending)return this.pending
    this.pending=this.read().finally(()=>{this.pending=null})
    return this.pending
  }
  private async read() {
    if(await this.market.client.public.getChainId()!==this.registry.chainId)throw new HubError(503,'CHAIN_MISMATCH','Discovery RPC network mismatch.')
    // Same SDK discovery used by Momentum, bounded to recent history for the UI.
    const launches=(await getRecentLaunches(this.market.client,{lookbackBlocks:30000n,chunkSize:10000n})).slice(-24).reverse()
    const items=[]
    for(let offset=0;offset<launches.length;offset+=4) {
      const group=await Promise.all(launches.slice(offset,offset+4).map(async launch=>{
        const [symbol,name,decimals]=await Promise.all([
          this.market.client.public.readContract({address:launch.token,abi:erc20Abi,functionName:'symbol'}).catch(()=>null),
          this.market.client.public.readContract({address:launch.token,abi:erc20Abi,functionName:'name'}).catch(()=>null),
          this.market.client.public.readContract({address:launch.token,abi:erc20Abi,functionName:'decimals'}).catch(()=>null),
        ])
        const asset=typeof symbol==='string' && typeof name==='string' && typeof decimals==='number' && decimals>=0 && decimals<=36 ?
          {id:'eip155:'+this.registry.chainId+'/erc20:'+launch.token.toLowerCase(),chainId:this.registry.chainId,address:launch.token,symbol:symbol.slice(0,32),name:name.slice(0,100),decimals,type:'launch-token' as const,source:'hoodchain/'+launch.launchpad,tradable:false} : null
        if(this.observer){
          try{const event=await this.observer.observe(launch,asset as Asset|null);return {...launch,asset,tradeEnabled:false,verification:event.status}}
          catch{return {...launch,asset:null,tradeEnabled:false,verification:'unverified'}}
        }
        if(asset)this.registry.registerDiscovered(asset)
        return {...launch,asset,tradeEnabled:false,verification:'sdk-discovery'}
      }))
      items.push(...group)
    }
    const result={chainId:this.registry.chainId,observedAt:Date.now(),lookbackBlocks:'30000',source:'hoodchain/getRecentLaunches',launches:items,
      coverage:'Recent NOXA and Odyssey events. Pool presence is not a liquidity or safety guarantee. The local playground is separate.'}
    this.cached={at:Date.now(),result}
    return result
  }
}
