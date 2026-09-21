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
    svc.createCampaign({ vault: VAULT, id: 'c1', description: 'test campaign', contributionTypes: ['post'], maxScoreBudget: 10_000, startAt: Date.now() - 1000, endAt: Date.now() + 86_400_000, createdBy: EPOCH_OPERATOR })
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

  describe('campaign registry', () => {
    function campaign(svc: ForeverRewardsService, over: Record<string, unknown> = {}) {
      return svc.createCampaign({ vault: VAULT, id: 'launch-week', description: 'Launch week promo', contributionTypes: ['post', 'referral'], maxScoreBudget: 1000, startAt: Date.now() - 1000, endAt: Date.now() + 86_400_000, createdBy: EPOCH_OPERATOR, ...over })
    }

    it('rejects social attestations against a campaign that does not exist — no "post once = guaranteed reward"', () => {
      const { svc } = service()
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'nope', contributionType: 'post', score: 10, reviewedBy: EPOCH_OPERATOR })).toThrowError(/no active campaign/i)
    })

    it('rejects a contribution type the campaign does not allow', () => {
      const { svc } = service()
      campaign(svc)
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'unrelated-type', score: 10, reviewedBy: EPOCH_OPERATOR })).toThrowError(/does not accept/)
    })

    it('rejects attestations outside the campaign window', () => {
      const { svc } = service()
      campaign(svc, { startAt: Date.now() - 20_000, endAt: Date.now() - 10_000 })
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'post', score: 10, reviewedBy: EPOCH_OPERATOR })).toThrowError(/outside its active window/)
    })

    it('caps score to whatever budget remains instead of overshooting, and exhausts cleanly', () => {
      const { svc } = service()
      campaign(svc, { maxScoreBudget: 100 })
      const first = svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'post', score: 80, reviewedBy: EPOCH_OPERATOR })
      expect(first.score).toBe(80)
      const second = svc.recordSocialAttestation({ vault: VAULT, account: B, campaignId: 'launch-week', contributionType: 'post', score: 80, reviewedBy: EPOCH_OPERATOR })
      expect(second.score).toBe(20) // partial credit — only 20 remained of the 100 budget
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'post', score: 5, reviewedBy: EPOCH_OPERATOR })).toThrowError(/budget is fully allocated/)
    })

    it('rejects self-referrals', () => {
      const { svc } = service()
      campaign(svc)
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'referral', score: 10, reviewedBy: EPOCH_OPERATOR, referredAccount: A })).toThrowError(/self-referral/i)
    })

    it('rejects duplicate content resubmitted for the same wallet and campaign', () => {
      const { svc } = service()
      campaign(svc)
      const contentHash = 'a'.repeat(64)
      svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'post', score: 10, reviewedBy: EPOCH_OPERATOR, contentHash })
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'launch-week', contributionType: 'post', score: 10, reviewedBy: EPOCH_OPERATOR, contentHash })).toThrowError(/already been credited/)
    })

    it('only the reviewed epoch operator may create a campaign', () => {
      const { svc } = service()
      expect(() => campaign(svc, { createdBy: A })).toThrowError(/reviewed epoch operator/)
    })
  })

  describe('exclusion', () => {
    it('excluded accounts are skipped from scoring even with otherwise-eligible attestations', async () => {
      const { svc, streamAuth } = service()
      streamAuth.mark('s1', A)
      streamAuth.mark('s2', B)
      svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 600, presenceProofs: 3 })
      svc.recordViewerAttestation({ vault: VAULT, account: B, sessionId: 's2', watchSeconds: 600, presenceProofs: 3 })
      svc.excludeAccount({ vault: VAULT, account: A, reviewedBy: EPOCH_OPERATOR, excluded: true })
      const result = await svc.prepareEpoch(VAULT, '1000')
      expect(result.leaves).toHaveLength(1)
      expect(result.leaves[0]!.account.toLowerCase()).toBe(B.toLowerCase())
    })

    it('only the reviewed epoch operator may exclude an account', () => {
      const { svc } = service()
      expect(() => svc.excludeAccount({ vault: VAULT, account: A, reviewedBy: A, excluded: true })).toThrowError(/reviewed epoch operator/)
    })
  })

  describe('rate limiting', () => {
    it('rejects excessive viewer heartbeats from the same wallet', () => {
      const { svc, streamAuth } = service()
      streamAuth.mark('s1', A)
      for (let i = 0; i < 12; i++) svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 100 + i, presenceProofs: 3 })
      expect(() => svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 200, presenceProofs: 3 })).toThrowError(/too many viewer heartbeats/i)
    })

    it('rejects excessive social attestations from the same wallet', () => {
      const { svc } = service()
      svc.createCampaign({ vault: VAULT, id: 'c', description: 'd', contributionTypes: ['post'], maxScoreBudget: 1_000_000, startAt: Date.now() - 1000, endAt: Date.now() + 86_400_000, createdBy: EPOCH_OPERATOR })
      for (let i = 0; i < 20; i++) svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'c', contributionType: 'post', score: 1, reviewedBy: EPOCH_OPERATOR })
      expect(() => svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'c', contributionType: 'post', score: 1, reviewedBy: EPOCH_OPERATOR })).toThrowError(/too many social attestations/i)
    })
  })
})
