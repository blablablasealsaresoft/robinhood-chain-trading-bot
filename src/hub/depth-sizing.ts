const UINT256_MAX = (1n << 256n) - 1n

/**
 * Size an informational sell probe in base units, rounded down.
 * The price uses its supplied Number's decimal representation; this is not
 * a claim of higher oracle precision. Sub-base-unit/overflow probes are absent.
 */
export function depthSellAmount(notionalUsd: number, referenceUsd: number, decimals: number): bigint | null {
  if (!Number.isSafeInteger(notionalUsd) || notionalUsd <= 0 ||
      !Number.isFinite(referenceUsd) || referenceUsd <= 0 ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null

  const [mantissa, exponentText = '0'] = referenceUsd.toString().split('e')
  const [whole, fraction = ''] = mantissa!.split('.')
  const priceDigits = BigInt(whole! + fraction)
  const scale = Number(exponentText) - fraction.length
  const numerator = BigInt(notionalUsd) * 10n ** BigInt(decimals + Math.max(0, -scale))
  const denominator = priceDigits * 10n ** BigInt(Math.max(0, scale))
  const amount = numerator / denominator
  return amount > 0n && amount <= UINT256_MAX ? amount : null
}
