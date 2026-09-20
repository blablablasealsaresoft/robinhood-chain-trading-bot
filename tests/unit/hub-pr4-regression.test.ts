import {it,expect,vi} from 'vitest'
import {Journal} from '../../src/framework/journal.js'
import {LaunchJournal} from '../../src/hub/launch-journal.js'
it('review: disabled Hub factory must not starve the SDK reconciliation queue',async()=>{
 const journal=new Journal(':memory:');try{
 const txHash='0x'+'a'.repeat(64)
 for(let i=0;i<11;i++)journal.recordExternalEvent({id:'review-'+i,type:'launch',source:i<10?'hub-launchpad':'hoodchain/noxa',chainId:4663,txHash,owner:null,at:0,observedAt:0,status:'confirming',verification:'chain-event',title:'fixture',detail:'fixture',data:{launch:{blockNumber:'1'}}},i)
 const observer=new LaunchJournal({} as never,{chainId:4663} as never,journal)
 const observe=vi.spyOn(observer,'observe').mockResolvedValue({} as never)
 await observer.recheck()
 expect(observe).toHaveBeenCalledTimes(1)
 }finally{journal.close()}
})
