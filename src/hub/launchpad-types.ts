import type { Address,Hex } from 'viem'
export type LaunchAction='create'|'contribute'|'claim'|'refund'|'withdrawProceeds'|'withdrawRemainder'
export interface LaunchTerms {name:string;symbol:string;wholeSupply:string;metadataURI:string;softCapWei:string;hardCapWei:string;durationSeconds:string}
export interface LaunchpadStatus {chainId:number;configured:boolean;factory:Address|null;deploymentBlock:string|null;status:'not-configured'|'configuration-error'|'ready'|'unavailable';message:string;killed:boolean}
export interface PreparedLaunch {
 kind:'launchpad-plan';signing:'user-wallet';planId:string;chainId:number;account:Address;action:LaunchAction
 factory:Address;sale?:Address;launchId?:string;terms?:LaunchTerms;amount:string;expiresAt:number
 transaction:{to:Address;data:Hex;value:string};simulation:'passed';gasEstimate:string;estimatedNetworkFeeWei:string;gasReserveWei:string
}
export interface SaleSnapshot {
 launchId:string;sale:Address;token:Address;creator:Address;name:string;symbol:string;metadataURI:string
 supply:string;totalRaised:string;softCap:string;hardCap:string;deadline:string;participants:string
 status:'active'|'successful'|'failed';contribution:string|null;allocation:string|null;proceedsWithdrawn:boolean;remainderWithdrawn:boolean;remainderAvailable?:string
 blockNumber:string;observedAt:number;creationTxHash:string
}
export const launchActionTitles:Record<LaunchAction,string>={create:'Create token and sale',contribute:'Contribute ETH',claim:'Claim tokens',refund:'Refund contribution',withdrawProceeds:'Withdraw proceeds',withdrawRemainder:'Withdraw remaining tokens'}
export const launchActionKinds={create:'launch-create',contribute:'launch-contribute',claim:'launch-claim',refund:'launch-refund',withdrawProceeds:'launch-proceeds',withdrawRemainder:'launch-remainder'} as const
