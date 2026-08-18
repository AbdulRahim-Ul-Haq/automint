// Wallets live as files on the machine that runs the bot, never in chat.
//
// A key arrives one of two ways, both on-disk and never over Telegram:
//   * the operator writes keys/<name> themselves (mode 600), or
//   * /newwallet generates one HERE and writes it, showing only the address.
//
// Everything the chat can see or do is address-level: list, balances, generate,
// fund, remove. The private bytes are read only to sign, only inside this
// process, and are wiped from any object the chat could ever render.
import fs from 'node:fs';
import path from 'node:path';
import { Wallet, isHexString, isAddress, JsonRpcProvider, formatEther, parseEther } from 'ethers';

const KEYS_DIR = process.env.KEYS_DIR || './keys';

function ensureDir() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  try { fs.chmodSync(KEYS_DIR, 0o700); } catch { /* best effort on non-posix */ }
}

// A key file yields a Wallet or a reason it cannot. The reason never contains
// the bytes — only their shape — so it is safe to send to chat.
export function readKey(name) {
  const file = path.join(KEYS_DIR, name);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); }
  catch { return { err: `no key file "${name}"` }; }
  try {
    const st = fs.statSync(file);
    if (process.platform !== 'win32' && st.mode & 0o077) return { err: `${name} is readable by other users — chmod 600 it` };
  } catch { /* ignore */ }
  const k = raw.startsWith('0x') ? raw : '0x' + raw;
  if (!isHexString(k, 32)) {
    return { err: isAddress(raw) ? `${name} holds a WALLET ADDRESS, not a private key` : `${name} is not a 32-byte private key (${raw.length} chars)` };
  }
  try { return { wallet: new Wallet(k), name }; }
  catch { return { err: `${name} is not a valid private key` }; }
}

// Every usable wallet, plus the names that failed and why. Names only — no keys.
export function listWallets() {
  ensureDir();
  const ok = [];
  const bad = [];
  for (const name of fs.readdirSync(KEYS_DIR).sort()) {
    const f = path.join(KEYS_DIR, name);
    if (!fs.statSync(f).isFile()) continue;
    const r = readKey(name);
    if (r.wallet) ok.push({ name, address: r.wallet.address });
    else bad.push({ name, err: r.err });
  }
  return { ok, bad };
}

// Generate a fresh wallet on this machine and persist it 600. Refuses to
// clobber an existing name so a generated key can never overwrite a funded one.
export function newWallet(name) {
  ensureDir();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return { err: 'name must be letters, digits, dot, dash or underscore' };
  const file = path.join(KEYS_DIR, name);
  if (fs.existsSync(file)) return { err: `"${name}" already exists — pick another name` };
  const w = Wallet.createRandom();
  fs.writeFileSync(file, w.privateKey + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return { address: w.address, name };
}

// Remove a key file. This deletes the private key from disk; the caller decides
// whether that is wise (an unswept funded wallet loses its funds).
export function removeWallet(name) {
  const file = path.join(KEYS_DIR, name);
  if (!fs.existsSync(file)) return { err: `no key "${name}"` };
  fs.rmSync(file);
  return { ok: true };
}

export async function balances(names, provider, sym) {
  const out = [];
  for (const name of names) {
    const r = readKey(name);
    if (r.err) { out.push({ name, err: r.err }); continue; }
    try {
      const bal = await provider.getBalance(r.wallet.address);
      out.push({ name, address: r.wallet.address, eth: Number(formatEther(bal)), sym });
    } catch (e) { out.push({ name, address: r.wallet.address, err: 'balance read failed' }); }
  }
  return out;
}

// Fund many wallets from one funder, sequentially so a mid-run failure leaves a
// clear record of who got paid. Not atomic — that is Multicall3's job and it is
// not on every chain — but honest about what happened.
export async function fundWallets({ funderKey, targets, amountEth, provider, chainId, gas }) {
  const funder = new Wallet(funderKey, provider);
  const results = [];
  let nonce = await provider.getTransactionCount(funder.address, 'pending');
  const value = parseEther(String(amountEth));
  for (const name of targets) {
    const r = readKey(name);
    if (r.err) { results.push({ name, err: r.err }); continue; }
    try {
      const tx = await funder.sendTransaction({
        to: r.wallet.address, value, nonce: nonce++,
        maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: 21000, type: 2, chainId,
      });
      await tx.wait(1);
      results.push({ name, address: r.wallet.address, hash: tx.hash });
    } catch (e) { results.push({ name, err: String(e?.shortMessage || e?.message || e).slice(0, 80) }); }
  }
  return { funder: funder.address, results };
}

// Sweep each wallet's balance back to one address, leaving only a gas dust
// margin. Sequential and best-effort, same reasoning as funding.
export async function sweepWallets({ names, to, provider, chainId, gas }) {
  const results = [];
  const gasCost = gas.maxFee * 21000n;
  for (const name of names) {
    const r = readKey(name);
    if (r.err) { results.push({ name, err: r.err }); continue; }
    const w = r.wallet.connect(provider);
    try {
      const bal = await provider.getBalance(w.address);
      if (bal <= gasCost) { results.push({ name, skipped: `balance ${formatEther(bal)} below gas cost` }); continue; }
      const value = bal - gasCost;
      const nonce = await provider.getTransactionCount(w.address, 'pending');
      const tx = await w.sendTransaction({ to, value, nonce, maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: 21000, type: 2, chainId });
      await tx.wait(1);
      results.push({ name, address: w.address, sent: formatEther(value), hash: tx.hash });
    } catch (e) { results.push({ name, err: String(e?.shortMessage || e?.message || e).slice(0, 80) }); }
  }
  return results;
}
