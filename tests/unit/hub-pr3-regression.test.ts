import {it,expect} from 'vitest'
import {listStockTokens,listPricedStockTokens,isStockTokenAddress,MAINNET_ADDRESSES,TESTNET_STOCK_TOKENS,TESTNET_ADDRESSES} from 'hoodchain'
import {AssetRegistry,parseReviewedTradeAssets} from '../../src/hub/assets.js'
it('review: all canonical stock addresses must remain eligibility gated',()=>{
 const stock=listStockTokens().find(t=>!listPricedStockTokens().some(p=>p.address===t.address))!
 expect(isStockTokenAddress(stock.address)).toBe(true)
 const registry=new AssetRegistry(4663,{weth:MAINNET_ADDRESSES.weth,usdg:MAINNET_ADDRESSES.usdg,usdgDecimals:6,pricedStockTokens:listPricedStockTokens})
 const [asset]=parseReviewedTradeAssets(JSON.stringify([{address:stock.address,symbol:stock.symbol,name:stock.name,decimals:stock.decimals,type:'crypto'}]))
 expect(()=>registry.registerReviewed(asset!)).toThrow()
})

it('blocks known testnet Stock Token addresses even when labelled crypto',()=>{
 const registry=new AssetRegistry(46630,{weth:TESTNET_ADDRESSES.weth,usdg:TESTNET_ADDRESSES.usdg,usdgDecimals:6,pricedStockTokens:listPricedStockTokens})
 for(const address of Object.values(TESTNET_STOCK_TOKENS))expect(()=>registry.registerReviewed({address,symbol:'TEST',name:'Test',decimals:18,type:'crypto'})).toThrow('eligibility')
})
