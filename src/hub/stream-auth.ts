import { randomBytes,createHmac,timingSafeEqual } from 'node:crypto'
import { getAddress,isAddress,verifyMessage,zeroAddress,type Address,type Hex } from 'viem'
import type { Journal } from '../framework/journal.js'
import type { ForeverService } from './forever.js'
import { HubError } from './manual-swaps.js'

/** Vendor C (LiveKit-first). Tokens are Hub-minted; LiveKit JWT is only issued when LIVEKIT_API_KEY/SECRET are set. */
const PROVIDER = (process.env.HUB_STREAM_PROVIDER || 'livekit').toLowerCase()
const TOKEN_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 2 * 60_000

type Challenge = { vaultId: Address; address: Address; nonce: string; expiresAt: number }
type StreamSession = {
  sessionId: string
  vaultId: Address
  host: Address
  providerRoomId: string
  createdAt: number
  endedAt: number | null
  mediaState: 'idle' | 'publisher-connected' | 'playable' | 'ended'
}
type VerifiedViewer = { sessionId: string; address: Address; verifiedAt: number; expiresAt: number }
const VIEWER_VERIFICATION_TTL_MS = 30 * 60_000

export class StreamAuthService {
  private challenges = new Map<string, Challenge>()
  private sessions = new Map<string, StreamSession>()
  /** Server-issued proof that a wallet actually signed a challenge to join THIS session, not a self-reported claim. */
  private verifiedViewers = new Map<string, VerifiedViewer>()
  private mintSecret = process.env.HUB_STREAM_TOKEN_SECRET || randomBytes(32).toString('hex')
  constructor(private journal: Journal, private options: { chainId: number; forever: ForeverService }) {}

