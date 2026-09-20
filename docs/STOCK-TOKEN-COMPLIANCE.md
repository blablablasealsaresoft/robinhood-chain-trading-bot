# Stock Token compliance policy

This Hub integrates **Stock Tokens on Robinhood Chain**. It does not treat them as ordinary crypto assets and it does not describe them as "tokenized stocks" or "tokenized equities."

Official references used for this policy:

- Robinhood Chain Stock Tokens: https://docs.robinhood.com/chain/stock-tokens/
- Robinhood Chain Stock Token APIs: https://docs.robinhood.com/chain/stock-token-apis/
- Robinhood Chain Brand Guidelines: https://docs.robinhood.com/chain/brand-guidelines/
- Robinhood Chain Terms of Service: https://docs.robinhood.com/chain/terms-of-service/
- RHJ disclosure library / current prospectus and Final Terms: https://robinhood.com/eu/en/legal/rhj/

## Product classification

Robinhood Chain documentation describes Stock Tokens as tokenised debt securities issued by Robinhood Assets (Jersey) Limited ("RHJ"). They provide economic exposure to an underlying security but do not give the holder legal or beneficial rights in the underlying security or its issuer.

Stock Tokens on Robinhood Chain are standard ERC-20 assets and may be self-custodied, transferred and composed onchain. This is distinct from Robinhood Europe's older "Classic Stock Tokens" account product and its platform-specific transfer/settlement behavior.

The Hub therefore follows Robinhood Chain documentation for onchain behavior while using Robinhood's published onboarding concepts as the minimum shape of an external eligibility/appropriateness attestation.

## Terminology

External Hub copy must:

- use **Stock Tokens** in full;
- use **Robinhood Chain** in full;
- not call Stock Tokens "tokenized stocks" or "tokenized equities";
- not imply Stock Tokens are shares or confer shareholder/voting rights;
- not use Robinhood's stock ticker in Robinhood Chain promotional content.

## Acquisition boundary

Stock Token acquisition requires all of the following:

1. Robinhood Chain mainnet (chain ID 4663).
2. Canonical Stock Token address from the existing registry.
3. Deployment-level `HOOD_STOCK_TOKEN_ELIGIBLE=true`.
4. A current wallet-specific external compliance attestation.
5. RHJ `/assets` metadata:
   - asset is active;
   - chain-4663 deployment exactly matches the canonical token address;
   - trading capabilities are present and do not prohibit the requested opening direction.
6. RHJ `/prices/{symbol}` metadata:
   - chain-4663 deployment matches;
   - no active trading halt;
   - generated market-status timestamp is fresh.
7. Existing Chainlink reference freshness and DEX/reference-deviation checks.
8. Existing route, balance, slippage, quote-expiry and wallet-simulation checks.

All Stock Token policy checks are repeated before wallet calldata is prepared.

## Wallet attestation

The Hub intentionally does **not** collect identity/KYC source data.

An external onboarding/compliance process supplies only these booleans and timestamps:

- `nonUsPerson`
- `jurisdictionEligible`
- `appropriatenessPassed`
- `riskDisclosuresAccepted`
- `taxCertificationComplete`
- `verifiedAt`
- `expiresAt`

The Hub parser rejects extra fields. Do not include TINs, identity documents, citizenship, tax residence, addresses, dates of birth, investor-profile answers, or jurisdiction names.

`jurisdictionEligible` must be generated against the **current** RHJ prospectus/Final Terms and restricted-jurisdiction rules. The code does not hard-code a permanent country list because Robinhood's terms can change.

This is an enforcement input, not a representation that the Hub itself performed KYC or regulatory approval.

## Selling / closing

Acquisition eligibility and position disposal are intentionally separate.

The Hub does not require the acquisition attestation merely to sell an already-held Stock Token. However, selling still requires the canonical RHJ asset/deployment checks and respects active halts and explicit closing restrictions in RHJ trading capabilities.

This prevents the eligibility gate from trapping an existing holder while still respecting asset-level restrictions.

## Trading capabilities and tokenization window

Robinhood distinguishes the tokenization (mint/burn) window from end-user onchain trading. The Hub does not incorrectly disable DEX trading merely because primary-market mint/burn is closed.

Instead, it checks the per-asset `tradingCapabilities` field and current RHJ halt/price status before issuing or preparing a Stock Token trade.

## Corporate actions

Stock Tokens use an onchain ERC-8056 multiplier. The existing hoodchain/Hub valuation path uses the multiplier-adjusted Chainlink token price and must not multiply the price a second time.

RHJ `/corporate-actions` and `/assets` can be used for explanatory UI/reconciliation. The Hub does not infer that a corporate action is safe to trade through. If RHJ reports an active halt, trading fails closed.

## Disclosures

The user interface should prominently communicate before Stock Token acquisition that:

- Stock Tokens are not the underlying shares/ETFs;
- they do not provide shareholder or voting rights in the underlying;
- they are securities/debt instruments issued by RHJ and carry issuer/market risk;
- loss of some or all invested capital is possible;
- availability is jurisdiction-restricted;
- the user should review the current RHJ Base Prospectus, supplements and applicable Final Terms;
- the Hub is not providing investment, legal or tax advice.

## Operational rule

`HUB_STOCK_COMPLIANCE_ATTESTATIONS` is backend-only configuration. Never bundle it into frontend `VITE_` variables or commit production attestations to Git.

If the RHJ metadata endpoints are unreachable, stale, malformed or inconsistent with the canonical chain deployment, Stock Token trade preparation fails closed.
