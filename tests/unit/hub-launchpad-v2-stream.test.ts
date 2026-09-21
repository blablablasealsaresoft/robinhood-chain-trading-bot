import { describe, expect, it, vi } from 'vitest'
import { LaunchpadV2Service } from '../../src/hub/launchpad-v2.js'
import { StreamAuthService } from '../../src/hub/stream-auth.js'

function journal() {
  return {
    externalEvents: () => [],
    recordWalletPlan: vi.fn(),
    recordDecision: vi.fn(),
    recordExternalEvent: vi.fn(),
    dueExternalEvents: () => [],
    deferExternalEvent: vi.fn(),
  } as never
}

describe('LaunchpadV2Service', () => {
  it('reports not-configured when HUB_LAUNCH_FACTORY_V2 is unset', async () => {
    const market = { client: { wallet: undefined, account: undefined, public: {} } } as never
    const service = new LaunchpadV2Service(market, {
      chainId: 4663,
      isKilled: () => false,
      journal: journal(),
      registry: { registerDiscovered: vi.fn(), get: vi.fn(), removeDiscovered: vi.fn() } as never,
    })
    const status = await service.status()
    expect(status.version).toBe('v2')
    expect(status.status).toBe('not-configured')
    expect(status.configured).toBe(false)
    expect(status.amm.weth).toMatch(/^0x/)
  })
})

describe('StreamAuthService', () => {
  it('issues a nonce-bound challenge and rejects forged room ids on viewer path', async () => {
    const forever = { list: vi.fn(async () => ({ vaults: [] })) } as never
    const auth = new StreamAuthService(journal(), { chainId: 4663, forever })
    const challenge = await auth.challenge({
      vaultId: '0x1111111111111111111111111111111111111111',
      address: '0x2222222222222222222222222222222222222222',
    })
    expect(challenge.nonce).toHaveLength(32)
    expect(challenge.message).toContain('nonce: ' + challenge.nonce)
    expect(challenge.message).toContain('chainId: 4663')
    await expect(
      auth.viewerToken({
        vaultId: '0x1111111111111111111111111111111111111111',
        sessionId: 'missing',
        providerRoomId: 'forged',
      } as never),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_FIELD' })
  })
})
