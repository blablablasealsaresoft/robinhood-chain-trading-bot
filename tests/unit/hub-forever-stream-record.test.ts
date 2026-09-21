import { describe, it, expect, vi } from 'vitest'
import { getAddress } from 'viem'
import { ForeverService } from '../../src/hub/forever.js'
import type { Market } from '../../src/framework/market.js'
import type { Journal } from '../../src/framework/journal.js'

const address = (n: string) => getAddress('0x' + n.repeat(40))
const factory = address('1'), vault = address('2'), token = address('3'), owner = address('4')
const block = 101n
const claimable = 900719925474099312345n
const fields = { live: false, startedAt: 1700000000n, tipsWei: 123n, claimable, claimed: 7n, title: 'Ended owner session' }

function fixture(row: unknown) {
  const writePlan = vi.fn(() => { throw new Error('Snapshot must not prepare a transaction') })
  const writeDecision = vi.fn(() => { throw new Error('Snapshot must not record a decision') })
  const rpc = {
    getChainId: async () => 4663,
    getCode: async () => '0x6000',
    getBlockNumber: async () => block,
    readContract: vi.fn(async (input: { functionName: string; blockNumber: bigint }): Promise<unknown> => {
      expect(input.blockNumber).toBe(block)
      switch (input.functionName) {
        case 'vaultCount': return 1n
        case 'getVaults': return [vault]
        case 'token': return token
        case 'creator': return owner
        case 'metadataURI': return ''
        case 'name': return 'Snapshot test'
        case 'symbol': return 'SNAP'
        case 'totalSupply': return 1000n
        case 'tokenReserve': return 900n
        case 'realEth': return 10n
        case 'rewardPot': return 1n
        case 'participants': return 1n
        case 'liveCount': return 0n
        case 'pendingRewards': return 2n
        case 'balanceOf': return 100n
        case 'buyVolume': return 10n
        case 'sellVolume': return 0n
        case 'tradeCount': return 1n
        case 'streams': return row
        default: throw new Error('Unexpected read: ' + input.functionName)
      }
    }),
  }
  const service = new ForeverService({ client: { public: rpc } } as unknown as Market, {
    chainId: 4663, factory, deploymentBlock: '1', isKilled: () => false,
    journal: { recordWalletPlan: writePlan, recordDecision: writeDecision } as unknown as Journal,
  })
  return { service, writePlan, writeDecision }
}

describe('Forever stream record decoding', () => {
  const valid: [string, unknown][] = [
    ['ABI tuple', [owner, fields.live, fields.startedAt, fields.tipsWei, fields.claimable, fields.claimed, fields.title]],
    ['named streamer field', { streamer: owner, ...fields }],
    ['legacy named host field', { host: owner, ...fields }],
  ]
  for (const [name, row] of valid) {
    it('preserves ended claims from ' + name, async () => {
      const { service, writePlan, writeDecision } = fixture(row)
      const feed = await service.list(owner)
      expect(feed.incomplete).toBe(false)
      expect(feed.vaults).toHaveLength(1)
      expect(feed.vaults[0]?.streams).toEqual([{
        vault, streamer: owner, title: fields.title, live: false,
        startedAt: fields.startedAt.toString(), tipsWei: fields.tipsWei.toString(),
        claimable: claimable.toString(), claimed: fields.claimed.toString(),
      }])
      expect(writePlan).not.toHaveBeenCalled()
      expect(writeDecision).not.toHaveBeenCalled()
    })
  }
  const malformed: [string, unknown][] = [
    ['null', null],
    ['missing claimable', { streamer: owner, ...fields, claimable: undefined }],
    ['number instead of bigint', { streamer: owner, ...fields, claimable: 42 }],
    ['invalid host', { streamer: 'not-an-address', ...fields }],
    ['invalid live state', { streamer: owner, ...fields, live: 'false' }],
  ]
  for (const [name, row] of malformed) {
    it('marks the snapshot incomplete for ' + name, async () => {
      const { service, writePlan, writeDecision } = fixture(row)
      const feed = await service.list(owner)
      expect(feed.incomplete).toBe(true)
      expect(feed.vaults).toHaveLength(0)
      expect(feed.coverage).toContain('could not be read')
      expect(writePlan).not.toHaveBeenCalled()
      expect(writeDecision).not.toHaveBeenCalled()
    })
  }
})