  private key(vaultId: Address, address: Address) {
    return vaultId.toLowerCase() + ':' + address.toLowerCase()
  }
  private roomId(vaultId: Address, host: Address, sessionId: string) {
    return `forever:${vaultId.toLowerCase()}:${host.toLowerCase()}:${sessionId}`
  }
  private account(v: unknown, label = 'wallet'): Address {
    if (typeof v !== 'string' || !isAddress(v) || v.toLowerCase() === zeroAddress) throw new HubError(400, 'INVALID_ADDRESS', 'Enter a valid ' + label + ' address.')
    return getAddress(v)
  }
  private vault(v: unknown): Address {
    return this.account(v, 'vault')
  }
  private challengeMessage(c: Challenge) {
    return [
      'Robinhood Trading Hub Forever stream publish',
      'chainId: ' + this.options.chainId,
      'vault: ' + c.vaultId,
      'address: ' + c.address,
      'nonce: ' + c.nonce,
      'expiresAt: ' + c.expiresAt,
    ].join('\n')
  }
  private mint(payload: Record<string, unknown>, ttlMs: number) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), 'utf8').toString('base64url')
    const sig = createHmac('sha256', this.mintSecret).update(body).digest('base64url')
    return body + '.' + sig
  }
  private livekitJwt(room: string, identity: string, canPublish: boolean) {
    const key = process.env.LIVEKIT_API_KEY
    const secret = process.env.LIVEKIT_API_SECRET
    if (!key || !secret) return null
    // Minimal JWT (HS256) for LiveKit access token shape without adding a dependency.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: key,
      sub: identity,
      nbf: now - 10,
      exp: now + Math.floor(TOKEN_TTL_MS / 1000),
      video: { roomJoin: true, room, canPublish, canSubscribe: true, canPublishData: canPublish },
    }
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const sig = createHmac('sha256', secret).update(header + '.' + body).digest('base64url')
    return header + '.' + body + '.' + sig
  }
  async challenge(input: Record<string, unknown>) {
    if (Object.keys(input).some((k) => !['vaultId', 'address'].includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported stream challenge field.')
    const vaultId = this.vault(input.vaultId)
    const address = this.account(input.address)
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    const challenge: Challenge = { vaultId, address, nonce, expiresAt }
    this.challenges.set(this.key(vaultId, address), challenge)
    this.journal.recordDecision({
      agentId: 'hub:stream',
      ts: Date.now(),
      kind: 'observe',
      detail: 'Stream publish challenge issued',
      meta: { vaultId, address, nonce, provider: PROVIDER },
    })
    return {
      vaultId,
      address,
      nonce,
      expiresAt,
      chainId: this.options.chainId,
      message: this.challengeMessage(challenge),
      provider: PROVIDER,
    }
  }
  private async requireLiveHost(vaultId: Address, address: Address) {
    const snap = await this.options.forever.list(address)
    const vault = (snap.vaults as Array<Record<string, unknown>>).find((v) => String(v.vault || v.vaultId || '').toLowerCase() === vaultId.toLowerCase())
    if (!vault) throw new HubError(404, 'VAULT_NOT_FOUND', 'Vault not found in Forever snapshot.')
    const streams = Array.isArray(vault.streams) ? (vault.streams as Array<Record<string, unknown>>) : []
    const live = streams.find((s) => String(s.host || '').toLowerCase() === address.toLowerCase() && s.live === true)
    if (!live) throw new HubError(403, 'NOT_LIVE_HOST', 'Publish requires an open on-chain Forever live session for this vault and wallet.')
    return live
  }
  private getOrCreateSession(vaultId: Address, host: Address): StreamSession {
    const existing = [...this.sessions.values()].find((s) => s.vaultId.toLowerCase() === vaultId.toLowerCase() && s.host.toLowerCase() === host.toLowerCase() && !s.endedAt)
    if (existing) return existing
    const sessionId = randomBytes(8).toString('hex')
    const session: StreamSession = {
      sessionId,
      vaultId,
      host,
      providerRoomId: this.roomId(vaultId, host, sessionId),
      createdAt: Date.now(),
      endedAt: null,
      mediaState: 'idle',
    }
    this.sessions.set(session.sessionId, session)
    this.journal.recordDecision({
      agentId: 'hub:stream',
      ts: Date.now(),
      kind: 'observe',
      detail: 'Stream session mapped',
      meta: { sessionId: session.sessionId, vaultId, host, providerRoomId: session.providerRoomId, provider: PROVIDER },
    })
    return session
  }
  async publishToken(input: Record<string, unknown>) {
    if (Object.keys(input).some((k) => !['vaultId', 'address', 'signature', 'nonce'].includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported publish-token field.')
    const vaultId = this.vault(input.vaultId)
    const address = this.account(input.address)
    const nonce = typeof input.nonce === 'string' ? input.nonce : ''
    const signature = typeof input.signature === 'string' ? (input.signature as Hex) : null
    if (!nonce || !signature) throw new HubError(400, 'INVALID_SIGNATURE', 'Provide nonce and wallet signature.')
    const challenge = this.challenges.get(this.key(vaultId, address))
    if (!challenge || challenge.nonce !== nonce) throw new HubError(401, 'CHALLENGE_REQUIRED', 'Request a fresh stream challenge first.')
    if (Date.now() >= challenge.expiresAt) {
      this.challenges.delete(this.key(vaultId, address))
      throw new HubError(401, 'CHALLENGE_EXPIRED', 'Stream challenge expired. Request again.')
    }
    const ok = await verifyMessage({ address, message: this.challengeMessage(challenge), signature })
    if (!ok) throw new HubError(401, 'BAD_SIGNATURE', 'Wallet signature does not match the challenge.')
    this.challenges.delete(this.key(vaultId, address))
    await this.requireLiveHost(vaultId, address)
    const session = this.getOrCreateSession(vaultId, address)
    session.mediaState = 'publisher-connected'
    const hubToken = this.mint({ role: 'publish', vaultId, address, sessionId: session.sessionId, room: session.providerRoomId }, TOKEN_TTL_MS)
    const livekit = this.livekitJwt(session.providerRoomId, address.toLowerCase(), true)
    return {
      role: 'publish' as const,
      provider: PROVIDER,
      sessionId: session.sessionId,
      providerRoomId: session.providerRoomId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      token: hubToken,
      livekitToken: livekit,
      livekitUrl: process.env.LIVEKIT_URL || null,
      note: livekit
        ? 'LiveKit JWT minted server-side. Browser must not receive API secrets.'
        : 'Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL to enable real ingest. Hub token alone does not open media.',
    }
  }
  /**
   * Viewer credentials are separate and less privileged than publish credentials, but
   * still require the same wallet-challenge proof — a viewer must authenticate a wallet
   * (spec §4/§11), not just self-report an address. Reward eligibility later depends on
   * this verified join, not on an unauthenticated client claim.
   */
  async viewerToken(input: Record<string, unknown>) {
    if (Object.keys(input).some((k) => !['vaultId', 'sessionId', 'address', 'signature', 'nonce'].includes(k))) {
      throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported viewer-token field.')
    }
    const vaultId = this.vault(input.vaultId)
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    const address = this.account(input.address)
    const nonce = typeof input.nonce === 'string' ? input.nonce : ''
    const signature = typeof input.signature === 'string' ? (input.signature as Hex) : null
    if (!nonce || !signature) throw new HubError(400, 'INVALID_SIGNATURE', 'Provide nonce and wallet signature. Viewers must authenticate a wallet, not self-report an address.')
    const session = this.sessions.get(sessionId)
    if (!session || session.vaultId.toLowerCase() !== vaultId.toLowerCase() || session.endedAt) {
      throw new HubError(404, 'SESSION_NOT_FOUND', 'No active stream session for this vault. Server owns room mapping; do not invent a room id.')
    }
    if (typeof input.providerRoomId === 'string') throw new HubError(400, 'UNEXPECTED_FIELD', 'Browser-supplied room ids are rejected.')
    const challenge = this.challenges.get(this.key(vaultId, address))
    if (!challenge || challenge.nonce !== nonce) throw new HubError(401, 'CHALLENGE_REQUIRED', 'Request a fresh stream challenge first.')
    if (Date.now() >= challenge.expiresAt) {
      this.challenges.delete(this.key(vaultId, address))
      throw new HubError(401, 'CHALLENGE_EXPIRED', 'Stream challenge expired. Request again.')
    }
    const ok = await verifyMessage({ address, message: this.challengeMessage(challenge), signature })
    if (!ok) throw new HubError(401, 'BAD_SIGNATURE', 'Wallet signature does not match the challenge.')
    this.challenges.delete(this.key(vaultId, address))
    const now = Date.now()
    this.verifiedViewers.set(sessionId + ':' + address.toLowerCase(), { sessionId, address, verifiedAt: now, expiresAt: now + VIEWER_VERIFICATION_TTL_MS })
    session.mediaState = session.mediaState === 'idle' ? 'playable' : session.mediaState
    const hubToken = this.mint({ role: 'viewer', vaultId, sessionId, room: session.providerRoomId, address }, TOKEN_TTL_MS)
    const livekit = this.livekitJwt(session.providerRoomId, address.toLowerCase(), false)
    return {
      role: 'viewer' as const,
      provider: PROVIDER,
      sessionId: session.sessionId,
      providerRoomId: session.providerRoomId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      token: hubToken,
      livekitToken: livekit,
      livekitUrl: process.env.LIVEKIT_URL || null,
      mediaState: session.mediaState,
    }
  }
  /**
   * Public check used by ForeverRewardsService: was this exact (sessionId, address) pair
   * proven by a wallet signature recently? Re-verifying (a fresh viewerToken call) extends
   * the window — a stale, unrenewed join stops counting toward reward eligibility.
   */
  isVerifiedViewer(sessionId: string, address: Address, now = Date.now()): boolean {
    const record = this.verifiedViewers.get(sessionId + ':' + address.toLowerCase())
    return !!record && record.expiresAt > now
  }

  /**
   * Verifies a LiveKit webhook signature (HMAC-SHA256 over the raw request body using
   * LIVEKIT_WEBHOOK_SECRET, falling back to LIVEKIT_API_SECRET). This is what closes the
   * "goLive() != actually broadcasting" gap: mediaState now reflects LiveKit's own
   * participant/track events instead of only the optimistic state set when a token was
   * minted. Never trust a browser-reported disconnect — only the provider's own webhook.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    const secret = process.env.LIVEKIT_WEBHOOK_SECRET || process.env.LIVEKIT_API_SECRET
    if (!secret || !signatureHeader) return false
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
    const a = Buffer.from(signatureHeader)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * Handles a verified LiveKit webhook event. Updates `mediaState` from the provider's
   * own reporting of participant/track lifecycle — this is the independent connectivity
   * signal the contract's on-chain `goLive` deliberately does not (and should not) assume.
   */
  handleLiveKitEvent(payload: { event?: string; room?: { name?: string }; participant?: { identity?: string } }) {
    const roomName = payload.room?.name || ''
    const session = [...this.sessions.values()].find((s) => s.providerRoomId === roomName)
    if (!session) return { handled: false as const, reason: 'unknown-room' }
    const identity = (payload.participant?.identity || '').toLowerCase()
    const isHost = identity === session.host.toLowerCase()
    switch (payload.event) {
      case 'track_published':
        if (isHost) session.mediaState = 'publisher-connected'
        break
      case 'participant_left':
        if (isHost) session.mediaState = 'idle' // publisher disconnected; on-chain endLive is a separate, explicit user action
        break
      case 'room_finished':
        session.mediaState = 'ended'
        session.endedAt = Date.now()
        break
      default:
        return { handled: false as const, reason: 'ignored-event' }
    }
    this.journal.recordDecision({
      agentId: 'hub:stream',
      ts: Date.now(),
      kind: 'observe',
      detail: 'LiveKit webhook applied: ' + payload.event,
      meta: { sessionId: session.sessionId, event: payload.event, mediaState: session.mediaState },
    })
    return { handled: true as const, sessionId: session.sessionId, mediaState: session.mediaState }
  }
  session(rawVault: string | null, rawAddress: string | null) {
    if (!rawVault || !isAddress(rawVault)) throw new HubError(400, 'INVALID_ADDRESS', 'Supply vaultId.')
    const vaultId = getAddress(rawVault)
    const host = rawAddress && isAddress(rawAddress) ? getAddress(rawAddress) : null
    const matches = [...this.sessions.values()].filter(
      (s) => s.vaultId.toLowerCase() === vaultId.toLowerCase() && !s.endedAt && (!host || s.host.toLowerCase() === host.toLowerCase()),
    )
    return {
      vaultId,
      host,
      provider: PROVIDER,
      sessions: matches.map((s) => ({
        sessionId: s.sessionId,
        providerRoomId: s.providerRoomId,
        host: s.host,
        createdAt: s.createdAt,
        mediaState: s.mediaState,
      })),
      note: 'Room ids are server-owned. goLive does not imply media publish success.',
    }
  }
  /** Test helper — constant-time compare for minted tokens. */
  verifyHubToken(token: string): boolean {
    const [body, sig] = token.split('.')
    if (!body || !sig) return false
    const expected = createHmac('sha256', this.mintSecret).update(body).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}
