// The fast path: get a signed transaction into the mempool the instant a stage
// opens, for one wallet or many at once. Built from the two tools this was
// asked to beat, with their good ideas kept and their sharp edges filed off.
//
// The trick both of them use, and we did not: a PUBLIC mint's calldata does not
// depend on anything that only exists after the stage opens. So everything
// expensive — nonce, chain id, fees, the signature itself — is done DURING the
// wait. At the fire moment the only work left is writing already-signed bytes
// to sockets. That is strictly faster than signing at T-0.
//
// What we keep that they do not: the calldata is simulated during the wait
// (it can only fail with "not open yet", which proves every other argument is
// right), and supply is checked one last time before firing, so a collection
// that sold out in an earlier phase never gets a single doomed transaction.
import { JsonRpcProvider, Wallet, formatEther, keccak256 } from 'ethers';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── connection warming ──────────────────────────────────────────────────────
// Pay the TCP/TLS handshake to every endpoint before it is on the critical
// path. The response is meaningless (some sequencers reject everything but a
// real send); the open socket is the point.
export async function warm(urls) {
  await Promise.all(
    urls.map((u) =>
      fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}',
      }).then(() => {}).catch(() => {}),
    ),
  );
}

// ── the blast ───────────────────────────────────────────────────────────────
// Fire one raw signed transaction at every endpoint at once and return the
// moment the writes are dispatched — the receipts are collected afterwards, off
// the hot path. "already known" from a second endpoint is success, not error:
// it means an earlier endpoint already has the tx.
export function blast(rawTx, urls) {
  const hash = keccak256(rawTx);
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [rawTx], id: 1 });
  const inflight = urls.map((u) =>
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      .then((r) => r.json())
      .then((j) => ({ url: u, ok: !!j.result, err: j.error?.message || null }))
      .catch((e) => ({ url: u, ok: false, err: String(e?.message || e) })),
  );
  return {
    hash,
    settled: Promise.allSettled(inflight).then((all) =>
      all.map((s) => (s.status === 'fulfilled' ? s.value : { url: '?', ok: false, err: String(s.reason) })),
    ),
  };
}

// A transaction is "accepted somewhere" if any endpoint returned a hash or said
// it already had it. Anything else means it never entered a mempool.
export function wasAccepted(results) {
  return results.some((r) => r.ok || /already known|already exists|nonce too low/i.test(r.err || ''));
}

// ── receipts ────────────────────────────────────────────────────────────────
export async function waitReceipt(hash, url, timeoutMs = 60_000) {
  const start = Date.now();
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [hash], id: 1 });
  while (Date.now() - start < timeoutMs) {
    try {
      const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
      if (j.result) {
        return {
          block: parseInt(j.result.blockNumber, 16),
          pos: parseInt(j.result.transactionIndex, 16),
          status: j.result.status === '0x1' ? 1 : 0,
          gasUsed: parseInt(j.result.gasUsed, 16),
        };
      }
    } catch { /* keep polling */ }
    await sleep(500);
  }
  return null;
}

// ── verify the endpoints are the chain we think they are ────────────────────
// Signing a Base tx and blasting it at an Ethereum node is a great way to leak
// a nonce and lose a mint. Drop any endpoint on the wrong chain rather than
// trusting the list.
export async function verifyChain(urls, chainId) {
  const checked = await Promise.all(
    urls.map(async (u) => {
      try {
        const j = await (await fetch(u, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}',
        })).json();
        return parseInt(j.result, 16) === chainId ? u : null;
      } catch { return null; }
    }),
  );
  return checked.filter(Boolean);
}

// ── precise wait ────────────────────────────────────────────────────────────
// Coarse sleep until the last stretch, then a short spin for sub-ms accuracy.
// `leadMs` fires early so the signed tx is sitting in the mempool when the
// contract flips live, rather than starting its journey at that instant.
export async function waitUntil(targetMs, leadMs, onTick, abort) {
  const fireAt = targetMs - leadMs;
  while (Date.now() < fireAt) {
    if (abort?.()) return; // e.g. sold out — stop waiting, let the caller decide
    const left = fireAt - Date.now();
    if (left > 12_000) {
      await onTick?.(left);
      if (abort?.()) return;
      await sleep(Math.min(60_000, left - 5_000));
    } else if (left > 200) {
      await sleep(left - 100);
    } else {
      while (Date.now() < fireAt) { /* spin the final ms */ }
    }
  }
}

