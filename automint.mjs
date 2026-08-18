// automint — drop an OpenSea link into Telegram, get a fast multi-wallet
// auto-minter. Everything is run from chat except the one thing that must never
// touch chat: the private keys, which live as files on whatever machine runs
// this — your server, your laptop, or a Raspberry Pi in a drawer.
//
// The design owes its speed to two public CLIs (morsyxbt/nft-public-mint and
// zunmax/osnm-z): pre-sign every transaction during the wait, warm the sockets,
// and blast the finished bytes at every RPC the instant the stage opens. What
// it adds over both is that it is driven entirely from your phone and survives
// a reboot — no terminal window to keep open.
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Contract, formatEther, parseEther, parseUnits } from 'ethers';
import { resolve, provider as providerFor } from './resolve.mjs';
import { chainFor } from './chains.mjs';
import { supplyOf, isSoldOut } from './minter.mjs';
import { fastMint } from './fire.mjs';
import { listWallets, newWallet, removeWallet, readKey, balances, fundWallets, sweepWallets } from './wallets.mjs';

const CFG = {
  token: process.env.TELEGRAM_TOKEN || '',
  owner: String(process.env.OWNER_CHAT_ID || ''),
  keysDir: process.env.KEYS_DIR || './keys',
  dropsFile: process.env.DROPS_FILE || './drops.json',
  settingsFile: process.env.SETTINGS_FILE || './settings.json',
  maxSpendEth: Number(process.env.MAX_SPEND_ETH || 0.05),
};
if (!CFG.token) throw new Error('TELEGRAM_TOKEN is not set');
if (!CFG.owner) throw new Error('OWNER_CHAT_ID is not set — the bot would take orders from anyone');
process.env.KEYS_DIR = CFG.keysDir;

