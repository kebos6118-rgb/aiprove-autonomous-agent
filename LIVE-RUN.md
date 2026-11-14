# Live run — 2026-11-14 ~23:14 WIB (16:14 UTC)

Demo agent ran the full loop against the **real** `aiprove.fun` API, with its
own freshly generated keypair. No human input between start and finish.

- **Demo agent address:** `0x321c37be2703D9EA7FA69cF779E9Baf65Dc866Ec`
- **Handle:** `aiprove-auto.agent`
- **Command:**
  `node src/agent.js --live --generate-key --keyfile ./demo-agent.key --handle aiprove-auto.agent`
- **Verbatim transcript:** `LIVE-RUN-transcript.jsonl` (secrets stripped by
  construction — the private key and session token are never logged)

## Results

| Step | Result |
| --- | --- |
| Read `skill.md` | OK — 6,722 bytes; auth + submit endpoints documented |
| Keypair | OK — fresh keypair generated, its own address (not the author's) |
| Sign-in (challenge → personal_sign → token) | OK |
| List open bounties | OK — 20 open |
| `forecast-btc-7d` | **Submitted, `provenance_ok`** — id `f9f281f0-e151-4bc9-a4ef-c4f2f570702e`. Prediction: **no, confidence 0.35** (BTC $65,129.67; 7d −14.05%, 3d −11.96%, 1d −4.66%; hedged at the 0.35 floor) |
| `forecast-nvda-3d` | **Submitted, `provenance_ok`** — id `64032173-1af4-4636-98c2-5f56414623a6`. Prediction: **$161.39** (last $162.85; 3d −3.58%, damped move −0.89%) |
| `sample-agent-skillmd` | Skipped in this run — needs `--repo-url` + `--commit`; no public repo existed yet at run time. The code path is proven by dry-run; re-run with `--only sample-agent-skillmd --repo-url <url> --commit <sha>` once the repo is public. |
| Gate probe `eth-signal-pnl-hard` (enter-only) | **HTTP 403, gate enforced**: "Hold or stake 100,000 $PROVE to enter — one credit per bounty, returned whether you win or lose. $PROVE fair-launches on pons." No submit attempted. |
| Verify `/api/me` | OK — `submissionsTotal: 2`, both ids confirmed under the demo address |

## Independent verification

Both submissions are visible on the public bounty endpoints (no auth):

- `GET /api/bounties/forecast-btc-7d` → submission
  `f9f281f0-e151-4bc9-a4ef-c4f2f570702e`, agent
  `0x321c37be2703d9ea7fa69cf779e9baf65dc866ec`, `provenance_ok`
- `GET /api/bounties/forecast-nvda-3d` → submission
  `64032173-1af4-4636-98c2-5f56414623a6`, same agent, `provenance_ok`

## What the agent did NOT do

- No entry under the author's identity (`0xffFD...`) — only the demo agent's
  own keypair touched the board in this run.
- No gated bounty submitted; the one gate probe was enter-only and rejected.
- No junk: the other 15 open bounties were logged as skipped with reasons
  (gated / no supported submission shape).
