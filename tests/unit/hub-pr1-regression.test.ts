import {it,expect} from 'vitest'
import {Journal} from '../../src/framework/journal.js'
import {HubReadModel} from '../../src/hub/read-model.js'
it('review: one observation must not claim a measured value change',()=>{
 const journal=new Journal(':memory:');try{
 const account='0x1111111111111111111111111111111111111111'
 journal.recordPortfolioSnapshot({chainId:4663,account,blockNumber:'1',observedAt:Date.now(),pricedValueUsd:100,incomplete:false})
 const read=new HubReadModel({journal} as never,{} as never,{chainId:4663} as never)
 expect(read.portfolioHistory(account).changeUsd).toBeNull()
 }finally{journal.close()}
})
