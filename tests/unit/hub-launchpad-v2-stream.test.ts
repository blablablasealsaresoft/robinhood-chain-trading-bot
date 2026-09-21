import { createHmac } from 'node:crypto'
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

  it('requires a signed viewer-token challenge, not a self-reported address', async () => {
    const forever = { list: vi.fn(async () => ({ vaults: [] })) } as never
    const auth = new StreamAuthService(journal(), { chainId: 4663, forever })
    await expect(
      auth.viewerToken({ vaultId: '0x1111111111111111111111111111111111111111', sessionId: 's1', address: '0x2222222222222222222222222222222222222222' }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })


  it('mints data-only viewer grants without media publish permission', () => {
    process.env.LIVEKIT_API_KEY = 'test-key'
    process.env.LIVEKIT_API_SECRET = 'test-secret'
    const forever = { list: vi.fn(async () => ({ vaults: [] })) } as never
    const auth = new StreamAuthService(journal(), { chainId: 4663, forever })
    const token = (auth as any).livekitJwt('room-1', '0xabc:viewer:nonce', false, true) as string
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: 'room-1',
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
    })
    delete process.env.LIVEKIT_API_KEY
    delete process.env.LIVEKIT_API_SECRET
  })

  it('rejects a LiveKit webhook without a valid HMAC signature, accepts one with a valid signature, and updates mediaState', () => {
    process.env.LIVEKIT_WEBHOOK_SECRET = 'test-secret'
    const forever = { list: vi.fn(async () => ({ vaults: [] })) } as never
    const auth = new StreamAuthService(journal(), { chainId: 4663, forever })
    const body = JSON.stringify({ event: 'room_finished', room: { name: 'forever:vault:host:sess1' } })
    expect(auth.verifyWebhookSignature(body, undefined)).toBe(false)
    expect(auth.verifyWebhookSignature(body, 'wrong-signature')).toBe(false)
    const validSig = createHmac('sha256', 'test-secret').update(body).digest('base64')
    expect(auth.verifyWebhookSignature(body, validSig)).toBe(true)
    // Unknown room: handled=false, no throw.
    const result = auth.handleLiveKitEvent({ event: 'room_finished', room: { name: 'forever:vault:host:sess1' } })
    expect(result.handled).toBe(false)
    delete process.env.LIVEKIT_WEBHOOK_SECRET
  })
})
