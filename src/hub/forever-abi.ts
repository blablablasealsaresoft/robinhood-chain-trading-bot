import { parseAbi } from 'viem'

export const foreverFactoryAbi = parseAbi([
  'function createVault(string name, string symbol, uint256 wholeSupply, string metadataURI) returns (address vault, address token)',
  'function isVault(address) view returns (bool)',
  'function vaultCount() view returns (uint256)',
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
  'function creator() view returns (address)',
  'function metadataURI() view returns (string)',
  'function realEth() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function rewardPot() view returns (uint256)',
  'function participants() view returns (uint256)',
  'function pendingRewards(address account) view returns (uint256)',
  'function buyVolume(address account) view returns (uint256)',
  'function sellVolume(address account) view returns (uint256)',
  'function tradeCount(address account) view returns (uint256)',
  'function liveCount() view returns (uint256)',
  'function liveStreamers(uint256 index) view returns (address)',
  'function streams(address streamer) view returns (address host, bool live, uint256 startedAt, uint256 tipsWei, uint256 claimable, uint256 claimed, string title)',
])

export const foreverTokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])
