#!/usr/bin/env node
/**
 * aiprove-autonomous-agent — a fully autonomous AIProve bounty agent.
 *
 * No human in the loop: it reads aiprove.fun/skill.md at runtime, signs in
 * with its own EVM keypair (EIP-191 personal_sign challenge), lists open
 * bounties, and enters + completes every one it can do on its own — forecasts
 * from live market data, and the bug-hunt challenge by executing the target
 * code and testing it against independently computed expectations.
 *
 * Run:  npm install && node agent.mjs
 *
 * Env:
 *   API_BASE_URL / AIPROVE_API_BASE  API base (default https://aiprove.fun).
 *                                    Point it at the staging arena to run
 *                                    against a sandbox host.
 *   AGENT_PRIVATE_KEY                hex private key (0x...). If unset, the
 *                                    agent loads AGENT_KEYPAIR_FILE or
 *                                    generates a FRESH keypair and saves it
 *                                    mode-600 to ./agent-keypair.json.
 *   AGENT_KEYPAIR_FILE               path to an ethers JSON keypair file
 *                                    {address, privateKey}.
 *   AGENT_HANDLE                     public handle (default auto-<addr6>).
 *   AIPROVE_DRY_RUN=1                auth + list + plan only; no enters or
 *                                    submits.
 *   AIPROVE_MAX_BOUNTIES             max bounties attempted per run (default 12).
 *   AIPROVE_STATE_DIR                where keypair/session/summary live
 *                                    (default: current working directory).
 *
 * Safety: the agent NEVER spends money, never buys PROVE, never pays any fee,
 * never reuses another wallet, and never writes a secret into the repo.
 * Anything it cannot complete cleanly is logged as skipped with a reason.
 */
import { Wallet } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

const API = (process.env.API_BASE_URL || process.env.AIPROVE_API_BASE || 'https://aiprove.fun').replace(/\/$/, '');
const STATE_DIR = process.env.AIPROVE_STATE_DIR || process.cwd();
const DRY_RUN = process.env.AIPROVE_DRY_RUN === '1';
const MAX_BOUNTIES = Number(process.env.AIPROVE_MAX_BOUNTIES || 12);
const HANDLE = process.env.AGENT_HANDLE || null;

const startedAt = new Date().toISOString();
const summary = {
  agent: 'aiprove-autonomous-agent',
  apiBase: API,
  startedAt,
  dryRun: DRY_RUN,
  address: null,
  handle: null,
  skillMd: null,
  entered: [],
  completed: [],
  skipped: [],
  errors: [],
};

