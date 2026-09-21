import { randomUUID } from 'node:crypto'
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, keccak256, encodePacked, zeroAddress, type Address, type Hex } from 'viem'
import type { Market } from '../framework/market.js'
import type { Journal } from '../framework/journal.js'
import { HubError } from './manual-swaps.js'
import { foreverCommunityVaultAbi } from './forever-community-abi.js'

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
   * server-issued id from stream-auth, not a client-invented string.
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
    const record: ViewerAttestation = { vault, account: acct, sessionId, watchSeconds, presenceProofs, recordedAt: Date.now() }
    this.options.journal.recordExternalEvent(
      { id: 'forever-viewer:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + acct.toLowerCase() + ':' + sessionId, type: 'forever-viewer-attestation', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: acct, at: record.recordedAt, observedAt: record.recordedAt, status: 'confirmed', verification: 'self-attested', title: 'Viewer attendance recorded', detail: sessionId, data: { ...record } },
      Number.MAX_SAFE_INTEGER,
    )
    return record
  }

  /** Reviewed social/community campaign attestation — must be attributed to an operator-reviewed campaign, not scored automatically from third-party APIs. */
  recordSocialAttestation(input: Record<string, unknown>): SocialAttestation {
    const allowed = ['vault', 'account', 'campaignId', 'contributionType', 'score', 'reviewedBy']
    if (Object.keys(input).some((k) => !allowed.includes(k))) throw new HubError(400, 'UNEXPECTED_FIELD', 'Unsupported social attestation field.')
    const vault = vaultAddr(input.vault)
    const acct = account(input.account)
    const reviewedBy = account(input.reviewedBy, 'reviewer')
    if (reviewedBy.toLowerCase() !== this.options.epochOperator.toLowerCase()) throw new HubError(403, 'UNREVIEWED_ATTESTATION', 'Social attestations require the reviewed epoch operator.')
    const campaignId = typeof input.campaignId === 'string' && input.campaignId.length <= 64 ? input.campaignId : ''
    const contributionType = typeof input.contributionType === 'string' && input.contributionType.length <= 64 ? input.contributionType : ''
    const score = Number(input.score)
    if (!campaignId || !contributionType) throw new HubError(400, 'INVALID_CAMPAIGN', 'Provide campaignId and contributionType.')
    if (!Number.isFinite(score) || score < 0 || score > 1_000_000) throw new HubError(400, 'INVALID_SCORE', 'Score out of bounds.')
    const record: SocialAttestation = { vault, account: acct, campaignId, contributionType, score, recordedAt: Date.now(), reviewedBy }
    this.options.journal.recordExternalEvent(
      { id: 'forever-social:' + this.options.chainId + ':' + vault.toLowerCase() + ':' + acct.toLowerCase() + ':' + campaignId, type: 'forever-social-attestation', source: 'hub-forever-rewards', chainId: this.options.chainId, txHash: '', owner: acct, at: record.recordedAt, observedAt: record.recordedAt, status: 'confirmed', verification: 'operator-reviewed', title: 'Social contribution recorded', detail: campaignId + ':' + contributionType, data: { ...record } },
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
      if (!isAddress(acct) || !sessionId) continue
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
      if (!isAddress(acct)) continue
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
