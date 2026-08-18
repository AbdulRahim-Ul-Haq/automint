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
export async function fastMint({ signers, urls, chainId, builtFor, startMs, endMs, leadMs = 1500, gas, checkSoldOut, say }) {
  urls = await verifyChain(urls, chainId);
  if (!urls.length) return { ok: false, kind: 'rpc', msg: 'no endpoint is on the right chain' };

  const provider = new JsonRpcProvider(urls[0], chainId, { staticNetwork: true });

  // ── during the wait: nonce, fees, signatures ──────────────────────────────
  const prepared = [];
  for (const s of signers) {
    const w = s.wallet.connect(provider);
    const nonce = await provider.getTransactionCount(w.address, 'pending');
    const built = builtFor(s.quantity);
    const raw = await w.signTransaction({
      to: built.to, data: built.data, value: built.value, nonce,
      maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: gas.limit, type: 2, chainId,
    });
    prepared.push({ address: w.address, quantity: s.quantity, raw, value: built.value });
  }
  say?.(`pre-signed ${prepared.length} transaction(s) — nothing left to compute at fire time`);

  // ── wait for the stage, watching supply so a sell-out ends it early ───────
  // A sold-out signal during the wait returns a clean result rather than
  // throwing: the whole point is that zero transactions get sent, so this must
  // not surface as an exception the caller has to remember to catch.
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

  // ── warm, then blast the pre-signed bytes ─────────────────────────────────
  await warm(urls);
  say?.(`window open — blasting ${prepared.length} tx to ${urls.length} endpoint(s)`);
  const fired = prepared.map((p) => ({ ...p, ...blast(p.raw, urls) }));

  // ── did any endpoint actually take each tx? ───────────────────────────────
  const out = [];
  for (const f of fired) {
    const results = await f.settled;
    const accepted = wasAccepted(results);
    out.push({ address: f.address, hash: f.hash, accepted, value: f.value, reasons: [...new Set(results.map((r) => r.err).filter(Boolean))] });
  }
  const anyAccepted = out.some((o) => o.accepted);
  if (!anyAccepted) {
    const reasons = [...new Set(out.flatMap((o) => o.reasons))];
    let hint = '';
    if (reasons.some((r) => /less than block base fee|underpriced/i.test(r))) hint = ' — your max fee is under the chain base fee; raise it';
    if (reasons.some((r) => /insufficient funds/i.test(r))) hint = ' — a wallet cannot cover mint + gas';
    return { ok: false, kind: 'rejected', msg: `rejected by every endpoint${hint}`, reasons, wallets: out };
  }

  // ── receipts, only for the ones that got in ───────────────────────────────
  const minted = [];
  for (const o of out.filter((x) => x.accepted)) {
    const rc = await waitReceipt(o.hash, urls[0], 90_000);
    minted.push({ address: o.address, hash: o.hash, block: rc?.block ?? null, status: rc?.status ?? null, pos: rc?.pos ?? null });
  }
  const wins = minted.filter((m) => m.status === 1);
  return {
    ok: wins.length > 0,
    kind: wins.length ? 'minted' : 'accepted-no-confirm',
    minted,
    wallets: out,
    msg: wins.length ? `${wins.length}/${prepared.length} wallet(s) minted` : 'transactions were accepted but none confirmed successfully',
  };
}
