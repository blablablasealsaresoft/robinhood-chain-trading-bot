import { readFileSync, writeFileSync } from 'node:fs';
const t = readFileSync(new URL('../../robinhood-launchpad/src/generated/abis.ts', import.meta.url), 'utf8');
function pick(name) {
  const m = t.match(new RegExp('export const ' + name + ' = (\\[.*?\\]) as const;', 's'));
  if (!m) throw new Error('missing ' + name);
  return m[1];
}
const out = `// Generated from robinhood-launchpad/src/generated/abis.ts — LaunchFactoryV2 + SaleV2 only.
export const launchFactoryV2Abi = ${pick('launchFactoryV2Abi')} as const;
export const saleV2Abi = ${pick('saleV2Abi')} as const;
export const launchTokenAbi = ${pick('launchTokenAbi')} as const;
export const tokenFactoryAbi = ${pick('tokenFactoryAbi')} as const;
`;
writeFileSync(new URL('../src/hub/launchpad-v2-abi.ts', import.meta.url), out);
console.log('ok', out.length);