const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// 1. Read skill.md at runtime (the agent's operating manual) and parse it.
// ---------------------------------------------------------------------------
async function readSkill() {
  const url = `${API}/skill.md`;
  try {
    const { status, text } = await fetchJson(url, {}, 20000);
    if (status !== 200 || !text) throw new Error(`HTTP ${status}`);
    const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    const endpoints = [...new Set([...text.matchAll(/\/api\/[a-z/:_-]+/gi)].map((m) => m[0]))];
    summary.skillMd = { url, bytes: text.length, sha256short: sha, endpoints };
    log(`skill.md: ${text.length} bytes, sha256 ${sha}, endpoints: ${endpoints.join(', ')}`);
    return text;
  } catch (e) {
    summary.errors.push(`skill.md fetch failed: ${e.message} (continuing with built-in endpoint table)`);
    log(`WARN skill.md fetch failed (${e.message}); continuing with built-in endpoints`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Identity: own keypair, never a hardcoded key, never another wallet.
// ---------------------------------------------------------------------------
function loadOrCreateKeypair() {
  if (process.env.AGENT_PRIVATE_KEY) {
    const w = new Wallet(process.env.AGENT_PRIVATE_KEY.trim());
    log(`identity: keypair from AGENT_PRIVATE_KEY env, address ${w.address}`);
    return w;
  }
  const file = process.env.AGENT_KEYPAIR_FILE || path.join(STATE_DIR, 'agent-keypair.json');
  if (fs.existsSync(file)) {
    const kp = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = new Wallet(kp.privateKey);
    log(`identity: keypair loaded from ${file}, address ${w.address}`);
    return w;
  }
  const w = Wallet.createRandom();
  fs.writeFileSync(file, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  log(`identity: generated FRESH keypair, address ${w.address} (saved mode 600 to ${file})`);
  return w;
}

// ---------------------------------------------------------------------------
// 3. Auth: EIP-191 challenge -> sign -> session token.
// ---------------------------------------------------------------------------
let token = null;
async function authenticate(wallet) {
  const ch = await fetchJson(`${API}/api/auth/challenge?address=${wallet.address}`);
  if (!ch.json?.challenge) throw new Error(`challenge failed: HTTP ${ch.status} ${ch.text.slice(0, 200)}`);
  const signature = await wallet.signMessage(ch.json.challenge);
  const v = await fetchJson(`${API}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  });
  if (!v.json?.token) throw new Error(`verify failed: HTTP ${v.status} ${v.text.slice(0, 200)}`);
  token = v.json.token;
  const sessionFile = path.join(STATE_DIR, 'agent-session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ address: wallet.address, token, expiresAt: v.json.expiresAt }, null, 2), { mode: 0o600 });
  log(`authenticated as ${wallet.address} (session saved mode 600, expiresAt ${v.json.expiresAt})`);
}

async function authed(path, body, reauthed = false) {
  const res = await fetchJson(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !reauthed) {
    log('session expired (401) — re-authenticating once');
    await authenticate(wallet);
    return authed(path, body, true);
  }
  return res;
}

// ---------------------------------------------------------------------------
// 4. Market data (public, keyless) for reasoned forecasts.
// ---------------------------------------------------------------------------
async function cryptoMoves() {
  // Returns { bitcoin: {usd, change24h}, ethereum: {...} } or null on failure.
  try {
    const r = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true', {}, 15000);
    if (r.status !== 200 || !r.json?.bitcoin) return null;
    return {
      bitcoin: { usd: r.json.bitcoin.usd, change24h: r.json.bitcoin.usd_24h_change },
      ethereum: { usd: r.json.ethereum.usd, change24h: r.json.ethereum.usd_24h_change },
    };
  } catch { return null; }
}

async function crypto7dChange() {
  try {
    const r = await fetchJson('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily', {}, 20000);
    if (r.status !== 200 || !r.json?.prices?.length) return null;
    const p = r.json.prices;
    return ((p[p.length - 1][1] - p[0][1]) / p[0][1]) * 100;
  } catch { return null; }
}

async function lastClose(symbol) {
  // Yahoo Finance chart API (public, no key): last daily close for SPY/GLD/NVDA.
  try {
    const r = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000);
    const closes = r.json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((c) => c != null);
    if (!closes?.length) return null;
    return closes[closes.length - 1];
  } catch { return null; }
}

// Calibrated direction call: sign of the move, confidence grows with its size.
function directionCall(changePct) {
  const conf = Math.min(0.55 + Math.abs(changePct) * 0.01, 0.65);
  return { answer: changePct >= 0 ? 'yes' : 'no', confidence: Math.round(conf * 100) / 100 };
}

// ---------------------------------------------------------------------------
// 5. Bug-hunt strategy: fetch the target, execute it, test it against
//    independently computed expectations. Only real mismatches are reported.
// ---------------------------------------------------------------------------
const BUG_HUNT_URL = 'https://raw.githubusercontent.com/AIProveRH/aiprove/main/challenges/bug-hunt-utils/utils.js';

async function huntBugs() {
  const r = await fetchJson(BUG_HUNT_URL, {}, 20000);
  if (r.status !== 200 || !r.text) throw new Error(`could not fetch utils.js: HTTP ${r.status}`);
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.module.exports = sandbox.exports;
  vm.createContext(sandbox);
  // utils.js is a plain script of function declarations; evaluate and probe.
  const probe = `
    ${r.text}
    JSON.stringify({
      f5: factorial(5), f2: factorial(2), f3: factorial(3),
      vAEIOU: countVowels("AEIOU"), vHELLO: countVowels("HELLO"),
      revEmoji: reverse("😀a"), palEmoji: isPalindrome("😀a😀"),
      tcDont: titleCase("don't")
    });
  `;
  const got = JSON.parse(vm.runInContext(probe, sandbox, { timeout: 5000 }));
  // Expectations computed independently (not copied from the target):
  const expected = {
    f5: 120, f2: 2, f3: 6,
    vAEIOU: 5, vHELLO: 2,
    revEmoji: [...'😀a'].reverse().join(''),
    palEmoji: true,
    tcDont: "Don't",
  };
  const cases = [
    ['factorial', 5, expected.f5, got.f5], ['factorial', 2, expected.f2, got.f2],
    ['factorial', 3, expected.f3, got.f3],
    ['countVowels', 'AEIOU', expected.vAEIOU, got.vAEIOU],
    ['countVowels', 'HELLO', expected.vHELLO, got.vHELLO],
    ['reverse', '😀a', expected.revEmoji, got.revEmoji],
    ['isPalindrome', '😀a😀', expected.palEmoji, got.palEmoji],
    ['titleCase', "don't", expected.tcDont, got.tcDont],
  ];
  const reports = [];
  for (const [fn, input, exp, actual] of cases) {
    if (actual !== exp) reports.push({ fn, input, expected: exp });
  }
  log(`bug-hunt: executed utils.js, ${reports.length}/${cases.length} test cases mismatch (reported)`);
  return reports;
}

// ---------------------------------------------------------------------------
// 6. Per-bounty planner: what can this agent complete on its own?
// ---------------------------------------------------------------------------
function planBounty(b) {
  const brief = (b.brief || '').toLowerCase();
  if (b.slug === 'best-autonomous-agent') return { do: false, reason: 'self-referential: cannot complete itself' };
  if (/prove credit|entry fee|deposit|buy prove/i.test(b.brief || '')) return { do: false, reason: 'requires payment/credit — never spend money' };
  if (b.slug === 'refer-most-agents') return { do: false, reason: 'needs human referrals, not completable autonomously' };
  if (b.lane === 'PosterJudge') return { do: false, reason: `PosterJudge ${b.cat} — needs human socials/media, not completable autonomously` };
  if (b.submitKind === 'repo' && b.slug !== 'bug-hunt-utils') return { do: false, reason: 'repo submit needs a GitHub remote the agent has no credentials for' };
  if (b.slug === 'top5-pons-24h') return { do: false, reason: 'no reliable pons launch data source' };
  if (b.slug === 'bug-hunt-utils') return { do: true, kind: 'bughunt' };
  if (b.submitKind === 'prediction') {
    if (/brier/i.test(b.metric || '') && /yes or no/i.test(b.brief || '')) return { do: true, kind: 'direction' };
    if (/absolute error/i.test(b.metric || '')) return { do: true, kind: 'numeric' };
    if (/realized pnl/i.test(b.metric || '') && /long or short/i.test(b.brief || '')) return { do: true, kind: 'signal' };
    return { do: false, reason: `prediction shape unknown (metric: ${b.metric})` };
  }
  return { do: false, reason: `unsupported submitKind=${b.submitKind} lane=${b.lane}` };
}

// ---------------------------------------------------------------------------
// 7. Build the prediction for one bounty.
// ---------------------------------------------------------------------------
async function buildPrediction(b, kind) {
  if (kind === 'direction') {
    const asset = /eth/i.test(b.slug) ? 'ethereum' : 'bitcoin';
    if (b.slug === 'forecast-btc-7d') {
      const ch7 = await crypto7dChange();
      if (ch7 == null) return { prediction: { answer: 'no', confidence: 0.55 }, note: 'no market data — base-rate prior' };
      return { prediction: directionCall(ch7), note: `BTC 7d change ${ch7.toFixed(2)}%` };
    }
    const moves = await cryptoMoves();
    if (!moves) return { prediction: { answer: 'no', confidence: 0.55 }, note: 'no market data — base-rate prior' };
    const m = moves[asset];
    return { prediction: directionCall(m.change24h), note: `${asset} $${m.usd} 24h ${m.change24h.toFixed(2)}%` };
  }
  if (kind === 'numeric') {
    const sym = /spy/i.test(b.slug) ? 'SPY' : /gold|gld/i.test(b.slug) ? 'GLD' : /nvda/i.test(b.slug) ? 'NVDA' : null;
    if (!sym) return null;
    const close = await lastClose(sym);
    if (close == null) return null;
    return { prediction: { answer: Math.round(close * 100) / 100 }, note: `${sym} last close $${close.toFixed(2)} (persistence)` };
  }
  if (kind === 'signal') {
    const moves = await cryptoMoves();
    if (!moves) return { prediction: { answer: 'short', confidence: 0.55 }, note: 'no market data — base-rate prior' };
    const m = moves.ethereum;
    const dir = m.change24h >= 0 ? 'long' : 'short';
    const conf = Math.min(0.55 + Math.abs(m.change24h) * 0.01, 0.65);
    return { prediction: { answer: dir, confidence: Math.round(conf * 100) / 100 }, note: `ETH $${m.usd} 24h ${m.change24h.toFixed(2)}%` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 8. Main loop.
// ---------------------------------------------------------------------------
let wallet;
async function main() {
  log(`aiprove-autonomous-agent starting (api=${API}, dryRun=${DRY_RUN})`);
  await readSkill();
  const health = await fetchJson(`${API}/api/health`);
  log(`health: HTTP ${health.status} ${health.text.slice(0, 120)}`);

  wallet = loadOrCreateKeypair();
  summary.address = wallet.address;
  summary.handle = HANDLE || `auto-${wallet.address.slice(2, 8).toLowerCase()}`;
  await authenticate(wallet);

  const list = await fetchJson(`${API}/api/bounties?status=open`);
  const bounties = list.json?.bounties || list.json || [];
  log(`open bounties: ${bounties.length}`);
  bounties.sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
  const todo = bounties.slice(0, MAX_BOUNTIES);

  for (const b0 of todo) {
    // The list endpoint omits submitKind; fetch the detail for the canonical kind.
    let b = b0;
    try {
      const det = await fetchJson(`${API}/api/bounties/${b0.slug}`, {}, 15000);
      if (det.json?.bounty) b = { ...b0, ...det.json.bounty, submitKind: det.json.submitKind ?? det.json.bounty.submitKind };
    } catch (e) {
      log(`WARN detail fetch failed for ${b0.slug}: ${e.message}`);
    }
    const plan = planBounty(b);
    if (!plan.do) {
      summary.skipped.push({ slug: b.slug, reason: plan.reason });
      log(`skip ${b.slug}: ${plan.reason}`);
      continue;
    }
    try {
      if (DRY_RUN) {
        summary.entered.push({ slug: b.slug, note: `dry-run plan: ${plan.kind}` });
        log(`dry-run plan ${b.slug}: would complete as ${plan.kind}`);
        continue;
      }
      const enter = await authed(`/api/bounties/${b.slug}/enter`, { handle: summary.handle });
      log(`enter ${b.slug}: HTTP ${enter.status}`);
      summary.entered.push({ slug: b.slug, status: enter.status });

      let submitBody;
      if (plan.kind === 'bughunt') {
        const reports = await huntBugs();
        if (!reports.length) {
          summary.skipped.push({ slug: b.slug, reason: 'no bugs found by runtime detectors' });
          log(`skip submit ${b.slug}: no bugs found`);
          continue;
        }
        // Proven shape for bughunt-kind submits: the report list goes in `prediction`.
        submitBody = { prediction: reports, handle: summary.handle };
        log(`submit ${b.slug}: ${reports.length} bug reports in prediction field`);
      } else {
        const built = await buildPrediction(b, plan.kind);
        if (!built) {
          summary.skipped.push({ slug: b.slug, reason: 'could not build a reasoned prediction (no market data)' });
          log(`skip submit ${b.slug}: no market data for a reasoned prediction`);
          continue;
        }
        submitBody = { prediction: built.prediction, handle: summary.handle };
        log(`submit ${b.slug}: ${JSON.stringify(built.prediction)} (${built.note})`);
      }

      let sub = await authed(`/api/bounties/${b.slug}/submit`, submitBody);
      // Numeric/signal shapes are undocumented; one shape fallback on 400.
      if (sub.status === 400 && plan.kind !== 'bughunt' && plan.kind !== 'direction') {
        const alt = { ...submitBody, prediction: { value: submitBody.prediction.answer } };
        log(`submit ${b.slug}: 400 on first shape, retrying with {value} shape`);
        sub = await authed(`/api/bounties/${b.slug}/submit`, alt);
        submitBody = alt;
      }
      if (sub.status === 201 || sub.status === 200) {
        const id = sub.json?.id || '(no id in response)';
        summary.completed.push({ slug: b.slug, kind: plan.kind, submissionId: id, status: sub.json?.status || 'ok' });
        log(`COMPLETED ${b.slug}: submission ${id} status=${sub.json?.status || 'ok'}`);
      } else {
        summary.errors.push(`${b.slug} submit HTTP ${sub.status}: ${sub.text.slice(0, 200)}`);
        log(`ERROR submit ${b.slug}: HTTP ${sub.status} ${sub.text.slice(0, 200)}`);
      }
    } catch (e) {
      summary.errors.push(`${b.slug}: ${e.message}`);
      log(`ERROR ${b.slug}: ${e.message}`);
    }
  }

  // Final status check (read-only).
  try {
    const me = await fetchJson(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (me.json) summary.me = { competing: me.json.competing, submissions: me.json.submissions };
    log(`/api/me: competing=${JSON.stringify(me.json?.competing)} submissions=${JSON.stringify(me.json?.submissions)}`);
  } catch (e) {
    log(`WARN /api/me failed: ${e.message}`);
  }

  summary.finishedAt = new Date().toISOString();
  summary.completedCount = summary.completed.length;
  fs.writeFileSync(path.join(STATE_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(STATE_DIR, 'run.log'), logLines.join('\n') + '\n');
  console.log('\n=== RUN SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e);
  summary.errors.push(`fatal: ${e.message}`);
  summary.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(path.join(STATE_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(STATE_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* ignore */ }
  process.exit(1);
});
