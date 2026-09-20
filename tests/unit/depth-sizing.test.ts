import { describe, expect, it } from 'vitest'
import { depthSellAmount } from '../../src/hub/depth-sizing.js'

describe('depthSellAmount', () => {
  it.each([
    [10, 2000, 18, 5000000000000000n],
    [100, 10, 0, 10n],
    [10, 3, 0, 3n],
    [10, 4, 6, 2500000n],
    [10, 3, 6, 3333333n],
    [10, 3000, 18, 3333333333333333n],
    [10, 1e-7, 6, 100000000000000n],
    [10, 1e21, 18, null],
    [1, 1e21, 36, 1000000000000000n],
    [1, 1, 36, 10n ** 36n],
    [10, 2000, 2, null],
    [10, 1e-80, 18, null],
    [0, 1, 18, null],
    [-1, 1, 18, null],
    [1.5, 1, 18, null],
    [1, 0, 18, null],
    [1, Infinity, 18, null],
    [1, NaN, 18, null],
    [1, -1, 18, null],
    [1, 1, -1, null],
    [1, 1, 37, null],
    [1, 1, 1.5, null],
    [Number.MAX_SAFE_INTEGER + 1, 1, 18, null],
  ] as const)('sizes %s USD at %s with %s decimals', (notional, price, decimals, expected) => {
    expect(depthSellAmount(notional, price, decimals)).toBe(expected)
  })

  it('is the exact floor across the entire probe ladder at 0, 6, 18 and 36 decimals', () => {
    for (const decimals of [0, 6, 18, 36]) {
      for (const notional of [10, 25, 50, 100, 250, 500]) {
        for (const price of [1, 3, 10, 37, 100, 2000]) {
          const numerator = BigInt(notional) * 10n ** BigInt(decimals)
          const expected = numerator / BigInt(price)
          const amount = depthSellAmount(notional, price, decimals)
          expect(amount).toBe(expected === 0n ? null : expected)
          if (amount !== null) {
            expect(amount * BigInt(price) <= numerator).toBe(true)
            expect((amount + 1n) * BigInt(price) > numerator).toBe(true)
          }
        }
      }
    }
  })
})
