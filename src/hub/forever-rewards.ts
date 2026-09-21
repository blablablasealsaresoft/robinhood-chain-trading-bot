import { randomUUID, createHash } from 'node:crypto'
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, keccak256, encodePacked, zeroAddress, type Address, type Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'
import { foreverCommunityVaultAbi } from './forever-community-abi.js'
import { RateLimiter } from './rate-limiter.js'

/// Off-chain scoring → on-chain Merkle commit, for the ONE bucket a smart contract cannot
/// verify unaided: the combined viewer + social participation pot (10% of the swap fee).
/// Holders (55%), streamers (15%), sealed depth, and the platform bucket never touch this
/// module — they stay fully automatic on-chain, per the locked bucket design in
/// docs/hub/FOREVER-FLAGSHIP.md. This module never signs or broadcasts. It builds the
/// leaves/root/plan; the epoch operator (the owner's own reviewed wallet — ideally itself
/// a multisig — never a hot key) signs the commit like any other Hub wallet action.

export interface EpochLeaf { account: Address; amountWei: string }
export interface ViewerAttestation {
  vault: Address; account: Address; sessionId: string; watchSeconds: number; presenceProofs: number; recordedAt: number
}
export interface SocialAttestation {
  vault: Address; account: Address; campaignId: string; contributionType: string; score: number; recordedAt: number; reviewedBy: Address
  contentHash?: string; referredAccount?: Address
}
export interface Campaign {
  id: string; vault: Address; description: string; contributionTypes: string[]
  maxScoreBudget: number; awardedScore: number; startAt: number; endAt: number; createdBy: Address; active: boolean
}
/** Narrow dependency on StreamAuthService — avoids a circular import, and makes the
 * "viewer must be wallet-verified via a server-issued session" requirement explicit. */
export interface ViewerSessionVerifier { isVerifiedViewer(sessionId: string, address: Address, now?: number): boolean }
interface Options { chainId: number; journal: Journal; epochOperator: Address; streamAuth: ViewerSessionVerifier }

const MIN_WATCH_SECONDS = 60
const MIN_PRESENCE_PROOFS = 2
/** Caps how many distinct qualifying sessions count toward one account's score per epoch —
 * without this, a wallet could join unlimited sessions to inflate its share unboundedly. */
const MAX_QUALIFYING_SESSIONS_PER_ACCOUNT = 5

function account(v: unknown, label = 'wallet'): Address {
  if (typeof v !== 'string' || !isAddress(v) || v.toLowerCase() === zeroAddress) throw new HubError(400, 'INVALID_ADDRESS', 'Enter a valid ' + label + ' address.')
  return getAddress(v)
}
function vaultAddr(v: unknown): Address { return account(v, 'vault') }

/** keccak256(abi.encodePacked(address,uint256)) — must match ForeverCommunityVault.claimParticipationReward. */
export function leafHash(leaf: EpochLeaf): Hex {
  return keccak256(encodePacked(['address', 'uint256'], [leaf.account, BigInt(leaf.amountWei)]))
}
function pairHash(a: Hex, b: Hex): Hex {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a]
  return keccak256(encodePacked(['bytes32', 'bytes32'], [lo, hi]))
}
/** Standard sorted-pair Merkle tree (matches OpenZeppelin MerkleProof.verify with sorted pairs). */
export function buildMerkleTree(leaves: EpochLeaf[]): { root: Hex; proofs: Map<string, Hex[]>; total: bigint } {
  if (!leaves.length) throw new HubError(400, 'EMPTY_EPOCH', 'No eligible leaves for this epoch.')
  const total = leaves.reduce((sum, l) => sum + BigInt(l.amountWei), 0n)
  let layer: Hex[] = leaves.map(leafHash)
  const layers: Hex[][] = [layer]
  while (layer.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pairHash(layer[i]!, layer[i + 1]!) : layer[i]!)
    layers.push(next)
    layer = next
  }
  const root = layer[0]!
  const proofs = new Map<string, Hex[]>()
  leaves.forEach((leaf, index) => {
    const proof: Hex[] = []
    let idx = index
    for (let level = 0; level < layers.length - 1; level++) {
      const nodes = layers[level]!
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1
      if (siblingIdx < nodes.length) proof.push(nodes[siblingIdx]!)
      idx = Math.floor(idx / 2)
    }
    proofs.set(leaf.account.toLowerCase() + ':' + leaf.amountWei, proof)
  })
  return { root, proofs, total }
}

