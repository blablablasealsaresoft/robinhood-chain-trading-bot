import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {main:'src/main.ts', 'hub-main':'src/hub-main.ts', index:'src/index.ts', rpc:'src/framework/rpc.ts'},
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  // better-sqlite3 is a native addon; never bundle it.
  external: ['better-sqlite3', 'hoodchain', 'viem', 'ws'],
  banner: { js: '#!/usr/bin/env node' },
})