const API = `https://api.telegram.org/bot${CFG.token}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { log('tg', method, 'failed', e?.message); return null; }
}
const send = (text, extra = {}) => tg('sendMessage', { chat_id: CFG.owner, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ── persisted state ──────────────────────────────────────────────────────────
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let drops = load(CFG.dropsFile, []);
let settings = load(CFG.settingsFile, {});
// Defaults chosen for the chains we run on: fees are in gwei, tiny on L2s.
settings = { maxFeeGwei: 5, priorityGwei: 1, gasLimit: 250000, leadMs: 1500, gasHeadroomEth: 0.003, defaultWallets: 'all', ...settings };
const saveDrops = () => fs.writeFileSync(CFG.dropsFile, JSON.stringify(drops, null, 2));
const saveSettings = () => fs.writeFileSync(CFG.settingsFile, JSON.stringify(settings, null, 2));
let pending = null; // last resolved drop, awaiting /arm

const gasOf = () => ({
  maxFee: parseUnits(String(settings.maxFeeGwei), 'gwei'),
  priority: parseUnits(String(settings.priorityGwei), 'gwei'),
  limit: settings.gasLimit,
});

// which wallets a job uses: 'all', or a comma list of names
function resolveWalletNames(spec) {
  const { ok } = listWallets();
  if (!spec || spec === 'all') return ok.map((w) => w.name);
  const want = spec.split(',').map((s) => s.trim());
  return ok.filter((w) => want.includes(w.name)).map((w) => w.name);
}

// ── formatting ────────────────────────────────────────────────────────────────
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'not scheduled');
const inHrs = (ms) => (ms ? ((ms - Date.now()) / 3600000).toFixed(1) + 'h' : '—');

function card(r, walletNames) {
  const c = r.cfg;
  const supply = r.max != null && r.total != null ? `${r.total}/${r.max}` : 'unknown';
  const sold = isSoldOut({ total: r.total, max: r.max });
  return (
    `<b>${esc(r.name || 'collection')}</b>\n` +
    `chain    ${esc(r.chain.name)}\n` +
    `contract <code>${r.contract}</code>\n` +
    `mint via ${esc(r.adapter.label)}\n` +
    `price    ${c.priceWei == null ? '<b>unknown — /price &lt;eth&gt;</b>' : formatEther(c.priceWei) + ' ' + r.chain.sym}\n` +
    `opens    ${when(c.startMs)}${c.startMs ? ` (${inHrs(c.startMs)})` : ' — fires now'}\n` +
    `limit    ${c.perWallet || 'not stated'} per wallet\n` +
    `minted   ${supply}${sold ? '  ⚠️ SOLD OUT' : ''}\n` +
    `wallets  ${walletNames.length ? walletNames.join(', ') : '<b>none — /newwallet or add a key file</b>'}\n` +
    `qty      ${r.quantity} each\n\n` +
    `/arm to schedule · /wallets pick which · /qty n · /cancel`
  );
}

// ── commands ────────────────────────────────────────────────────────────────
const HELP =
  '<b>automint</b> — paste an OpenSea link, I resolve it, you /arm it.\n\n' +
  '<b>drops</b>\n' +
  '· send a collection link (or "&lt;contract&gt; &lt;chain&gt;")\n' +
  '/arm — schedule the drop I just showed\n' +
  '/qty &lt;n&gt; — how many per wallet\n' +
  '/wallets &lt;all|a,b&gt; — which wallets this drop uses\n' +
  '/price &lt;eth&gt; — set price if the contract hides it\n' +
  '/list · /cancel &lt;n&gt; · /check — armed drops\n\n' +
  '<b>wallets</b> (keys stay on this machine, never in chat)\n' +
  '/newwallet &lt;name&gt; — generate one here\n' +
  '/mywallets — list + balances\n' +
  '/fund &lt;funder&gt; &lt;amount&gt; &lt;a,b|all&gt; — spread funds\n' +
  '/sweep &lt;to&gt; &lt;a,b|all&gt; — pull funds back\n' +
  '/removewallet &lt;name&gt;\n\n' +
  '<b>settings</b>\n' +
  '/set gas &lt;maxGwei&gt; &lt;tipGwei&gt; · /set lead &lt;ms&gt; · /set gaslimit &lt;n&gt;\n' +
  '/settings — show all · /status — overview';

async function anyProvider(chainKey) {
  const ch = chainFor(chainKey);
  if (!ch.ok) throw new Error(ch.why);
  return { ch, p: await providerFor(ch) };
}

async function handle(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  if (/^\/(start|help)$/i.test(cmd)) return send(HELP);

  if (/^\/settings$/i.test(cmd))
    return send(
      `<b>settings</b>\n` +
      `gas ceiling   ${settings.maxFeeGwei} gwei\n` +
      `priority tip  ${settings.priorityGwei} gwei\n` +
      `gas limit     ${settings.gasLimit}\n` +
      `early-fire    ${settings.leadMs} ms\n` +
      `gas headroom  ${settings.gasHeadroomEth} (native)\n` +
      `spend ceiling ${CFG.maxSpendEth} per wallet (server-side, not settable here)`,
    );

  if (/^\/set$/i.test(cmd)) {
    const [k, ...vals] = rest;
    if (/^gas$/i.test(k)) {
      const [mx, tip] = vals.map(Number);
      if (!(mx > 0) || !(tip >= 0)) return send('use: /set gas &lt;maxGwei&gt; &lt;tipGwei&gt;');
      settings.maxFeeGwei = mx; settings.priorityGwei = tip; saveSettings();
      return send(`gas ceiling ${mx} gwei, tip ${tip} gwei.`);
    }
    if (/^lead$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 0)) return send('use: /set lead &lt;ms&gt;'); settings.leadMs = n; saveSettings(); return send(`early-fire ${n} ms.`); }
    if (/^gaslimit$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 21000)) return send('use: /set gaslimit &lt;n&gt;'); settings.gasLimit = n; saveSettings(); return send(`gas limit ${n}.`); }
    if (/^headroom$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 0)) return send('use: /set headroom &lt;eth&gt;'); settings.gasHeadroomEth = n; saveSettings(); return send(`gas headroom ${n}.`); }
    return send('settable: gas, lead, gaslimit, headroom');
  }

  // ── wallets ─────────────────────────────────────────────────────────────
  if (/^\/newwallet$/i.test(cmd)) {
    if (!arg) return send('use: /newwallet &lt;name&gt;');
    const r = newWallet(arg);
    if (r.err) return send('⛔ ' + esc(r.err));
    return send(`🔑 generated <b>${esc(r.name)}</b>\n<code>${r.address}</code>\n\nThe private key is on this machine only. Fund this address, then use it in a drop.`);
  }
  if (/^\/removewallet$/i.test(cmd)) {
    if (!arg) return send('use: /removewallet &lt;name&gt;');
    const r = removeWallet(arg);
    return send(r.err ? '⛔ ' + esc(r.err) : `Removed "${esc(arg)}". If it held funds they are now unreachable.`);
  }
  if (/^\/mywallets$/i.test(cmd)) {
    const { ok, bad } = listWallets();
    if (!ok.length && !bad.length) return send('No wallets yet. /newwallet &lt;name&gt;, or drop a key file in ' + CFG.keysDir);
    // balances on robinhood by default plus any chain that has an armed drop
    const chains = new Set(['robinhood', ...drops.filter((d) => d.state === 'armed').map((d) => d.chainKey)]);
    let out = '<b>wallets</b>\n';
    for (const w of ok) out += `· <b>${esc(w.name)}</b> <code>${short(w.address)}</code>\n`;
    for (const key of chains) {
      try {
        const { ch, p } = await anyProvider(key);
        const bals = await balances(ok.map((w) => w.name), p, ch.sym);
        out += `\n<i>${esc(ch.name)}</i>\n`;
        for (const b of bals) out += `  ${esc(b.name)}: ${b.err ? esc(b.err) : b.eth.toFixed(5) + ' ' + b.sym}\n`;
      } catch { out += `\n<i>${esc(key)}</i>: rpc unavailable\n`; }
    }
    for (const b of bad) out += `\n⚠️ ${esc(b.name)}: ${esc(b.err)}`;
    return send(out);
  }
  if (/^\/fund$/i.test(cmd)) {
    const [funder, amount, whoSpec] = rest;
    if (!funder || !amount) return send('use: /fund &lt;funderName&gt; &lt;amountEach&gt; &lt;a,b|all&gt;');
    const fr = readKey(funder);
    if (fr.err) return send('⛔ funder ' + esc(fr.err));
    const targets = resolveWalletNames(whoSpec || 'all').filter((n) => n !== funder);
    if (!targets.length) return send('no target wallets.');
    const armedChain = pending?.chain?.key || 'robinhood';
    await send(`Funding ${targets.length} wallet(s) with ${amount} each from ${esc(funder)} on ${armedChain}…`);
    try {
      const { ch, p } = await anyProvider(armedChain);
      const res = await fundWallets({ funderKey: fr.wallet.privateKey, targets, amountEth: amount, provider: p, chainId: ch.id, gas: gasOf() });
      return send('done:\n' + res.results.map((r) => `· ${esc(r.name)}: ${r.err ? '⛔ ' + esc(r.err) : '✅ ' + short(r.hash)}`).join('\n'));
    } catch (e) { return send('⛔ ' + esc(String(e.message).slice(0, 150))); }
  }
  if (/^\/sweep$/i.test(cmd)) {
    const [to, whoSpec] = rest;
    if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) return send('use: /sweep &lt;toAddress&gt; &lt;a,b|all&gt;');
    const names = resolveWalletNames(whoSpec || 'all');
    if (!names.length) return send('no wallets to sweep.');
    const key = pending?.chain?.key || 'robinhood';
    await send(`Sweeping ${names.length} wallet(s) to ${short(to)} on ${key}…`);
    try {
      const { ch, p } = await anyProvider(key);
      const res = await sweepWallets({ names, to, provider: p, chainId: ch.id, gas: gasOf() });
      return send('done:\n' + res.map((r) => `· ${esc(r.name)}: ${r.err ? '⛔ ' + esc(r.err) : r.skipped ? '— ' + esc(r.skipped) : '✅ ' + r.sent + ' ' + ch.sym}`).join('\n'));
    } catch (e) { return send('⛔ ' + esc(String(e.message).slice(0, 150))); }
  }

  // ── drop shaping ────────────────────────────────────────────────────────
  if (/^\/qty$/i.test(cmd)) {
    if (!pending) return send('Resolve a drop first.');
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return send('use: /qty &lt;n&gt;');
    if (pending.cfg.perWallet && n > pending.cfg.perWallet) return send(`That drop allows ${pending.cfg.perWallet} per wallet.`);
    pending.quantity = n;
    return send(card(pending, resolveWalletNames(pending.walletSpec)));
  }
  if (/^\/wallets$/i.test(cmd)) {
    if (!pending) return send('Resolve a drop first, then choose its wallets.');
    pending.walletSpec = arg || 'all';
    const names = resolveWalletNames(pending.walletSpec);
    if (!names.length) return send('That matched no wallets. /mywallets to see names.');
    return send(card(pending, names));
  }
  if (/^\/price$/i.test(cmd)) {
    if (!pending) return send('Resolve a drop first.');
    try { pending.cfg.priceWei = parseEther(arg); pending.cfg.needsManualPrice = false; return send(card(pending, resolveWalletNames(pending.walletSpec))); }
    catch { return send('use: /price 0.012'); }
  }

  if (/^\/list$/i.test(cmd)) {
    if (!drops.length) return send('Nothing armed. Send an OpenSea link.');
    return send(drops.map((d, i) => `${i + 1}. <b>${esc(d.name)}</b> — ${d.state}\n   ${esc(d.chainName)}, ${d.walletNames?.length || 0} wallet(s), opens ${when(d.cfg.startMs)}${d.result ? `\n   ${esc(d.result)}` : ''}`).join('\n'));
  }
  if (/^\/cancel$/i.test(cmd)) {
    if (!arg && pending) { pending = null; return send('Dropped.'); }
    const i = Number(arg) - 1;
    if (!drops[i]) return send('No such entry — /list.');
    const [g] = drops.splice(i, 1); saveDrops();
    return send(`Cancelled <b>${esc(g.name)}</b>.`);
  }
  if (/^\/check$/i.test(cmd)) {
    const armed = drops.filter((d) => d.state === 'armed');
    if (!armed.length) return send('Nothing armed.');
    let out = '';
    for (const d of armed) {
      try { const { p } = await anyProvider(d.chainKey); const s = await supplyOf(p, d.contract, null); out += `<b>${esc(d.name)}</b>: ${s.total}/${s.max}${isSoldOut(s) ? ' — SOLD OUT' : ''}\n`; }
      catch (e) { out += `<b>${esc(d.name)}</b>: ${esc(String(e.message).slice(0, 50))}\n`; }
    }
    return send(out);
  }

  if (/^\/status$/i.test(cmd)) {
    const { ok } = listWallets();
    const armed = drops.filter((d) => d.state === 'armed');
    return send(
      `<b>automint</b>\n${ok.length} wallet(s), ${armed.length} armed drop(s)\n` +
      `gas ${settings.maxFeeGwei}/${settings.priorityGwei} gwei · lead ${settings.leadMs}ms\n` +
      `keys dir <code>${CFG.keysDir}</code> (on this machine only)\n` +
      `/help for everything`,
    );
  }

  if (/^\/arm$/i.test(cmd)) {
    if (!pending) return send('Nothing to arm — send an OpenSea link first.');
    const c = pending.cfg;
    if (c.priceWei == null) return send('No price read for this drop. /price &lt;eth&gt; first.');
    const names = resolveWalletNames(pending.walletSpec);
    if (!names.length) return send('No wallets selected. /newwallet or /wallets first.');
    const per = c.priceWei * BigInt(pending.quantity || 1);
    if (per > parseEther(String(CFG.maxSpendEth)))
      return send(`⛔ ${formatEther(per)} per wallet exceeds the ${CFG.maxSpendEth} ceiling (server-side, not settable from chat).`);
    const job = {
      id: Date.now(), name: pending.name, contract: pending.contract,
      chainKey: pending.chain.key, chainName: pending.chain.name, sym: pending.chain.sym,
      adapterName: pending.adapter.name, cfg: { ...c, priceWei: c.priceWei.toString() },
      quantity: pending.quantity || 1, walletNames: names, state: 'armed',
    };
    drops.push(job); saveDrops(); pending = null;
    send(`✅ Armed <b>${esc(job.name)}</b>\n${names.length} wallet(s) × ${formatEther(per)} ${job.sym}\nopens ${when(job.cfg.startMs)}\nI'll message you when it fires.`);
    runArmed(job);
    return;
  }

  if (/opensea\.io/i.test(text) || /^0x[a-fA-F0-9]{40}\s+[a-z_]+$/i.test(text.trim())) {
    await send('Looking it up on-chain…');
    try {
      const r = await resolve(text.trim());
      pending = { ...r, quantity: 1, walletSpec: settings.defaultWallets };
      return send(card(r, resolveWalletNames(pending.walletSpec)));
    } catch (e) { return send('⛔ ' + esc(e.message)); }
  }
  return send('Send an OpenSea collection link, or /help.');
}

