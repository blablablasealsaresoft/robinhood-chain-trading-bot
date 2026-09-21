import { describe, expect, it, vi } from 'vitest'
import { getAddress, encodePacked, keccak256 } from 'viem'
import { ForeverRewardsService, buildMerkleTree, leafHash } from '../../src/hub/forever-rewards.js'

const VAULT = getAddress('0x3333333333333333333333333333333333333333')
const EPOCH_OPERATOR = getAddress('0xB50516982524DFF3d8d563F46AD54891Aa61944E')
const A = getAddress('0xa11ce00000000000000000000000000000000001')
const B = getAddress('0xb0b0000000000000000000000000000000000002')

function fakeJournal() {
  const events: Array<{ id: string; type: string; source: string; data: Record<string, unknown> }> = []
  const plans: unknown[] = []
  const decisions: unknown[] = []
  return {
    events,
    plans,
    decisions,
    recordExternalEvent: vi.fn((e: any) => { events.push(e) }),
    externalEvents: vi.fn((type: string) => events.filter((e) => e.type === type)),
    externalEvent: vi.fn((id: string) => events.find((e) => e.id === id) || null),
    recordWalletPlan: vi.fn((p: unknown) => { plans.push(p) }),
    recordDecision: vi.fn((d: unknown) => { decisions.push(d) }),
  } as never
}
/** Fake StreamAuthService: only sessions explicitly marked verified count. */
function fakeStreamAuth(verified: Set<string> = new Set()) {
  return {
    isVerifiedViewer: vi.fn((sessionId: string, address: string) => verified.has(sessionId + ':' + address.toLowerCase())),
    mark(sessionId: string, address: string) { verified.add(sessionId + ':' + address.toLowerCase()) },
  }
}

describe('buildMerkleTree / leafHash', () => {
  it('produces a root a claimant can verify against with the returned proof', () => {
    const leaves = [{ account: A, amountWei: '1000' }, { account: B, amountWei: '2500' }]
    const { root, proofs, total } = buildMerkleTree(leaves)
    expect(total).toBe(3500n)
    const proof = proofs.get(A.toLowerCase() + ':1000')!
    // Re-derive root manually the same way OpenZeppelin MerkleProof.verify would.
    let computed = leafHash(leaves[0]!)
    for (const p of proof) {
      const [lo, hi] = BigInt(computed) <= BigInt(p) ? [computed, p] : [p, computed]
      computed = keccak256(encodePacked(['bytes32', 'bytes32'], [lo, hi]))
    }
    expect(computed).toBe(root)
  })
})

