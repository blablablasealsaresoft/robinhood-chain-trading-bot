import { parseAbi } from 'viem'

export const foreverFactoryAbi = parseAbi([
  'function createVault(string name, string symbol, uint256 wholeSupply, string metadataURI) returns (address vault, address token)',
  'function isVault(address) view returns (bool)',
  'function getVaults(uint256 offset, uint256 limit) view returns (address[])',
])

export const foreverVaultAbi = parseAbi([
  'function buy() payable',
  'function sell(uint256 tokensIn, address recipient)',
  'function addDepth() payable',
  'function claimRewards(address recipient)',
  'function goLive(string title)',
  'function endLive()',
  'function tip(address streamer) payable',
  'function claimStreamEarnings(address recipient)',
  'function token() view returns (address)',
])

export const foreverTokenAbi = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
])