// ── running an armed drop ──────────────────────────────────────────────────
async function runArmed(job) {
  try {
    const { ch, p } = await anyProvider(job.chainKey);
    const { ADAPTERS } = await import('./resolve.mjs');
    const adapter = ADAPTERS.find((a) => a.name === job.adapterName);
    const cfg = { ...job.cfg, priceWei: BigInt(job.cfg.priceWei) };

    // wallets, resolved fresh at run time (a key may have been added since)
    const signers = [];
    for (const name of job.walletNames) {
      const r = readKey(name);
      if (r.wallet) signers.push({ wallet: r.wallet, quantity: job.quantity, name });
    }
    if (!signers.length) { job.state = 'failed'; job.result = 'no usable wallet keys at run time'; saveDrops(); return send(`⛔ <b>${esc(job.name)}</b>: no usable wallet keys`); }

    // funds + supply gate up front (our edge, kept)
    const cost = cfg.priceWei * BigInt(job.quantity);
    const headroom = parseEther(String(settings.gasHeadroomEth));
    const under = [];
    for (const s of signers) {
      const bal = await p.getBalance(s.wallet.address);
      if (bal < cost + headroom) under.push(`${s.name} (${formatEther(bal)}, needs ${formatEther(cost + headroom)})`);
    }
    if (under.length === signers.length) {
      job.state = 'failed'; job.result = 'every wallet underfunded'; saveDrops();
      return send(`⛔ <b>${esc(job.name)}</b>: every wallet is short.\n${under.map(esc).join('\n')}`);
    }
    if (under.length) await send(`⚠️ <b>${esc(job.name)}</b>: skipping underfunded ${under.map((u) => esc(u.split(' ')[0])).join(', ')} — the rest will still fire.`);
    const funded = signers.filter((s) => !under.some((u) => u.startsWith(s.name + ' ')));

    let s0 = await supplyOf(p, job.contract, funded[0].wallet.address);
    if (isSoldOut(s0)) { job.state = 'failed'; job.result = `sold out (${s0.total}/${s0.max})`; saveDrops(); return send(`❌ <b>${esc(job.name)}</b>: SOLD OUT (${s0.total}/${s0.max}) — nothing sent.`); }

    const res = await fastMint({
      signers: funded,
      urls: ch.rpcs,
      chainId: ch.id,
      builtFor: (qty) => adapter.tx(job.contract, cfg, qty),
      startMs: cfg.startMs,
      endMs: cfg.endMs,
      leadMs: settings.leadMs,
      gas: gasOf(),
      checkSoldOut: async () => { const s = await supplyOf(p, job.contract, null); return { soldOut: isSoldOut(s), total: s.total, max: s.max }; },
      say: (m) => log(`[${job.name}]`, m),
    });

    job.state = res.ok ? 'minted' : 'failed';
    job.result = res.msg;
    saveDrops();
    if (res.ok) {
      const lines = res.minted.filter((m) => m.status === 1).map((m) => `· ${short(m.address)} — block ${m.block}, tx <code>${short(m.hash)}</code>`).join('\n');
      await send(`🎉 <b>MINTED ${esc(job.name)}</b>\n${esc(res.msg)}\n${lines}`);
    } else {
      await send(`❌ <b>${esc(job.name)}</b> — ${esc(res.msg)}${res.reasons?.length ? '\n' + res.reasons.slice(0, 3).map(esc).join('\n') : ''}`);
    }
  } catch (e) {
    job.state = 'failed'; job.result = String(e.message); saveDrops();
    await send(`⛔ <b>${esc(job.name)}</b> errored: ${esc(String(e.message).slice(0, 200))}`);
  }
}

// ── main loop ──────────────────────────────────────────────────────────────
let offset = 0;
async function poll() {
  const r = await tg('getUpdates', { offset, timeout: 50 });
  if (!r?.ok) return;
  for (const u of r.result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    if (String(m.chat.id) !== CFG.owner) { log('ignored chat', m.chat.id); continue; }
    try { await handle(m.text); }
    catch (e) { log('handler error', e); await send('⛔ ' + esc(String(e.message).slice(0, 200))); }
  }
}

log('automint starting');
const { ok } = listWallets();
await send(`🟢 automint up.\n${ok.length} wallet(s), ${drops.filter((d) => d.state === 'armed').length} armed.\nSend an OpenSea link or /help.`);
for (const d of drops.filter((x) => x.state === 'armed')) runArmed(d);
for (;;) { await poll().catch((e) => log('poll error', e?.message)); await new Promise((r) => setTimeout(r, 400)); }
