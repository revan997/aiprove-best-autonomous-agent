# aiprove-autonomous-agent

A fully autonomous AIProve bounty agent — no human in the loop. It reads
`aiprove.fun/skill.md` at runtime, signs in with its own EVM keypair
(EIP-191 `personal_sign` challenge), lists open bounties, and enters +
completes every one it can do on its own. The agent that completes the most
bounties cleanly wins (`best-autonomous-agent`, 0.3 GLD).

## Run

```bash
npm install
node agent.mjs
```

One command, no arguments. It prints a timestamped log and writes
`run-summary.json` + `run.log` next to itself.

## What it completes (verified live, 2026-11-14)

In a live test run it entered and completed **8 bounties with zero errors**,
all `provenance_ok`:

| bounty | strategy | evidence |
|---|---|---|
| btc-tomorrow | direction from BTC 24h momentum (CoinGecko) | `no` @ 0.57 |
| forecast-eth-24h | direction from ETH 24h momentum | `no` @ 0.56 |
| forecast-btc-7d | direction from BTC 7d trend | `no` @ 0.65 |
| signal-eth-pnl-24h | long/short from ETH 24h momentum | `short` @ 0.56 |
| spy-close-1dollar | persistence: last SPY close (Yahoo Finance) | 754.37 |
| forecast-gold-tomorrow | persistence: last GLD close | 355.45 |
| forecast-nvda-3d | persistence: last NVDA close | 162.85 |
| bug-hunt-utils | executes `utils.js` in a sandbox and tests each function against independently computed expectations; reports real mismatches | 8/8 bug reports |

Full transcript: `run.log`. Machine summary: `run-summary.json`
(includes every submission id and the `/api/me` verification).

## How it works

1. **Reads skill.md at runtime** — fetches `{API}/skill.md`, logs its
   SHA-256 and the endpoint table it parses out of it. If the fetch fails it
   continues on its built-in endpoint table and logs a warning.
2. **Own identity** — loads `AGENT_PRIVATE_KEY` / `AGENT_KEYPAIR_FILE`, or
   generates a FRESH keypair saved mode-600 to `agent-keypair.json`. It never
   hardcodes a key and never reuses another wallet.
3. **Auth** — `GET /api/auth/challenge` → `signMessage` → `POST
   /api/auth/verify` → Bearer session (saved mode-600, re-auth on 401).
4. **List + plan** — `GET /api/bounties?status=open` (soonest-ending first),
   then `GET /api/bounties/<slug>` per bounty for its canonical `submitKind`
   (the list endpoint omits it — found the hard way).
5. **Complete or skip with a reason** — forecasts get reasoned predictions
   from live market data (never random, never extreme confidence: capped at
   0.65); the bug-hunt fetches `utils.js` and proves each bug by executing it.
   Skipped: PosterJudge/social bounties (need human socials/media),
   repo-submit code tasks (no GitHub credentials), `top5-pons-24h` (no pons
   launch data source), `refer-most-agents` (needs human referrals), and
   anything requiring payment.
6. **Submit** — forecast payloads use the proven shapes (`{answer,
   confidence}` for direction; `{answer: number}` for closes — verified live;
   the bug-report list goes in the `prediction` field). One shape fallback on
   HTTP 400 for numeric/signal submits.

## Env vars

| var | default | purpose |
|---|---|---|
| `API_BASE_URL` / `AIPROVE_API_BASE` | `https://aiprove.fun` | API base. **Point this at the staging arena host to run the agent in the sandbox** (skill.md documents `API_BASE_URL` for a remote host). |
| `AGENT_PRIVATE_KEY` | — | hex private key for the agent identity. |
| `AGENT_KEYPAIR_FILE` | `./agent-keypair.json` | JSON keypair file `{address, privateKey}`. |
| `AGENT_HANDLE` | `auto-<addr6>` | public handle shown on entries. |
| `AIPROVE_DRY_RUN=1` | off | auth + list + plan only; no enters or submits. |
| `AIPROVE_MAX_BOUNTIES` | 12 | max bounties attempted per run (soonest-ending first). |
| `AIPROVE_STATE_DIR` | cwd | where keypair/session/summary/log live. |

## Safety

- **Never spends money.** No PROVE purchase, no fee, no deposit — any
  bounty whose brief asks for payment is skipped. Entry is free in open beta.
- **No secrets in this repo.** Keypair/session files are gitignored
  (`.gitignore`) and never committed; the agent never logs a token.
- **No existing wallet is ever reused.** Identity is always its own fresh
  keypair (or one explicitly supplied via env).
- **Graceful failure.** Every bounty is attempted independently; one failure
  never aborts the run. The summary records every skip reason and error.

## Files

- `agent.mjs` — the agent (Node.js, `ethers` only).
- `package.json` — `npm install` then `node agent.mjs`.
- `run.log` / `run-summary.json` — transcript + machine summary of the live
  test run (2026-11-14, 8/8 completed, 0 errors).
- `.gitignore` — keeps `agent-keypair.json`, `agent-session.json`,
  `node_modules/` out of the repo.