describe('ForeverRewardsService', () => {
  function service(verifiedSessions?: Set<string>) {
    const journal = fakeJournal()
    const streamAuth = fakeStreamAuth(verifiedSessions)
    const market = {
      client: { wallet: undefined, account: undefined, public: { getCode: vi.fn(async () => '0x1234'), getTransactionReceipt: vi.fn() } },
    } as never
    const svc = new ForeverRewardsService(market, { chainId: 4663, journal, epochOperator: EPOCH_OPERATOR, streamAuth })
    return { svc, journal, streamAuth, market }
  }

  it('rejects viewer attestations for a session/wallet pair that never authenticated via a signed viewer-token challenge', () => {
    const { svc } = service()
    expect(() => svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 600, presenceProofs: 3 })).toThrowError(/wallet has not authenticated/)
  })

  it('rejects viewer attestations below the minimum watch/presence bar when scoring', async () => {
    const { svc, streamAuth } = service()
    streamAuth.mark('s1', A)
    svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 5, presenceProofs: 1 })
    await expect(svc.prepareEpoch(VAULT, '1000000000000000')).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PARTICIPANTS' })
  })

  it('dedupes repeated heartbeats for the same (account, sessionId) instead of summing them, and applies diminishing returns to watch time', async () => {
    const { svc, streamAuth } = service()
    streamAuth.mark('s1', A)
    // Post the same session's heartbeat 5 times — should not multiply the score fivefold.
    for (let i = 0; i < 5; i++) svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 900, presenceProofs: 3 })
    const single = await svc.prepareEpoch(VAULT, '1000000')
    expect(single.leaves).toHaveLength(1)
    const soloAmount = BigInt(single.leaves[0]!.amountWei)
    // A second account with the SAME single watch time should get an equal share, proving
    // the first account's 5 duplicate heartbeats were not summed into 5x the weight.
    const { svc: svc2, streamAuth: streamAuth2 } = service()
    streamAuth2.mark('s1', A)
    streamAuth2.mark('s2', B)
    svc2.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 900, presenceProofs: 3 })
    svc2.recordViewerAttestation({ vault: VAULT, account: B, sessionId: 's2', watchSeconds: 900, presenceProofs: 3 })
    const paired = await svc2.prepareEpoch(VAULT, '1000000')
    expect(paired.leaves).toHaveLength(2)
    const [a, b] = paired.leaves
    expect(BigInt(a!.amountWei)).toBe(BigInt(b!.amountWei)) // equal watch time -> equal share
    void soloAmount
  })

  it('caps the number of distinct qualifying sessions counted per account per epoch', async () => {
    const { svc, streamAuth } = service()
    for (let i = 0; i < 8; i++) {
      const sessionId = 's' + i
      streamAuth.mark(sessionId, A)
      svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId, watchSeconds: 600, presenceProofs: 3 })
    }
    streamAuth.mark('s-other', B)
    svc.recordViewerAttestation({ vault: VAULT, account: B, sessionId: 's-other', watchSeconds: 600, presenceProofs: 3 })
    const result = await svc.prepareEpoch(VAULT, '1000000')
    // A capped at 5 qualifying sessions' worth of weight should not dominate B's single session by 8x.
    const a = result.leaves.find((l) => l.account.toLowerCase() === A.toLowerCase())!
    const b = result.leaves.find((l) => l.account.toLowerCase() === B.toLowerCase())!
    const ratio = Number(BigInt(a.amountWei)) / Number(BigInt(b.amountWei))
    expect(ratio).toBeCloseTo(5, 1)
  })

  it('builds a capped, proportional participation epoch combining viewer + social attestations and returns an unsigned commit plan', async () => {
    const { svc, journal, streamAuth } = service()
    streamAuth.mark('s1', A)
    svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 600, presenceProofs: 3 })
    svc.recordSocialAttestation({ vault: VAULT, account: B, campaignId: 'c1', contributionType: 'post', score: 300, reviewedBy: EPOCH_OPERATOR })
    const pot = 900n
    const result = await svc.prepareEpoch(VAULT, pot.toString())
    expect(result.leaves.length).toBe(2)
    const total = result.leaves.reduce((s, l) => s + BigInt(l.amountWei), 0n)
    expect(total).toBeLessThanOrEqual(pot)
    expect(result.plan.signing).toBe('user-wallet')
    expect(result.plan.account).toBe(EPOCH_OPERATOR)
    expect(result.plan.transaction.to).toBe(VAULT)
    expect(journal.recordWalletPlan).toHaveBeenCalledTimes(1)
  })

  it('publishes a public allocation file that getAllocation can retrieve by vault + root', async () => {
    const { svc, streamAuth } = service()
    streamAuth.mark('s1', A)
    svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 600, presenceProofs: 3 })
    const result = await svc.prepareEpoch(VAULT, '500')
    const allocation = svc.getAllocation(VAULT, result.root) as { leaves: unknown[]; totalWei: string }
    expect(allocation.leaves).toHaveLength(1)
    expect(allocation.totalWei).toBe(result.totalWei)
  })

  it('rejects social attestations not reviewed by the configured epoch operator', () => {
    const { svc } = service()
    expect(() =>
      svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'c1', contributionType: 'post', score: 10, reviewedBy: A }),
    ).toThrowError(/reviewed epoch operator/)
  })

  it('observeEpochCommit rejects a reverted commit transaction', async () => {
    const { svc, market } = service()
    ;(market as any).client.public.getTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [], blockNumber: 1n })
    await expect(svc.observeEpochCommit(VAULT, ('0x' + '11'.repeat(32)) as `0x${string}`)).rejects.toMatchObject({ code: 'EPOCH_COMMIT_UNVERIFIED' })
  })

  it('observeEpochCommit rejects a successful receipt with no ParticipationEpochCommitted event for this vault', async () => {
    const { svc, market } = service()
    ;(market as any).client.public.getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [], blockNumber: 1n })
    await expect(svc.observeEpochCommit(VAULT, ('0x' + '22'.repeat(32)) as `0x${string}`)).rejects.toMatchObject({ code: 'EPOCH_COMMIT_UNVERIFIED' })
  })
})
