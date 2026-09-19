# Controlled live automation

The public Hub remains signerless. Live automation runs as a **separate process** with a dedicated bot wallet and a dedicated SQLite Journal.

## Activation gates

The runner refuses startup unless all of these are true:

- `HUB_LIVE_AUTOMATION=I_UNDERSTAND_REAL_FUNDS`
- `HUB_LIVE_AUTOMATION_AGENTS` explicitly lists one or more supported strategies
- `HOOD_TRADERS_LIVE=1`
- `ROBINHOOD_CHAIN_PRIVATE_KEY` is a valid dedicated automation key
- `HUB_LIVE_AUTOMATION_DB` points to a separate Journal file
- configured limits are inside the hard live ceilings
- RPC chain ID matches the configured Robinhood Chain network
- persisted live state is internally consistent and has no unresolved submission

Supported strategy IDs in this first controlled runner:

- `sniper-1`
- `momentum-1`
- `premium-1`

The LLM strategy is intentionally excluded from the first live allowlist.

## Hard ceilings

The process refuses startup above these values:

- fleet daily spend: **$50**
- per-agent daily spend: **$25**
- per-token position: **$10**
- slippage: **100 bps**
- cooldown: minimum **60 seconds**

Operators may configure stricter values.

## Signer separation

Use a dedicated, separately funded bot wallet. The key belongs only to the live automation process.

Do not place the bot key in:

- the frontend
- Netlify/browser environment variables
- the signerless Hub container
- WalletConnect/Reown configuration

The normal Hub wallet remains user-controlled and unrelated to the bot signer.

## Approval policy

Controlled live automation **does not broadcast ERC-20 approvals**.

Before starting a strategy, the operator must manually approve the canonical router from the dedicated bot wallet. Keep allowances as small as operationally practical.

If allowance is insufficient, the agent refuses the trade instead of approving automatically.

## Restart / transaction recovery

Live agent state is persisted after every completed trade and before/after transaction submission.

Before broadcasting a swap the agent:

1. reads the pending account nonce;
2. persists a `prepared` live marker with that nonce;
3. submits the swap with that exact nonce;
4. persists the transaction hash;
5. waits for the receipt.

A successful receipt is incorporated into the trade Journal and state before the pending marker is cleared.

If the process dies or RPC outcome is ambiguous while the marker is unresolved, the next process start **fails closed**. An operator must reconcile the nonce/hash on-chain before running automation again.

A confirmed reverted receipt is a known outcome and clears the pending marker without recording a fill.

Existing live trades without matching persisted state also block startup.

## Kill switch

The existing kill switch remains authoritative:

- SIGINT/SIGTERM stops the process;
- the configured `KILL_FILE` blocks new intents;
- risk checks inspect kill state before execution.

The controlled live runner deliberately exposes no public HTTP start/stop endpoint. Start and stop it through the deployment/runtime operator plane.

## Starting

After reviewing and funding a dedicated bot wallet:

```bash
npm run build
node dist/live-automation-main.js
```

Example environment shape:

```text
HOOD_NETWORK=mainnet
HOOD_TRADERS_LIVE=1
ROBINHOOD_CHAIN_PRIVATE_KEY=<dedicated bot key>
HUB_LIVE_AUTOMATION=I_UNDERSTAND_REAL_FUNDS
HUB_LIVE_AUTOMATION_AGENTS=momentum-1
HUB_LIVE_AUTOMATION_DB=./data/live-automation.db

FLEET_MAX_DAILY_SPEND_USDG=25
AGENT_MAX_DAILY_SPEND_USDG=10
AGENT_MAX_POSITION_USDG=5
AGENT_MAX_SLIPPAGE_BPS=50
AGENT_COOLDOWN_SECONDS=120
```

This is an execution control layer, not a profitability claim. Strategy behavior and market risk remain unchanged.
