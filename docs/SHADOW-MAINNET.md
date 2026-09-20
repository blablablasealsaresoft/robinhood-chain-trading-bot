# Mainnet shadow fleet

The shadow fleet runs the three core deterministic strategies against live Robinhood Chain mainnet data without constructing a signer or broadcasting transactions.

## Core strategies

- **Launch Sniper** — watches new NOXA/Odyssey launches, checks route availability, round-trip sellability and deployer concentration, then records paper entries/exits through the normal Agent risk engine.
- **Momentum** — tracks recent graduated/liquid launches, samples live prices, records paper breakout entries, trailing stops and time exits.
- **Premium Watch** — compares canonical Stock Token Chainlink references with Uniswap v3 DEX prices. With Stock Token eligibility unset it remains alerts-only; shadow mode does not pretend an acquisition is permitted.

## Monitoring services

These are separate from the three trading strategies:

- **Launch monitor** — the configured Hub LaunchFactory + broader launch discovery observers. It records launch/sale events and does not trade.
- **LLM service slot** — an optional fourth strategy integration. It is intentionally excluded from the first shadow fleet so deterministic strategy behavior can be measured without model-driven decisions.
- **Arbitrage monitor** — the separate RobinFun/Uniswap worker repository launched with `--dry-run`, an empty private key and `LIVE=0`. It is an observation service, not one of the three Agent strategies.

## Telemetry

Each bounded session writes:

- `shadow-events.jsonl` — periodic snapshots with block, agent state, refusal reasons, Launch monitor events and arbitrage log tail;
- `shadow-summary.json` — final strategy/monitor scorecard;
- GitHub Actions step summary — compact per-run table of ticks, trades, refusals, simulated equity and monitor state;
- `shadow-journal.sqlite` — closed SQLite Journal containing simulated trades, decisions and equity observations.

No automatic parameter rewrite occurs. A strategy is marked `refinementReady` only after at least 20 simulated fills; even then the artifact says parameter changes require forward-outcome analysis.

## GitHub Actions

`.github/workflows/shadow-mainnet.yml` runs a short five-minute shadow session for changes to the shadow/strategy/framework paths, supports manually dispatched sessions up to 180 minutes, and on the integrated/default branch schedules a 55-minute mainnet session every four hours (six sessions per day). Scheduled workflows only execute from the repository default branch, so opening this PR does not create duplicate long-running schedules before integration.

The workflow never accepts a private key. It sets:

```text
HOOD_TRADERS_LIVE=0
ROBINHOOD_CHAIN_PRIVATE_KEY=
HOOD_STOCK_TOKEN_ELIGIBLE=false
```

For reliable RPC access, configure this as a **GitHub Actions secret**, not a repository file:

```text
HOOD_SHADOW_RPC_URL
```

If the secret is absent, the normal public Robinhood Chain RPC fallback is used.

The public reviewed LaunchFactory address and deployment block are safe to keep in workflow configuration because they are public chain identifiers, not credentials.

## Arbitrage checkout

The workflow attempts to check out `blablablasealsaresoft/RobinHood-Arbitrage-Bot` and install its dependencies. If repository access or installation is unavailable, the core three-strategy shadow session still runs and records the arbitrage monitor as unavailable rather than adding a signer or failing into live mode.

## Refinement discipline

Use multiple sessions and compare out-of-sample outcomes before changing thresholds. Useful review dimensions include:

- trade/refusal count and dominant refusal reasons;
- simulated realized/open/equity values;
- entry/exit reasons;
- round-trip retention and deployer concentration for Launch Sniper;
- breakout frequency and trailing-stop churn for Momentum;
- Stock Token spread frequency/magnitude for Premium Watch;
- arbitrage dry-run opportunity frequency and errors.

Artifacts are retained for 90 days to support cross-session review. Any parameter/code change should be an isolated reviewable PR. Shadow telemetry itself must never merge or deploy strategy changes.