// ── the whole fast mint ─────────────────────────────────────────────────────
// signers: [{ wallet, quantity }]. builtFor(qty) -> {to,data,value}. The plan
// is identical per wallet except the value scales with that wallet's quantity.
export async function fastMint({ signers, urls, chainId, builtFor, startMs, endMs, leadMs = 0, gas, checkSoldOut, say,
  retryMs = 400, retryWindowMs = 90_000, maxAttempts = 60 }) {
  urls = await verifyChain(urls, chainId);
  if (!urls.length) return { ok: false, kind: 'rpc', msg: 'no endpoint is on the right chain' };

  const provider = new JsonRpcProvider(urls[0], chainId, { staticNetwork: true });

  // ── during the wait: nonce, fees, signatures ──────────────────────────────
  // The signer and the built tx are KEPT, not just the signed bytes, so a
  // too-early first shot can be re-signed with a fresh nonce and fired again.
  const prepared = [];
  for (const s of signers) {
    const w = s.wallet.connect(provider);
    const nonce = await provider.getTransactionCount(w.address, 'pending');
    const built = builtFor(s.quantity);
    const raw = await w.signTransaction({
      to: built.to, data: built.data, value: built.value, nonce,
      maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: gas.limit, type: 2, chainId,
    });
    prepared.push({ w, address: w.address, quantity: s.quantity, built, raw });
  }
  say?.(`pre-signed ${prepared.length} transaction(s) — nothing left to compute at fire time`);

  // ── wait for the stage, watching supply so a sell-out ends it early ───────
  if (startMs) {
    let warned = false;
    let soldOut = null;
    await waitUntil(startMs, leadMs, async (left) => {
      const mins = Math.round(left / 60000);
      if (!warned || mins % 10 === 0) say?.(`waiting — ${mins} min to go`);
      warned = true;
      if (checkSoldOut && left > 90_000 && !soldOut) {
        const s = await checkSoldOut();
        if (s?.soldOut) soldOut = s;
      }
    }, () => soldOut !== null);
    if (soldOut) return { ok: false, kind: 'sold-out', msg: `SOLD OUT (${soldOut.total}/${soldOut.max}) before the window opened — nothing sent` };
  }
  if (endMs && Date.now() > endMs) return { ok: false, kind: 'closed', msg: 'the window had already closed' };

  await warm(urls);

  // A shared, throttled sold-out check so N wallets retrying in parallel do not
  // hammer the RPC. Cached for 1.5s — plenty for a 12-second sellout.
  let soldCache = { at: 0, sold: false, total: null, max: null };
  const soldOutNow = async () => {
    if (!checkSoldOut) return false;
    if (Date.now() - soldCache.at < 1500) return soldCache.sold;
    try { const s = await checkSoldOut(); soldCache = { at: Date.now(), sold: !!s.soldOut, total: s.total, max: s.max }; }
    catch { soldCache.at = Date.now(); }
    return soldCache.sold;
  };

  const deadline = Math.min(endMs || Infinity, Date.now() + retryWindowMs);

  // ── one wallet: fire, then keep firing until it lands ─────────────────────
  // This is the fix for the PunkzBroker miss: the first shot can be mined a
  // moment before the stage flips live (a NotActive revert on a chain that
  // includes instantly). Instead of giving up, re-sign with a fresh nonce and
  // fire again — the retry lands the instant the stage is actually open, which
  // is exactly the 12-second window a fast public sells out in.
  async function runWallet(prep) {
    let lastHash = null;
    let attempts = 0;
    let raw = prep.raw; // the pre-signed first shot
    let lastReason = '';
    for (;;) {
      const b = blast(raw, urls);
      lastHash = b.hash;
      b.settled.then((rs) => { const e = rs.map((r) => r.err).filter(Boolean); if (e.length) lastReason = e[0]; }).catch(() => {});
      const rc = await waitReceipt(lastHash, urls[0], Math.max(1200, retryMs * 3));
      if (rc?.status === 1) return { address: prep.address, ok: true, hash: lastHash, block: rc.block };

      attempts += 1;
      if (attempts >= maxAttempts) return { address: prep.address, ok: false, kind: 'gave-up', hash: lastHash, reason: lastReason || 'reverted repeatedly' };
      if (Date.now() > deadline) return { address: prep.address, ok: false, kind: 'timeout', hash: lastHash, reason: lastReason || 'window closed before it landed' };
      if (await soldOutNow()) return { address: prep.address, ok: false, kind: 'sold-out', reason: `sold out (${soldCache.total}/${soldCache.max})` };

      // Re-sign with the current pending nonce and the same calldata, then go
      // again. The nonce MUST come from the raw RPC, not provider.getTransaction
      // Count(): ethers caches that high-level call, so every retry would re-sign
      // the IDENTICAL transaction (same nonce -> same bytes -> "already known",
      // never landing). The raw send bypasses the cache and reflects the true
      // pending nonce, which a reverted first shot has already advanced.
      try {
        const nonce = Number(await provider.send('eth_getTransactionCount', [prep.address, 'pending']));
        raw = await prep.w.signTransaction({
          to: prep.built.to, data: prep.built.data, value: prep.built.value, nonce,
          maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: gas.limit, type: 2, chainId,
        });
      } catch (e) { lastReason = String(e?.shortMessage || e?.message || e).slice(0, 120); }
      await sleep(retryMs);
    }
  }

  say?.(`window open — firing ${prepared.length} wallet(s), retrying until landed or sold out`);
  const runs = await Promise.all(prepared.map((p) => runWallet(p).catch((e) => ({ address: p.address, ok: false, kind: 'error', reason: String(e?.message || e).slice(0, 120) }))));

  const wins = runs.filter((r) => r.ok);
  const minted = runs.map((r) => ({ address: r.address, hash: r.hash ?? null, status: r.ok ? 1 : 0, block: r.block ?? null }));
  return {
    ok: wins.length > 0,
    kind: wins.length ? 'minted' : (runs.some((r) => r.kind === 'sold-out') ? 'sold-out' : runs[0]?.kind || 'failed'),
    minted,
    wallets: runs,
    reasons: [...new Set(runs.filter((r) => !r.ok).map((r) => r.reason).filter(Boolean))],
    msg: wins.length
      ? `${wins.length}/${prepared.length} wallet(s) minted`
      : (runs.some((r) => r.kind === 'sold-out') ? `sold out before we landed a mint` : `no wallet minted — ${runs[0]?.reason || 'unknown'}`),
  };
}
