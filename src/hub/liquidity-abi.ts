export const positionManagerAbi = [
  {type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'WETH9',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'createAndInitializePoolIfNecessary',stateMutability:'payable',inputs:[
    {name:'token0',type:'address'},{name:'token1',type:'address'},{name:'fee',type:'uint24'},{name:'sqrtPriceX96',type:'uint160'}
  ],outputs:[{name:'pool',type:'address'}]},
  {type:'function',name:'mint',stateMutability:'payable',inputs:[{name:'params',type:'tuple',components:[
    {name:'token0',type:'address'},{name:'token1',type:'address'},{name:'fee',type:'uint24'},
    {name:'tickLower',type:'int24'},{name:'tickUpper',type:'int24'},
    {name:'amount0Desired',type:'uint256'},{name:'amount1Desired',type:'uint256'},
    {name:'amount0Min',type:'uint256'},{name:'amount1Min',type:'uint256'},
    {name:'recipient',type:'address'},{name:'deadline',type:'uint256'}
  ]}],outputs:[{name:'tokenId',type:'uint256'},{name:'liquidity',type:'uint128'},{name:'amount0',type:'uint256'},{name:'amount1',type:'uint256'}]},
  {type:'function',name:'multicall',stateMutability:'payable',inputs:[{name:'data',type:'bytes[]'}],outputs:[{name:'results',type:'bytes[]'}]},
  {type:'function',name:'positions',stateMutability:'view',inputs:[{name:'tokenId',type:'uint256'}],outputs:[
    {name:'nonce',type:'uint96'},{name:'operator',type:'address'},{name:'token0',type:'address'},{name:'token1',type:'address'},
    {name:'fee',type:'uint24'},{name:'tickLower',type:'int24'},{name:'tickUpper',type:'int24'},{name:'liquidity',type:'uint128'},
    {name:'feeGrowthInside0LastX128',type:'uint256'},{name:'feeGrowthInside1LastX128',type:'uint256'},
    {name:'tokensOwed0',type:'uint128'},{name:'tokensOwed1',type:'uint128'}
  ]}
] as const