export class ForeverRewardsService {
  /** Anti-bot: per-wallet call-rate limits on the two attestation surfaces. Neither
   * limit is a substitute for the wallet-signature/campaign checks below — it just
   * bounds how fast one wallet can hammer the endpoints. */
  private viewerLimiter = new RateLimiter(60_000, 12) // 12 heartbeats/min/wallet
  private socialLimiter = new RateLimiter(3_600_000, 20) // 20 social attestations/hour/wallet
  private excluded = new Set<string>() // 'vault:account' — cluster-excluded before an epoch closes

  constructor(private market: Market, private options: Options) {
    if (market.client.wallet || market.client.account) throw new Error('ForeverRewardsService requires a signer-free Market')
  }

  /**
   * Records a viewer's self-reported watch metrics (watch time, interaction proofs) for
   * an ALREADY wallet-verified session. This call does not itself prove wallet ownership
   * — that proof happened when the viewer called `POST /api/stream/viewer-token` with a
   * signed challenge (see StreamAuthService.viewerToken). We require that verification
   * to still be live (`isVerifiedViewer`) so an attacker can't post fabricated metrics for
   * a session/wallet pair that never actually authenticated. `sessionId` must be the
   * server-issued id from stream-auth, not a client-invented string. Rate-limited per
   * wallet to bound heartbeat spam independent of the scoring-side dedup.
   */
  recordViewerAttestation(input: Record<string, unknown>): ViewerAttestation {
    const allowed = ['vault', 'account', 'sessionId', 'watchSeconds', 'presenceProofs']
    if (Object.keys(input).some((k) => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported viewer attestation field.')
    const vault = vaultAddr(input.vault)
    const acct = account(input.account)
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.length <= 64 ? input.sessionId : ''
    const watchSeconds = Number(input.watchSeconds)
    const presenceProofs = Number(input.presenceProofs)
    if (!sessionId) throw new HubError(400, 'INVALID_SESSION', 'Provide a valid server-issued session id.')
    if (!Number.isInteger(watchSeconds) || watchSeconds < 0 || watchSeconds > 86400) throw new HubError(400, 'INVALID_WATCH_SECONDS', 'Watch seconds out of bounds.')
    if (!Number.isInteger(presenceProofs) || presenceProofs < 0 || presenceProofs > 1000) throw new HubError(400, 'INVALID_PRESENCE_PROOFS', 'Presence proof count out of bounds.')
    if (!this.options.streamAuth.isVerifiedViewer(sessionId, acct)) {
      throw new HubError(403, 'VIEWER_NOT_VERIFIED', 'This wallet has not authenticated a viewer session (POST /api/stream/viewer-token with a wallet signature) recently enough. Self-reported attendance without wallet proof is rejected.')
    }
    if (!this.viewerLimiter.allow(acct.toLowerCase())) throw new HubError(429, 'RATE_LIMITED', 'Too many viewer heartbeats from this wallet. Slow down.')
    const record: ViewerAttestation = { vault, account: acct, sessionId, watchSeconds, presenceProofs, recordedAt: Date.now() }
    this.options.journal.recordExternalEvent(
      { id: 'forever-viewer:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + acct.toLowerCase() + ':' + sessionId, type: 'forever-viewer-attestation', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: acct, at: record.recordedAt, observedAt: record.recordedAt, status: 'confirmed', verification: 'self-attested', title: 'Viewer attendance recorded', detail: sessionId, data: { ...record } },
      Number.MAX_SAFE_INTEGER,
    )
    return record
  }

  /**
   * Creates a campaign with an explicit criteria set, a hard score budget, and a
   * fixed window — never "post once, guaranteed reward." Only the reviewed epoch
   * operator may create campaigns.
   */
  createCampaign(input: Record<string, unknown>): Campaign {
    const allowed = ['vault', 'id', 'description', 'contributionTypes', 'maxScoreBudget', 'startAt', 'endAt', 'createdBy']
    if (Object.keys(input).some((k) => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported campaign field.')
    const vault = vaultAddr(input.vault)
    const createdBy = account(input.createdBy, 'creator')
    if (createdBy.toLowerCase() !== this.options.epochOperator.toLowerCase()) throw new HubError(403, 'UNREVIEWED_CAMPAIGN', 'Campaigns must be created by the reviewed epoch operator.')
    const id = typeof input.id === 'string' && /^[a-z0-9-]{1,64}$/.test(input.id) ? input.id : ''
    if (!id) throw new HubError(400, 'INVALID_CAMPAIGN_ID', 'Campaign id must be lowercase alphanumeric/hyphen, 1-64 chars.')
    if (this.getCampaign(vault, id)) throw new HubError(409, 'CAMPAIGN_EXISTS', 'A campaign with this id already exists for this vault.')
    const description = typeof input.description === 'string' && input.description.length <= 500 ? input.description : ''
    const contributionTypes = Array.isArray(input.contributionTypes) ? input.contributionTypes.filter((t): t is string => typeof t === 'string' && t.length <= 64) : []
    const maxScoreBudget = Number(input.maxScoreBudget)
    const startAt = Number(input.startAt)
    const endAt = Number(input.endAt)
    if (!description) throw new HubError(400, 'INVALID_CAMPAIGN', 'Provide a description.')
    if (!contributionTypes.length) throw new HubError(400, 'INVALID_CAMPAIGN', 'Provide at least one allowed contributionType.')
    if (!Number.isFinite(maxScoreBudget) || maxScoreBudget <= 0 || maxScoreBudget > 10_000_000) throw new HubError(400, 'INVALID_BUDGET', 'maxScoreBudget out of bounds.')
    if (!Number.isInteger(startAt) || !Number.isInteger(endAt) || endAt <= startAt) throw new HubError(400, 'INVALID_WINDOW', 'endAt must be after startAt.')
    const campaign: Campaign = { id, vault, description, contributionTypes, maxScoreBudget, awardedScore: 0, startAt, endAt, createdBy, active: true }
    this.saveCampaign(campaign)
    return campaign
  }
  private campaignKey(vault: Address, id: string) { return 'forever-campaign:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + id }
  private saveCampaign(c: Campaign) {
    this.options.journal.recordExternalEvent(
      { id: this.campaignKey(c.vault, c.id), type: 'forever-campaign', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: c.createdBy, at: Date.now(), observedAt: Date.now(), status: c.active ? 'active' : 'closed', verification: 'operator-reviewed', title: 'Campaign ' + c.id, detail: c.description, data: { ...c } },
      Number.MAX_SAFE_INTEGER,
    )
  }
  getCampaign(vault: Address, id: string): Campaign | null {
    const event = this.options.journal.externalEvent(this.campaignKey(vault, id))
    return event ? (event.data as unknown as Campaign) : null
  }
  listCampaigns(vault: Address): Campaign[] {
    return this.options.journal.externalEvents('forever-campaign', 500, this.options.chainId)
      .filter((e) => e.source === 'hub-forever-rewards' && String(e.data.vault || '').toLowerCase() === vault.toLowerCase())
      .map((e) => e.data as unknown as Campaign)
  }
  /** Operator-only: exclude a suspicious wallet from a vault's participation scoring before an epoch closes. Reversible; does not touch already-committed epochs. */
  excludeAccount(input: Record<string, unknown>): { vault: Address; account: Address; excluded: boolean } {
    const allowed = ['vault', 'account', 'reviewedBy', 'excluded']
    if (Object.keys(input).some((k) => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported exclusion field.')
    const vault = vaultAddr(input.vault)
    const acct = account(input.account)
    const reviewedBy = account(input.reviewedBy, 'reviewer')
    if (reviewedBy.toLowerCase() !== this.options.epochOperator.toLowerCase()) throw new HubError(403, 'UNREVIEWED_EXCLUSION', 'Exclusions require the reviewed epoch operator.')
    const excluded = input.excluded !== false
    const key = vault.toLowerCase() + ':' + acct.toLowerCase()
    if (excluded) this.excluded.add(key)
    else this.excluded.delete(key)
    this.options.journal.recordExternalEvent(
      { id: 'forever-excluded-account:' + this.options.chainId + ':' + key, type: 'forever-excluded-account', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: acct, at: Date.now(), observedAt: Date.now(), status: excluded ? 'excluded' : 'reinstated', verification: 'operator-reviewed', title: excluded ? 'Account excluded from participation scoring' : 'Account reinstated', detail: vault + ':' + acct, data: { vault, account: acct, excluded, reviewedBy } },
      Number.MAX_SAFE_INTEGER,
    )
    return { vault, account: acct, excluded }
  }
  private isExcluded(vault: Address, acct: string): boolean { return this.excluded.has(vault.toLowerCase() + ':' + acct.toLowerCase()) }

  /**
   * Reviewed social/community campaign attestation. Enforces the required controls
   * spec review called for: the campaign must exist, be active, and be within its
   * window; the contribution type must be one the campaign explicitly allows; scores
   * are capped to whatever budget remains (never exceeding the campaign's hard cap,
   * partial credit on the last contribution rather than overshoot); self-referrals are
   * rejected; and duplicate content (same contentHash from the same account) cannot be
   * resubmitted for repeated credit.
   */
  recordSocialAttestation(input: Record<string, unknown>): SocialAttestation {
    const allowed = ['vault', 'account', 'campaignId', 'contributionType', 'score', 'reviewedBy', 'contentHash', 'referredAccount']
    if (Object.keys(input).some((k) => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported social attestation field.')
    const vault = vaultAddr(input.vault)
    const acct = account(input.account)
    const reviewedBy = account(input.reviewedBy, 'reviewer')
    if (reviewedBy.toLowerCase() !== this.options.epochOperator.toLowerCase()) throw new HubError(403, 'UNREVIEWED_ATTESTATION', 'Social attestations require the reviewed epoch operator.')
    if (!this.socialLimiter.allow(acct.toLowerCase())) throw new HubError(429, 'RATE_LIMITED', 'Too many social attestations for this wallet.')
    const campaignId = typeof input.campaignId === 'string' && input.campaignId.length <= 64 ? input.campaignId : ''
    const contributionType = typeof input.contributionType === 'string' && input.contributionType.length <= 64 ? input.contributionType : ''
    let score = Number(input.score)
    if (!campaignId || !contributionType) throw new HubError(400, 'INVALID_CAMPAIGN', 'Provide campaignId and contributionType.')
    if (!Number.isFinite(score) || score <= 0 || score > 1_000_000) throw new HubError(400, 'INVALID_SCORE', 'Score out of bounds.')
    const campaign = this.getCampaign(vault, campaignId)
    if (!campaign || !campaign.active) throw new HubError(404, 'CAMPAIGN_NOT_FOUND', 'No active campaign with this id for this vault. "Post once = guaranteed reward" is not supported — create a campaign first.')
    const now = Date.now()
    if (now < campaign.startAt || now > campaign.endAt) throw new HubError(422, 'CAMPAIGN_CLOSED', 'This campaign is outside its active window.')
    if (!campaign.contributionTypes.includes(contributionType)) throw new HubError(422, 'CONTRIBUTION_TYPE_NOT_ALLOWED', 'This campaign does not accept that contribution type.')
    const referredAccount = input.referredAccount !== undefined ? account(input.referredAccount, 'referred wallet') : undefined
    if (referredAccount && referredAccount.toLowerCase() === acct.toLowerCase()) throw new HubError(422, 'SELF_REFERRAL', 'Self-referrals are not eligible.')
    const contentHash = typeof input.contentHash === 'string' && /^[0-9a-f]{16,128}$/i.test(input.contentHash) ? input.contentHash.toLowerCase() : undefined
    if (contentHash) {
      const dupKey = campaignId + ':' + acct.toLowerCase() + ':' + contentHash
      const existing = this.options.journal.externalEvent('forever-social:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + createHash('sha256').update(dupKey).digest('hex'))
      if (existing) throw new HubError(409, 'DUPLICATE_CONTENT', 'This content has already been credited for this campaign and wallet.')
    }
    const remaining = campaign.maxScoreBudget - campaign.awardedScore
    if (remaining <= 0) throw new HubError(422, 'CAMPAIGN_BUDGET_EXHAUSTED', 'This campaign\'s score budget is fully allocated.')
    if (score > remaining) score = remaining // partial credit on the last contribution, never overshoot the cap
    campaign.awardedScore += score
    this.saveCampaign(campaign)
    const record: SocialAttestation = { vault, account: acct, campaignId, contributionType, score, recordedAt: now, reviewedBy, contentHash, referredAccount }
    const idSuffix = contentHash ? createHash('sha256').update(campaignId + ':' + acct.toLowerCase() + ':' + contentHash).digest('hex') : campaignId + ':' + randomUUID()
    this.options.journal.recordExternalEvent(
      { id: 'forever-social:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + idSuffix, type: 'forever-social-attestation', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: acct, at: record.recordedAt, observedAt: record.recordedAt, status: 'confirmed', verification: 'operator-reviewed', title: 'Social contribution recorded', detail: campaignId + ':' + contributionType, data: { ...record } },
      Number.MAX_SAFE_INTEGER,
    )
    return record
  }

  private viewerAttestations(vault: Address) {
    return this.options.journal
      .externalEvents('forever-viewer-attestation', 5000, this.options.chainId)
      .filter((e) => e.source === 'hub-forever-rewards' && String(e.data.vault || '').toLowerCase() === vault.toLowerCase())
  }
  private socialAttestations(vault: Address) {
    return this.options.journal
      .externalEvents('forever-social-attestation', 5000, this.options.chainId)
      .filter((e) => e.source === 'hub-forever-rewards' && String(e.data.vault || '').toLowerCase() === vault.toLowerCase())
  }

  /**
   * Deterministic eligibility scoring: proof-of-participation, not pay-per-second.
   *
   * Viewer scoring, corrected for two issues spec review caught in the first pass:
   *  1. Multiple heartbeats for the same (account, sessionId) are DEDUPED to the
   *     highest reported watchSeconds/presenceProofs for that session, not summed —
   *     summing every heartbeat let a wallet inflate its score without bound just by
   *     posting more attestation calls for the same viewing session.
   *  2. Watch time is transformed with diminishing returns (sqrt), not rewarded
   *     linearly — doubling watch time does not double reward.
   *  3. Each account's qualifying-session count is capped
   *     (MAX_QUALIFYING_SESSIONS_PER_ACCOUNT) so joining unlimited sessions can't
   *     unboundedly inflate one wallet's share of a single epoch.
   *
   * Viewer and social scores share one weighted pool feeding the single 10%
   * participation pot. Real weighting requires simulation before any mainnet commit.
   */
  private score(vault: Address): Map<string, number> {
    const bestPerSession = new Map<string, { watchSeconds: number; presenceProofs: number }>()
    for (const e of this.viewerAttestations(vault)) {
      const acct = String(e.data.account || '').toLowerCase()
      const sessionId = String(e.data.sessionId || '')
      if (!isAddress(acct) || !sessionId || this.isExcluded(vault, acct)) continue
      const key = acct + ':' + sessionId
      const w = Number(e.data.watchSeconds || 0)
      const p = Number(e.data.presenceProofs || 0)
      const prior = bestPerSession.get(key)
      if (!prior || w > prior.watchSeconds) bestPerSession.set(key, { watchSeconds: w, presenceProofs: Math.max(p, prior?.presenceProofs ?? 0) })
    }
    const sessionsPerAccount = new Map<string, number>()
    const scores = new Map<string, number>()
    for (const [key, { watchSeconds: w, presenceProofs: p }] of bestPerSession) {
      const acct = key.slice(0, key.lastIndexOf(':'))
      if (w < MIN_WATCH_SECONDS || p < MIN_PRESENCE_PROOFS) continue
      const usedSessions = sessionsPerAccount.get(acct) || 0
      if (usedSessions >= MAX_QUALIFYING_SESSIONS_PER_ACCOUNT) continue
      sessionsPerAccount.set(acct, usedSessions + 1)
      const weight = Math.sqrt(Math.min(w, 3600)) // diminishing returns, not linear pay-per-second
      scores.set(acct, (scores.get(acct) || 0) + weight)
    }
    for (const e of this.socialAttestations(vault)) {
      const acct = String(e.data.account || '').toLowerCase()
      if (!isAddress(acct) || this.isExcluded(vault, acct)) continue
      const weight = Math.sqrt(Math.min(Number(e.data.score || 0), 100_000)) // same diminishing-returns principle
      scores.set(acct, (scores.get(acct) || 0) + weight)
    }
    return scores
  }

  /** Persists the full leaf set keyed by root so anyone can independently reconstruct the tree and verify aggregation — the "public allocation file" requirement. */
  private publishAllocation(vault: Address, root: Hex, leaves: EpochLeaf[], totalWei: string, planId: string) {
    this.options.journal.recordExternalEvent(
      {
        id: 'forever-participation-allocation:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + root,
        type: 'forever-participation-allocation',
        source: 'hub-forever-rewards',
        chainId: this.options.chainId,
        txHash: '',
        owner: null,
        at: Date.now(),
        observedAt: Date.now(),
        status: 'prepared',
        verification: 'operator-reviewed',
        title: 'Participation epoch allocation published',
        detail: leaves.length + ' leaves, ' + totalWei + ' wei',
        data: { vault, root, leaves, totalWei, planId },
      },
      Number.MAX_SAFE_INTEGER,
    )
  }

  /** Public read: returns the full allocation for a committed/prepared epoch root so anyone can verify it against the on-chain commit. */
  getAllocation(vault: Address, root: string) {
    const event = this.options.journal.externalEvent('forever-participation-allocation:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + root)
    if (!event) throw new HubError(404, 'ALLOCATION_NOT_FOUND', 'No published allocation for this vault and root.')
    return event.data
  }

  /**
   * Confirms an epoch commit on-chain and enriches the published allocation with the
   * fields the spec requires beyond the leaf set: epoch ID, the actual commit
   * transaction hash, and the on-chain claim deadline (only known once
   * `commitParticipationEpoch` has actually been mined — `prepareEpoch` runs before the
   * owner signs anything, so it cannot know these yet). Mirrors the `observeHash`
   * pattern already used for launch events: a receipt is fetched and its event decoded,
   * never trusted from the caller.
   */
  async observeEpochCommit(vault: Address, hash: Hex) {
    const rpc = this.market.client.public
    const receipt = await rpc.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new HubError(409, 'EPOCH_COMMIT_UNVERIFIED', 'Commit transaction reverted.')
    let decoded: { eventName: string; args: Record<string, unknown> } | undefined
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue
      try {
        const candidate = decodeEventLog({ abi: foreverCommunityVaultAbi, data: log.data, topics: log.topics, strict: true }) as { eventName: string; args: Record<string, unknown> }
        if (candidate.eventName === 'ParticipationEpochCommitted') { decoded = candidate; break }
      } catch { continue }
    }
    if (!decoded) throw new HubError(409, 'EPOCH_COMMIT_UNVERIFIED', 'No ParticipationEpochCommitted event found in this transaction for this vault.')
    const args = decoded.args as { epochId: bigint; root: Hex; pot: bigint; claimDeadline: bigint }
    const existing = this.getAllocation(vault, args.root) as Record<string, unknown>
    const updated = {
      ...existing,
      epochId: args.epochId.toString(),
      transactionHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      claimDeadline: args.claimDeadline.toString(),
      confirmedAt: Date.now(),
    }
    this.options.journal.recordExternalEvent(
      {
        id: 'forever-participation-allocation:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + args.root,
        type: 'forever-participation-allocation',
        source: 'hub-forever-rewards',
        chainId: this.options.chainId,
        txHash: hash,
        owner: null,
        at: Date.now(),
        observedAt: Date.now(),
        status: 'confirmed',
        verification: 'chain-event',
        title: 'Participation epoch confirmed on-chain',
        detail: 'epoch ' + args.epochId.toString(),
        data: updated,
      },
      Number.MAX_SAFE_INTEGER,
    )
    return updated
  }

  /** Builds the Merkle tree for a reviewed participation epoch (viewers + social combined). Caps proportionally to `potWei` so the sum of leaves never exceeds the on-chain pot. Returns the unsigned commit plan for the owner to review and sign — this never broadcasts. Also publishes the full allocation for public verification. */
  async prepareEpoch(vault: Address, potWei: string): Promise<{
    vault: Address; root: Hex; leafCount: number; totalWei: string; leaves: EpochLeaf[]
    plan: { kind: 'forever-rewards-epoch-plan'; signing: 'user-wallet'; planId: string; chainId: number; account: Address; transaction: { to: Address; data: Hex; value: string }; expiresAt: number }
  }> {
    const pot = BigInt(potWei)
    if (pot <= 0n) throw new HubError(400, 'INVALID_POT', 'Pot amount must be positive.')
    const scores = this.score(vault)
    if (!scores.size) throw new HubError(404, 'NO_ELIGIBLE_PARTICIPANTS', 'No wallet met the minimum eligibility bar for this epoch.')
    const totalScore = [...scores.values()].reduce((s, v) => s + v, 0)
    const leaves: EpochLeaf[] = [...scores.entries()].map(([addr, weight]) => ({
      account: getAddress(addr),
      amountWei: ((pot * BigInt(Math.floor(weight * 1_000_000))) / BigInt(Math.floor(totalScore * 1_000_000))).toString(),
    })).filter((l) => BigInt(l.amountWei) > 0n)
    if (!leaves.length) throw new HubError(404, 'NO_ELIGIBLE_PARTICIPANTS', 'Rounding left no claimable leaves for this epoch.')
    const { root, total } = buildMerkleTree(leaves)
    if (total > pot) throw new HubError(500, 'EPOCH_OVERALLOCATED', 'Computed epoch total exceeds the requested pot; refuse to commit.')
    const rpc = this.market.client.public
    const code = await rpc.getCode({ address: vault })
    if (!code || code === '0x') throw new HubError(503, 'VAULT_UNAVAILABLE', 'No contract exists at this vault address.')
    const data = encodeFunctionData({ abi: foreverCommunityVaultAbi, functionName: 'commitParticipationEpoch', args: [root, total] })
    const now = Date.now()
    const planId = randomUUID()
    this.options.journal.recordWalletPlan({ id: planId, chainId: this.options.chainId, account: this.options.epochOperator, createdAt: now, expiresAt: now + 300_000, actions: [{ kind: 'forever-participation-epoch-commit', to: vault, data, value: '0' }] })
    this.options.journal.recordDecision({ agentId: 'hub:forever-rewards', ts: now, kind: 'observe', detail: 'Participation epoch prepared: ' + leaves.length + ' leaves, ' + total.toString() + ' wei', meta: { planId, vault, root, leafCount: leaves.length, totalWei: total.toString() } })
    this.publishAllocation(vault, root, leaves, total.toString(), planId)
    return {
      vault, root, leafCount: leaves.length, totalWei: total.toString(), leaves,
      plan: { kind: 'forever-rewards-epoch-plan', signing: 'user-wallet', planId, chainId: this.options.chainId, account: this.options.epochOperator, transaction: { to: vault, data, value: '0' }, expiresAt: now + 300_000 },
    }
  }
}
