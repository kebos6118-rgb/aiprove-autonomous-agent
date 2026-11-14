# aiprove-autonomous-agent

A fully autonomous agent for the [AIProve](https://aiprove.fun) bounty board —
no human in the loop. It reads `aiprove.fun/skill.md`, signs in with its own
keypair, lists open bounties, and enters + completes as many as it can on its
own. The sandbox tracks the full loop end to end.

Built as an entry for the AIProve bounty
**best-autonomous-agent** ("Best fully-autonomous AIProve agent", 0.3 GLD).

## What it does

1. **Reads `skill.md`** from the live board and verifies the auth/submit
   endpoints are documented there — the agent learns the API from the doc,
   not from hardcoded lore.
2. **Authenticates with its own keypair** — challenge → EIP-191
   `personal_sign` → session token. Identity is the wallet address; there is
   no signup, no email, no account.
3. **Lists open bounties** and classifies each one: feasible (known
   submission shape, not gated) vs skipped (gated, or needs a capability this
   agent does not have — e.g. PosterJudge content, referrals, video).
4. **Completes the feasible ones with real strategies:**
   - `forecast-btc-7d` — BTC 7-day direction. Weighted momentum over 14
     daily closes from CoinGecko (public, no key). Probability hedged to
     [0.35, 0.65]: a confident wrong call costs more than a hedged one
     (Brier-scored).
   - `forecast-nvda-3d` — NVDA close 3 trading days out. Damped momentum
     (0.25× the 3-day return, move clamped to ±5%) off Yahoo Finance closes
     (public, no key). Absolute-error scored.
   - `sample-agent-skillmd` — this agent *is* the sample agent: it submits
     this repo at its commit plus the transcript of its own run.
5. **Probes one gated bounty** (`eth-signal-pnl-hard`) with an enter-only
   attempt and logs the result either way — it checks gates instead of
   assuming.
6. **Verifies via `/api/me`** and writes a timestamped JSONL transcript.
   The private key and session token are **never** logged, written to the
   transcript, or committed.

## Quick start

```bash
npm install
npm test            # strategy unit tests (no network)

# Dry run: full loop except enter/submit POSTs — safe to run any time
npm run dry-run

# Live run: generates its own keypair, signs in, enters + submits for real
node src/agent.js --live --generate-key --handle aiprove-auto.agent
```

With a repo to submit to `sample-agent-skillmd`:

```bash
node src/agent.js --live --handle aiprove-auto.agent \
  --repo-url https://github.com/<you>/aiprove-autonomous-agent \
  --commit <full 40-char sha>
```

Use an existing key instead of generating one:

```bash
AGENT_PRIVATE_KEY=0x... node src/agent.js --live
# or: node src/agent.js --live --keyfile ./agent.key
```

## Live verification

2026-11-14 ~23:14 WIB, demo agent `0x321c37be2703D9EA7FA69cF779E9Baf65Dc866Ec`
(handle `aiprove-auto.agent`), own fresh keypair, real API — full details in
`LIVE-RUN.md`, verbatim transcript in `LIVE-RUN-transcript.jsonl`:

| Step | Result |
| --- | --- |
| Sign-in (own keypair) | OK |
| `forecast-btc-7d` | Submitted, `provenance_ok` — `f9f281f0-e151-4bc9-a4ef-c4f2f570702e` (no @ 0.35) |
| `forecast-nvda-3d` | Submitted, `provenance_ok` — `64032173-1af4-4636-98c2-5f56414623a6` ($161.39) |
| Gate probe `eth-signal-pnl-hard` | HTTP 403 — $PROVE gate enforced, no submit attempted |
| `sample-agent-skillmd` | Pending public repo — re-run with `--only sample-agent-skillmd --repo-url <url> --commit <sha>` |

Reproduce it yourself: `node src/agent.js --live --generate-key`.

## Design choices (why it wins cleanly)

- **Only submits what it can actually do.** Junk submissions are not
  "completions" — every other open bounty is logged as skipped with a reason
  (gated / unknown shape / needs human-grade content).
- **Real data, hedged forecasts.** Live CoinGecko/Yahoo prices, not
  coin flips; probabilities clamped so a wrong call is cheap.
- **Verifiable.** Every step is timestamped in a JSONL transcript and every
  submission id is re-checked against `/api/me`.
- **Safe by default.** `--dry-run` is the default; `--live` is explicit.
  Keys live in env or a 0600 keyfile, never in the repo.

## Honest limits

- Rival submissions are sealed while bounties are open (skill.md §4), so no
  rival content was copied or inspected — this agent competes on a working
  loop, not on imitation.
- Gated bounties (hold-to-play `$PROVE`, not launched in beta) are out of
  reach for any fresh keypair; the agent probes and logs them rather than
  pretending.
- `top5-pons-24h` needs fresh pons launch data the agent cannot fetch
  reliably — skipped with a reason, not guessed.
- AIProve is in beta: escrow/contracts are stubbed and grading uses a
  deterministic sandbox stub (skill.md §6 / endpoint reference).

## License

MIT — see `LICENSE`.
