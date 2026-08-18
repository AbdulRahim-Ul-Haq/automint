// Wait for a drop to open, then mint once. Everything here is shaped by what
// went wrong on The Oil Rigs, 17 Aug:
//
//  * That collection sold out an hour BEFORE its public phase opened. The bot
//    fired anyway and sent 400 doomed transactions. So supply is now checked
//    before every attempt, and a sold-out collection ends the job immediately
//    with a reason, not a retry loop.
//  * Those 400 all became real on-chain reverts because an explicit gasLimit
//    made ethers skip estimateGas. Estimation is now the pre-flight: it fails
//    for free, off-chain, and its revert reason is what gets reported. A gas
//    limit is only applied once estimation has already succeeded.
//  * The sold-out branch existed but sat in the catch block, which only sees
//    estimation errors — mined reverts went down a different path and never
//    reached it. There is now one place that classifies a failure.
import { Contract, formatEther, parseUnits } from 'ethers';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPPLY_ABI = [
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getMintStats(address) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
];

// How many are left, and how many this wallet already has. Falls back through
// progressively weaker sources so an unusual contract still yields something.
export async function supplyOf(p, nft, who) {
  const c = new Contract(nft, SUPPLY_ABI, p);
  try {
    const s = await c.getMintStats(who);
    return { mine: Number(s.minterNumMinted), total: Number(s.currentTotalSupply), max: Number(s.maxSupply) };
  } catch {
    /* not a SeaDrop-style contract */
  }
  const total = await c.totalSupply().catch(() => null);
  const max = await c.maxSupply().catch(() => null);
  const mine = who ? await c.balanceOf(who).catch(() => null) : null;
  return { mine: mine === null ? null : Number(mine), total: total === null ? null : Number(total), max: max === null ? null : Number(max) };
}

export const isSoldOut = (s) => s.max != null && s.total != null && s.max > 0 && s.total >= s.max;

// One place that turns any failure into a decision. `fatal` means stop the job.
export function classify(err) {
  const m = String(err?.shortMessage ?? err?.reason ?? err?.info?.error?.message ?? err?.message ?? err);
  const t = m.toLowerCase();
  if (/notactive|not active|saleisnotactive|sale not|mint(ing)? not (yet )?(active|started)|beforestart/.test(t))
    return { kind: 'not-open', fatal: false, msg: 'the mint is not open yet' };
  if (/exceedsmaxsupply|sold ?out|maxsupply|supply exceeded|allminted/.test(t))
    return { kind: 'sold-out', fatal: true, msg: 'SOLD OUT — no supply left' };
  if (/exceedsmaxminted|maxmintedperwallet|already ?minted|walletlimit|exceeds.*per ?wallet/.test(t))
    return { kind: 'wallet-limit', fatal: true, msg: 'this wallet has already minted its allowance' };
  if (/insufficient funds/.test(t))
    return { kind: 'funds', fatal: true, msg: 'the wallet does not have enough to pay for the mint plus gas' };
  if (/incorrectpayment|wrong ?price|invalid ?payment/.test(t))
    return { kind: 'price', fatal: true, msg: 'the contract rejected the price — the drop config changed' };
  if (/feerecipientnotallowed/.test(t))
    return { kind: 'config', fatal: true, msg: 'the fee recipient is not allowed — re-arm to re-read the config' };
  if (/allowlist|merkle|proof|signature|signer/.test(t))
    return { kind: 'allowlist', fatal: true, msg: 'this phase is allowlist-gated and cannot be minted from here' };
  if (/530|502|503|timeout|econn|server_error|network/.test(t))
    return { kind: 'rpc', fatal: false, msg: 'the RPC endpoint hiccuped' };
  return { kind: 'unknown', fatal: false, msg: m.slice(0, 160) };
}

