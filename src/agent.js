#!/usr/bin/env node
/**
 * aiprove-autonomous-agent — a fully autonomous agent for aiprove.fun.
 *
 * Full loop, no human in the loop:
 *   1. fetch skill.md and parse the API surface from it
 *   2. load (or generate) its OWN keypair — never anyone else's
 *   3. challenge -> EIP-191 personal_sign -> session token
 *   4. list open bounties
 *   5. pick feasible ones, compute real forecasts from live market data,
 *      enter + submit each
 *   6. verify via /api/me and write a transcript (secrets stripped)
 *
 * Usage:
 *   node src/agent.js --dry-run            # everything except enter/submit POSTs
 *   node src/agent.js --live               # full loop, real submissions
 *   node src/agent.js --live --generate-key  # create ./agent.key first (0600)
 *
 * Env / flags:
 *   AGENT_PRIVATE_KEY   keypair (0x...); overrides --keyfile / ./agent.key
 *   AIPROVE_API         default https://aiprove.fun
 *   --handle <name>     public handle (default: aiprove-auto.agent)
 *   --repo-url <url> --commit <sha>  enable the sample-agent-skillmd repo submit
 *   --keyfile <path>    default ./agent.key
 *   --out <path>        transcript path (default ./transcript-<ts>.jsonl)
 *
 * Secrets policy: the private key and the session token are NEVER logged,
 * NEVER written to the transcript, and NEVER committed (see .gitignore).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');
const { btcDirectionForecast, nvdaCloseForecast } = require('./strategy');

const API = (process.env.AIPROVE_API || 'https://aiprove.fun').replace(/\/$/, '');
const DEFAULT_HANDLE = 'aiprove-auto.agent';

// Bounties this agent knows how to complete, with their submission shape.
// Everything else open is logged as skipped with a reason — the agent only
// submits what it can actually do, never junk.
const TARGETS = [
  {
    slug: 'forecast-btc-7d',
    kind: 'yes-no',
    // Will BTC close higher 7 days from now? Brier-scored.
  },
  {
    slug: 'forecast-nvda-3d',
    kind: 'number',
    // NVDA close 3 trading days out. Absolute-error scored.
  },
  {
    slug: 'sample-agent-skillmd',
    kind: 'repo',
    // This agent itself is the sample agent: submit this repo + transcript.
    needsRepo: true,
  },
];

// One gated bounty is probed with an ENTER only (no submit): it proves the
// agent checks gates instead of assuming, and the result is logged either way.
const GATE_PROBE_SLUG = 'eth-signal-pnl-hard';

const logLines = [];
function log(step, ok, detail) {
  const entry = { ts: new Date().toISOString(), step, ok, detail: detail || {} };
  logLines.push(entry);
  console.log(`[${entry.ts}] ${ok ? 'OK  ' : 'FAIL'} ${step} ${JSON.stringify(detail)}`);
}

function parseArgs(argv) {
  const args = { live: false, generateKey: false, handle: DEFAULT_HANDLE, keyfile: './agent.key', out: null, repoUrl: null, commit: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--generate-key') args.generateKey = true;
    else if (a === '--handle') args.handle = argv[++i];
    else if (a === '--keyfile') args.keyfile = argv[++i];
    else if (a === '--repo-url') args.repoUrl = argv[++i];
    else if (a === '--commit') args.commit = argv[++i];
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/agent.js [--live|--dry-run] [--generate-key] [--handle H] [--keyfile P] [--repo-url U --commit SHA] [--only SLUG] [--out P]');
      process.exit(0);
    } else {
      console.error('Unknown arg:', a);
      process.exit(2);
    }
  }
  return args;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
}

async function fetchBtcDailyCloses() {
  // CoinGecko public API, no key: 14 daily closes.
  const { status, ok, json } = await fetchJson(
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=14&interval=daily'
  );
  if (!ok || !json || !Array.isArray(json.prices)) {
    throw new Error(`CoinGecko market_chart HTTP ${status}`);
  }
  return json.prices.map((p) => p[1]);
}

async function fetchNvdaDailyCloses() {
  // Yahoo Finance public chart API, no key: 10 daily closes.
  const { status, ok, json } = await fetchJson(
    'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=10d&interval=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!ok || !json || !json.chart || !json.chart.result || !json.chart.result[0]) {
    throw new Error(`Yahoo chart HTTP ${status}`);
  }
  const closes = json.chart.result[0].indicators.quote[0].close.filter((c) => c != null);
  const meta = json.chart.result[0].meta;
  return { closes, lastPrice: meta.regularMarketPrice };
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.live ? 'LIVE' : 'DRY-RUN';
  console.log(`aiprove-autonomous-agent starting (${mode}) — API ${API}`);

  // 1. Read skill.md — the agent learns the board from the doc, not hardcoded lore.
  let skill = '';
  try {
    const res = await fetch(`${API}/skill.md`);
    skill = await res.text();
  } catch (e) {
    log('read-skill.md', false, { error: String(e.message || e) });
    process.exit(1);
  }
  const hasAuth = skill.includes('/api/auth/challenge') && skill.includes('/api/auth/verify');
  const hasSubmit = skill.includes('/api/bounties/<slug>/submit') || skill.includes('/submit');
  log('read-skill.md', hasAuth && hasSubmit, { bytes: skill.length, authDocumented: hasAuth, submitDocumented: hasSubmit });
  if (!hasAuth) { console.error('skill.md does not document auth; aborting.'); process.exit(1); }

  // 2. Keypair: env wins, then keyfile, then generate (only with --generate-key).
  let wallet;
  const keyfile = path.resolve(args.keyfile);
  if (process.env.AGENT_PRIVATE_KEY) {
    const pk = process.env.AGENT_PRIVATE_KEY.trim();
    wallet = new Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    log('keypair', true, { source: 'AGENT_PRIVATE_KEY env', address: wallet.address });
  } else if (fs.existsSync(keyfile)) {
    const pk = fs.readFileSync(keyfile, 'utf8').trim();
    wallet = new Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    log('keypair', true, { source: 'keyfile', address: wallet.address });
  } else if (args.generateKey) {
    wallet = Wallet.createRandom();
    fs.writeFileSync(keyfile, wallet.privateKey + '\n');
    fs.chmodSync(keyfile, 0o600);
    log('keypair', true, { source: 'generated fresh', path: keyfile, address: wallet.address });
  } else {
    log('keypair', false, { error: 'no AGENT_PRIVATE_KEY and no keyfile; re-run with --generate-key' });
    process.exit(1);
  }

  // 3. Authenticate: challenge -> personal_sign -> session token.
  let token;
  try {
    const ch = await fetchJson(`${API}/api/auth/challenge?address=${wallet.address}`);
    if (!ch.ok || !ch.json || !ch.json.challenge) throw new Error(`challenge HTTP ${ch.status}`);
    const signature = await wallet.signMessage(ch.json.challenge);
    const v = await fetchJson(`${API}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature }),
    });
    if (!v.ok || !v.json || !v.json.token) throw new Error(`verify HTTP ${v.status}: ${v.text}`);
    token = v.json.token;
    log('authenticate', true, { address: wallet.address, handle: args.handle, expiresAt: v.json.expiresAt || null });
  } catch (e) {
    log('authenticate', false, { error: String(e.message || e) });
    process.exit(1);
  }
  const auth = { Authorization: 'Bearer ' + token };

  // 4. List open bounties.
  let open = [];
  try {
    const r = await fetchJson(`${API}/api/bounties?status=open`);
    if (!r.ok) throw new Error(`bounties HTTP ${r.status}`);
    open = r.json.bounties || [];
    log('list-open-bounties', true, { count: open.length, slugs: open.map((b) => b.slug) });
  } catch (e) {
    log('list-open-bounties', false, { error: String(e.message || e) });
    process.exit(1);
  }
  const openBySlug = new Map(open.map((b) => [b.slug, b]));
  for (const b of open) {
    if (!TARGETS.some((t) => t.slug === b.slug) && b.slug !== GATE_PROBE_SLUG) {
      log('skip-bounty', true, { slug: b.slug, reason: b.gated ? 'gated (requires $PROVE holding)' : 'no supported submission shape in this agent' });
    }
  }

  // 5. Live market data for the forecast strategies (fetched once, reused).
  let btcCloses = null;
  let nvda = null;
  try {
    btcCloses = await fetchBtcDailyCloses();
    log('market-data-btc', true, { points: btcCloses.length, last: btcCloses[btcCloses.length - 1] });
  } catch (e) {
    log('market-data-btc', false, { error: String(e.message || e) });
  }
  try {
    nvda = await fetchNvdaDailyCloses();
    log('market-data-nvda', true, { points: nvda.closes.length, last: nvda.lastPrice });
  } catch (e) {
    log('market-data-nvda', false, { error: String(e.message || e) });
  }

  // 6. Enter + submit each feasible target.
  const completed = [];
  const targets = args.only ? TARGETS.filter((t) => t.slug === args.only) : TARGETS;
  if (args.only && targets.length === 0) {
    console.error(`--only ${args.only} matches no known target. Known: ${TARGETS.map((t) => t.slug).join(', ')}`);
    process.exit(2);
  }
  for (const target of targets) {
    const bounty = openBySlug.get(target.slug);
    if (!bounty) {
      log(`target-${target.slug}`, false, { reason: 'not open right now' });
      continue;
    }
    if (bounty.gated) {
      log(`target-${target.slug}`, false, { reason: 'gated (requires $PROVE holding); skipped' });
      continue;
    }
    let prediction = null;
    let repoPayload = null;
    try {
      if (target.kind === 'yes-no') {
        if (!btcCloses) throw new Error('no BTC market data');
        const f = btcDirectionForecast(btcCloses);
        prediction = { answer: f.answer, confidence: f.confidence };
        log(`forecast-${target.slug}`, true, { ...f.detail, answer: f.answer, confidence: f.confidence });
      } else if (target.kind === 'number') {
        if (!nvda) throw new Error('no NVDA market data');
        const f = nvdaCloseForecast(nvda.closes);
        prediction = { answer: f.forecast };
        log(`forecast-${target.slug}`, true, { ...f.detail, forecast: f.forecast });
      } else if (target.kind === 'repo') {
        if (!args.repoUrl || !args.commit) {
          log(`target-${target.slug}`, false, { reason: 'needs --repo-url and --commit; skipped' });
          continue;
        }
        // Transcript = this run's own log so far (secrets are never logged).
        repoPayload = {
          repoUrl: args.repoUrl,
          commit: args.commit,
          transcript: logLines.map((l) => `[${l.ts}] ${l.ok ? 'OK' : 'FAIL'} ${l.step} ${JSON.stringify(l.detail)}`).join('\n'),
          handle: args.handle,
        };
        log(`build-${target.slug}`, true, { repoUrl: args.repoUrl, commit: args.commit });
      }
    } catch (e) {
      log(`forecast-${target.slug}`, false, { error: String(e.message || e) });
      continue;
    }

    if (!args.live) {
      log(`submit-${target.slug}`, true, { mode: 'DRY-RUN', wouldSubmit: prediction || { repoUrl: repoPayload.repoUrl, commit: repoPayload.commit } });
      continue;
    }

    // Enter (free; submit auto-enters, but the explicit enter proves the loop).
    const enter = await fetchJson(`${API}/api/bounties/${target.slug}/enter`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: args.handle }),
    });
    log(`enter-${target.slug}`, enter.ok, { http: enter.status, body: (enter.json && enter.json.message) || enter.text });
    if (!enter.ok && enter.status !== 400) {
      // A 400 here usually means "already entered" — submitting still works.
      log(`submit-${target.slug}`, false, { reason: `enter failed HTTP ${enter.status}` });
      continue;
    }

    const body = repoPayload || { prediction, handle: args.handle };
    const sub = await fetchJson(`${API}/api/bounties/${target.slug}/submit`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const subId = sub.json && (sub.json.id || (sub.json.submission && sub.json.submission.id));
    log(`submit-${target.slug}`, sub.ok, {
      http: sub.status,
      submissionId: subId || null,
      status: (sub.json && (sub.json.status || (sub.json.submission && sub.json.submission.status))) || null,
      body: sub.ok ? undefined : sub.text,
    });
    if (sub.ok && subId) completed.push({ slug: target.slug, submissionId: subId });
  }

  // 7. Gate probe: enter-only on a gated bounty, result logged either way.
  // Skipped when --only restricts the run to a single target.
  if (!args.only && openBySlug.get(GATE_PROBE_SLUG)) {
    if (!args.live) {
      log(`probe-enter-${GATE_PROBE_SLUG}`, true, { mode: 'DRY-RUN', note: 'would attempt enter; no submit (gated)' });
    } else {
      const probe = await fetchJson(`${API}/api/bounties/${GATE_PROBE_SLUG}/enter`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ handle: args.handle }),
      });
      log(`probe-enter-${GATE_PROBE_SLUG}`, probe.ok, { http: probe.status, body: (probe.json && probe.json.message) || probe.text });
    }
  }

  // 8. Verify via /api/me.
  try {
    const me = await fetchJson(`${API}/api/me`, { headers: auth });
    if (me.ok && me.json) {
      const subs = (me.json.submissions || []).filter((s) => completed.some((c) => c.submissionId === s.id));
      log('verify-/api/me', true, {
        address: wallet.address,
        submissionsTotal: (me.json.submissions || []).length,
        completedThisRun: completed,
        confirmedIds: subs.map((s) => s.id),
      });
    } else {
      log('verify-/api/me', false, { http: me.status });
    }
  } catch (e) {
    log('verify-/api/me', false, { error: String(e.message || e) });
  }

  // 9. Transcript (secrets stripped by construction: key/token never logged).
  const outPath = args.out || path.resolve(`transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  fs.writeFileSync(outPath, logLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`\nDone (${mode}). Completed this run: ${completed.length} bounty(ies): ${completed.map((c) => `${c.slug} -> ${c.submissionId}`).join(', ') || 'none'}`);
  console.log(`Transcript: ${outPath}`);
  console.log(`Agent address: ${wallet.address} | handle: ${args.handle}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
