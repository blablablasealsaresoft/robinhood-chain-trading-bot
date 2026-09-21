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
    recordWalletPlan: vi.fn((p: unknown) => { plans.push(p) }),
    recordDecision: vi.fn((d: unknown) => { decisions.push(d) }),
  } as never
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
  function service() {
    const journal = fakeJournal()
    const market = { client: { wallet: undefined, account: undefined, public: { getCode: vi.fn(async () => '0x1234') } } } as never
    const svc = new ForeverRewardsService(market, { chainId: 4663, journal, epochOperator: EPOCH_OPERATOR })
    return { svc, journal }
  }

  it('rejects viewer attestations below the minimum watch/presence bar when scoring', async () => {
    const { svc } = service()
    svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 5, presenceProofs: 1 })
    await expect(svc.prepareEpoch('viewer', VAULT, '1000000000000000')).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PARTICIPANTS' })
  })

  it('builds a capped, proportional viewer epoch from eligible attestations and returns an unsigned commit plan', async () => {
    const { svc, journal } = service()
    svc.recordViewerAttestation({ vault: VAULT, account: A, sessionId: 's1', watchSeconds: 600, presenceProofs: 3 })
    svc.recordViewerAttestation({ vault: VAULT, account: B, sessionId: 's2', watchSeconds: 300, presenceProofs: 3 })
    const pot = 900n
    const result = await svc.prepareEpoch('viewer', VAULT, pot.toString())
    expect(result.leaves.length).toBe(2)
    const total = result.leaves.reduce((s, l) => s + BigInt(l.amountWei), 0n)
    expect(total).toBeLessThanOrEqual(pot)
    expect(result.plan.signing).toBe('user-wallet')
    expect(result.plan.account).toBe(EPOCH_OPERATOR)
    expect(result.plan.transaction.to).toBe(VAULT)
    expect(journal.recordWalletPlan).toHaveBeenCalledTimes(1)
  })

  it('rejects social attestations not reviewed by the configured epoch operator', () => {
    const { svc } = service()
    expect(() =>
      svc.recordSocialAttestation({ vault: VAULT, account: A, campaignId: 'c1', contributionType: 'post', score: 10, reviewedBy: A }),
    ).toThrowError(/reviewed epoch operator/)
  })
})