// Runs one armed drop to completion. `say` reports progress; `job` carries the
// resolved drop. Returns a result object; never throws for ordinary failure.
export async function runJob({ job, wallet, p, adapter, say, opts = {} }) {
  const nft = job.contract;
  const qty = job.quantity || 1;
  const cfg = job.cfg;
  const maxFee = parseUnits(String(opts.maxFeeGwei ?? 5), 'gwei');
  const prio = parseUnits(String(opts.priorityGwei ?? 1), 'gwei');
  const retryMs = opts.retryMs ?? 500;
  const maxAttempts = opts.maxAttempts ?? 60;
  const leadMs = opts.leadMs ?? 1500;

  const built = adapter.tx(nft, cfg, qty);
  const cost = built.value;

  // ── refuse early rather than at the window ──────────────────────────────
  // Supply comes first. A sold-out collection is not a funding problem, and
  // reporting one as the other is how someone ends up topping up a wallet for
  // a drop that ceased to exist an hour earlier.
  let s = await supplyOf(p, nft, wallet.address);
  if (isSoldOut(s)) return { ok: false, kind: 'sold-out', msg: `SOLD OUT (${s.total}/${s.max}) — nothing left to mint` };
  if (s.mine && cfg.perWallet && s.mine >= cfg.perWallet)
    return { ok: false, kind: 'wallet-limit', msg: `this wallet already holds ${s.mine}, its limit is ${cfg.perWallet}` };

  const bal = await p.getBalance(wallet.address);
  const headroom = parseUnits(String(opts.gasHeadroomEth ?? 0.003), 'ether');
  if (bal < cost + headroom) {
    return {
      ok: false, kind: 'funds',
      msg: `not enough funds: holds ${formatEther(bal)}, needs ${formatEther(cost + headroom)} ` +
        `(${formatEther(cost)} mint + gas). Send ${formatEther(cost + headroom - bal)} more to ${wallet.address}.`,
    };
  }

  // ── wait, on chain time ─────────────────────────────────────────────────
  if (cfg.startMs) {
    for (;;) {
      const blk = await p.getBlock('latest').catch(() => null);
      const now = blk ? blk.timestamp * 1000 : Date.now();
      if (cfg.endMs && now > cfg.endMs) return { ok: false, kind: 'closed', msg: 'the mint window closed' };
      const left = cfg.startMs - leadMs - now;
      if (left <= 0) break;
      // While waiting, keep watching supply: a collection that sells out in an
      // earlier phase is the single most likely reason this job is pointless,
      // and knowing at 01:30 beats finding out at 02:30.
      if (left > 120_000) {
        s = await supplyOf(p, nft, wallet.address);
        if (isSoldOut(s)) {
          return { ok: false, kind: 'sold-out', msg: `SOLD OUT at ${s.total}/${s.max}, ${Math.round(left / 60000)} min before your phase even opened` };
        }
      }
      await sleep(left > 120_000 ? 60_000 : Math.min(500, Math.max(50, left)));
    }
  }

  // ── fire ────────────────────────────────────────────────────────────────
  say?.(`window open — attempting (${formatEther(cost)} ${job.sym} for ${qty})`);
  let attempts = 0;
  let lastMsg = '';
  while (attempts < maxAttempts) {
    attempts += 1;
    s = await supplyOf(p, nft, wallet.address);
    if (isSoldOut(s)) return { ok: false, kind: 'sold-out', attempts, msg: `SOLD OUT (${s.total}/${s.max})` };
    if (s.mine && cfg.perWallet && s.mine >= cfg.perWallet)
      return { ok: true, kind: 'already', attempts, msg: `wallet already holds ${s.mine}` };

    try {
      // Estimation IS the pre-flight. It costs nothing and, crucially, a
      // failure here never becomes a paid on-chain revert.
      const gas = await p.estimateGas({ ...built, from: wallet.address });
      const tx = await wallet.sendTransaction({
        ...built,
        gasLimit: (gas * 130n) / 100n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: prio,
      });
      say?.(`sent ${tx.hash}`);
      const rc = await tx.wait(1);
      if (rc.status === 1) {
        const after = await supplyOf(p, nft, wallet.address);
        return { ok: true, kind: 'minted', attempts, hash: tx.hash, block: rc.blockNumber, held: after.mine, supply: `${after.total}/${after.max}` };
      }
      // A mined revert. Rare now that estimation gates every send, but if it
      // happens the same classifier decides, so it cannot loop forever.
      const c = classify('transaction reverted on chain');
      lastMsg = c.msg;
    } catch (e) {
      const c = classify(e);
      lastMsg = c.msg;
      if (c.fatal) return { ok: false, kind: c.kind, attempts, msg: c.msg };
      if (c.kind !== 'not-open' || attempts % 20 === 1) say?.(`attempt ${attempts}: ${c.msg}`);
    }
    await sleep(retryMs);
  }
  return { ok: false, kind: 'gave-up', attempts, msg: `no mint after ${attempts} attempts — last reason: ${lastMsg}` };
}
