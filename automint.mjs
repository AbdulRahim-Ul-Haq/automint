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
import { JsonRpcProvider, Contract, formatEther, parseEther, parseUnits, formatUnits } from 'ethers';
import { resolve, provider as providerFor, slugFromUrl } from './resolve.mjs';
import { chainFor } from './chains.mjs';
import { supplyOf, isSoldOut } from './minter.mjs';
import { fastMint } from './fire.mjs';
import { checkEligibility, allowlistMint } from './allowlist.mjs';
import { listWallets, newWallet, removeWallet, readKey, balances, fundWallets, sweepWallets } from './wallets.mjs';
import { sendNfts } from './nft.mjs';

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
// Gas is adaptive by default, not a fixed number, because "the right fee"
// differs 1000x between chains: Robinhood runs at ~0.02 gwei, Ethereum can be
// hundreds. So maxFee is derived from the LIVE base fee — base x multiplier,
// capped — and the funds check reserves exactly gasLimit x that, not a made-up
// constant. A real SeaDrop mint uses ~154k gas; at 0.02 gwei that is $0.006, so
// on a cheap chain the reservation is a few cents, as it should be.
//   maxFeeGwei = 0  -> adaptive (recommended). A number pins it by hand.
settings = { maxFeeGwei: 0, gasMultiplier: 4, priorityGwei: 0, gasLimit: 250000, maxFeeCapGwei: 100, leadMs: 1500, defaultWallets: 'all', ...settings };
const saveDrops = () => fs.writeFileSync(CFG.dropsFile, JSON.stringify(drops, null, 2));
const saveSettings = () => fs.writeFileSync(CFG.settingsFile, JSON.stringify(settings, null, 2));
let pending = null; // last resolved drop, awaiting /arm

// Live-base-fee gas. Reads the chain's current fee, sets maxFee = base x
// multiplier (so a spike between signing and firing still lands), a tiny
// priority tip, and returns the exact reservation a node will check. A hand-set
// maxFeeGwei overrides the adaptive path entirely.
async function computeGas(provider) {
  const limit = BigInt(settings.gasLimit);
  let maxFee, priority;
  if (settings.maxFeeGwei > 0) {
    maxFee = parseUnits(String(settings.maxFeeGwei), 'gwei');
    priority = parseUnits(String(settings.priorityGwei || 0), 'gwei');
  } else {
    let base = 0n;
    try { base = (await provider.getFeeData()).gasPrice ?? 0n; } catch { /* fall back below */ }
    if (base <= 0n) base = parseUnits('0.02', 'gwei'); // a sane floor if the feed is down
    const cap = parseUnits(String(settings.maxFeeCapGwei), 'gwei');
    maxFee = base * BigInt(settings.gasMultiplier);
    if (maxFee > cap) maxFee = cap;
    // priority: the user's fixed tip if set, else a 10% nudge over base
    priority = settings.priorityGwei > 0 ? parseUnits(String(settings.priorityGwei), 'gwei') : base / 10n;
    if (priority > maxFee) priority = maxFee;
  }
  // The reservation a node enforces before accepting the tx: gasLimit x maxFee.
  // Plus 25% so a small base-fee wobble does not tip the wallet under.
  const reserve = (limit * maxFee * 5n) / 4n;
  return { maxFee, priority, limit: settings.gasLimit, reserve };
}

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
  '/list · /cancel &lt;n&gt; · /check — armed drops\n' +
  '/allowlist — check which wallets are on the presale list\n' +
  '/armallowlist &lt;stageIndex&gt; — arm an authenticated presale mint\n\n' +
  '<b>wallets</b> (keys stay on this machine, never in chat)\n' +
  '/newwallet &lt;name&gt; — generate one here\n' +
  '/mywallets — list + balances\n' +
  '/fund &lt;funder&gt; &lt;amount&gt; &lt;a,b|all&gt; — spread funds\n' +
  '/sweep &lt;to&gt; &lt;a,b|all&gt; — pull ETH back\n' +
  '/sendnft &lt;link&gt; &lt;to&gt; &lt;a,b|all&gt; — send minted NFTs to your wallet\n' +
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

  if (/^\/settings$/i.test(cmd)) {
    // show the gas that WOULD be used on robinhood right now, so the numbers
    // are real rather than abstract
    let live = '';
    try {
      const g = await computeGas(await providerFor(chainFor('robinhood')));
      live = `\nright now on Robinhood: maxFee ${Number(formatUnits(g.maxFee, 'gwei')).toFixed(3)} gwei · reserve ${formatEther(g.reserve)} ETH per wallet`;
    } catch { /* offline is fine */ }
    return send(
      `<b>settings</b>\n` +
      `gas mode      ${settings.maxFeeGwei > 0 ? `fixed ${settings.maxFeeGwei} gwei` : `adaptive (${settings.gasMultiplier}× live base fee, cap ${settings.maxFeeCapGwei} gwei)`}\n` +
      `priority tip  ${settings.priorityGwei > 0 ? settings.priorityGwei + ' gwei' : 'auto'}\n` +
      `gas limit     ${settings.gasLimit}\n` +
      `early-fire    ${settings.leadMs} ms\n` +
      `spend ceiling ${CFG.maxSpendEth} per wallet (server-side, not settable here)` +
      live,
    );
  }

  if (/^\/set$/i.test(cmd)) {
    const [k, ...vals] = rest;
    if (/^gas$/i.test(k)) {
      // /set gas auto  -> adaptive; /set gas <maxGwei> [tipGwei] -> fixed
      if (/^auto$/i.test(vals[0] || '')) { settings.maxFeeGwei = 0; saveSettings(); return send('gas is adaptive again — maxFee tracks the live base fee.'); }
      const [mx, tip] = vals.map(Number);
      if (!(mx > 0)) return send('use: /set gas auto  (recommended) — or /set gas &lt;maxGwei&gt; [tipGwei] to pin it');
      settings.maxFeeGwei = mx; if (tip >= 0) settings.priorityGwei = tip; saveSettings();
      return send(`gas pinned: maxFee ${mx} gwei${tip >= 0 ? `, tip ${tip} gwei` : ''}. /set gas auto to go back to adaptive.`);
    }
    if (/^mult(iplier)?$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 1)) return send('use: /set mult &lt;n&gt; (maxFee = n × base fee)'); settings.gasMultiplier = n; saveSettings(); return send(`adaptive multiplier ${n}× base fee.`); }
    if (/^cap$/i.test(k)) { const n = Number(vals[0]); if (!(n > 0)) return send('use: /set cap &lt;gwei&gt;'); settings.maxFeeCapGwei = n; saveSettings(); return send(`adaptive fee cap ${n} gwei.`); }
    if (/^lead$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 0)) return send('use: /set lead &lt;ms&gt;'); settings.leadMs = n; saveSettings(); return send(`early-fire ${n} ms.`); }
    if (/^gaslimit$/i.test(k)) { const n = Number(vals[0]); if (!(n >= 21000)) return send('use: /set gaslimit &lt;n&gt;'); settings.gasLimit = n; saveSettings(); return send(`gas limit ${n}.`); }
    return send('settable: gas (auto|&lt;gwei&gt;), mult, cap, lead, gaslimit');
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
      const res = await fundWallets({ funderKey: fr.wallet.privateKey, targets, amountEth: amount, provider: p, chainId: ch.id, gas: await computeGas(p) });
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
      const res = await sweepWallets({ names, to, provider: p, chainId: ch.id, gas: await computeGas(p) });
      return send('done:\n' + res.map((r) => `· ${esc(r.name)}: ${r.err ? '⛔ ' + esc(r.err) : r.skipped ? '— ' + esc(r.skipped) : '✅ ' + r.sent + ' ' + ch.sym}`).join('\n'));
    } catch (e) { return send('⛔ ' + esc(String(e.message).slice(0, 150))); }
  }
  if (/^\/sendnft$/i.test(cmd)) {
    // /sendnft <collectionLinkOr"contract chain"> <toAddress> [a,b|all]
    // The collection tells us both the contract and the chain, so a raw contract
    // must carry its chain: "0x… robinhood 0xYourWallet".
    let contract = null, chainKey = null, to = null, whoSpec = 'all';
    const linkMatch = text.match(/opensea\.io\/\S+/i);
    const addrs = (text.match(/0x[a-fA-F0-9]{40}/g) || []);
    if (linkMatch) {
      try { const r = await resolve(linkMatch[0]); contract = r.contract; chainKey = r.chain.key; } catch (e) { return send('⛔ ' + esc(e.message)); }
      to = addrs[0]; whoSpec = rest[rest.length - 1] && !/^0x/.test(rest[rest.length - 1]) ? rest[rest.length - 1] : 'all';
    } else if (addrs.length >= 2) {
      const chainWord = rest.find((w) => chainFor(w).ok);
      contract = addrs[0]; to = addrs[1]; chainKey = chainWord || 'robinhood';
      const last = rest[rest.length - 1];
      whoSpec = last && !/^0x/.test(last) && !chainFor(last).ok ? last : 'all';
    } else {
      return send('use: /sendnft &lt;opensea-link&gt; &lt;toAddress&gt; [a,b|all]\nor: /sendnft &lt;contract&gt; &lt;chain&gt; &lt;toAddress&gt; [a,b|all]');
    }
    if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) return send('I need a destination address to send the NFTs to.');
    const names = resolveWalletNames(whoSpec);
    if (!names.length) return send('no wallets selected.');
    await send(`Looking for NFTs of <code>${short(contract)}</code> in ${names.length} wallet(s) on ${esc(chainKey)}, sending any found to ${short(to)}…`);
    try {
      const { ch, p } = await anyProvider(chainKey);
      const res = await sendNfts({ names, contract, to, provider: p, chainId: ch.id, gas: await computeGas(p), readKey, say: (m) => log('[sendnft]', m) });
      const lines = res.map((r) => r.err ? `· ${esc(r.name)}${r.tokenId ? ' #' + r.tokenId : ''}: ⛔ ${esc(r.err)}` : r.none ? `· ${esc(r.name)}: no NFTs held` : `· ${esc(r.name)} #${r.tokenId}: ✅ ${short(r.hash)}`).join('\n');
      const moved = res.filter((r) => r.hash).length;
      return send(`sent ${moved} NFT(s):\n${lines}`);
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

  // ── allowlist / presale (authenticated OpenSea path) ──────────────────────
  if (/^\/allowlist$/i.test(cmd)) {
    if (!pending) return send('Resolve a drop first, then /allowlist to check presale eligibility.');
    const slug = pending.slug || slugFromUrl(pending.sourceUrl || '');
    if (!slug) return send('This drop came in as a raw contract, so I have no OpenSea slug to check the presale with. Send the collection LINK instead.');
    const names = resolveWalletNames(pending.walletSpec);
    if (!names.length) return send('No wallets selected. /newwallet or /wallets first.');
    const signers = names.map((n) => ({ name: n, wallet: readKey(n).wallet })).filter((x) => x.wallet);
    await send(`Signing in to OpenSea as ${signers.length} wallet(s) to check the presale list — each signs with its own key, nothing leaves this machine…`);
    try {
      const rows = await checkEligibility({ signers, slug, chainId: pending.chain.id });
      let out = `<b>presale eligibility — ${esc(pending.name)}</b>`;
      let anyEligible = false;
      for (const r of rows) {
        if (!r.ok) { out += `\n· <b>${esc(r.name)}</b>: ⛔ ${esc(r.err)}`; continue; }
        const elig = r.stages.filter((st) => st.eligible);
        if (elig.length) { anyEligible = true; out += `\n· <b>${esc(r.name)}</b> ${short(r.address)}: ✅ stage(s) ${elig.map((st) => `${st.index} (${esc(st.type)})`).join(', ')}`; }
        else out += `\n· <b>${esc(r.name)}</b> ${short(r.address)}: not on any presale list`;
      }
      out += anyEligible ? '\n\nArm one with /armallowlist &lt;stageIndex&gt;' : '\n\nNo wallet is on a presale list. Use /arm for the public stage instead.';
      pending.eligibilityChecked = rows;
      return send(out);
    } catch (e) { return send('⛔ ' + esc(String(e.message).slice(0, 200))); }
  }
  if (/^\/armallowlist$/i.test(cmd)) {
    if (!pending) return send('Resolve a drop first.');
    const slug = pending.slug || slugFromUrl(pending.sourceUrl || '');
    if (!slug) return send('No OpenSea slug for this drop — send the collection link.');
    const stageIndex = Number(arg);
    if (!Number.isInteger(stageIndex)) return send('use: /armallowlist &lt;stageIndex&gt; (numbers come from /allowlist)');
    const rows = pending.eligibilityChecked || [];
    if (!rows.length) return send('Run /allowlist first so I know which wallets are eligible.');
    const eligibleNames = [];
    let startMs = null, chainIdentifier = null, nft = null, perWallet = 0, price = null;
    for (const r of rows) {
      if (!r.ok) continue;
      const st = r.stages.find((x) => x.index === stageIndex && x.eligible);
      if (st) { eligibleNames.push(r.name); startMs = st.startMs; chainIdentifier = r.chainIdentifier; nft = r.nft; perWallet = st.perWallet; price = st.price; }
    }
    if (!eligibleNames.length) return send(`No selected wallet is eligible for stage ${stageIndex}. /allowlist to check.`);
    if (perWallet && pending.quantity > perWallet) return send(`Stage ${stageIndex} allows ${perWallet} per wallet.`);
    const job = {
      id: Date.now(), name: `${pending.name} (presale ${stageIndex})`, contract: nft || pending.contract,
      chainKey: pending.chain.key, chainName: pending.chain.name, sym: pending.chain.sym,
      mode: 'allowlist', slug, stageIndex, chainIdentifier, startMs,
      quantity: pending.quantity || 1, walletNames: eligibleNames, state: 'armed',
    };
    drops.push(job); saveDrops(); pending = null;
    send(`✅ Armed <b>${esc(job.name)}</b> — authenticated presale\n${eligibleNames.length} eligible wallet(s)${price ? ` · ${price.unit} ${esc(price.symbol)} each` : ''}\nopens ${when(startMs)}\n\n<i>Presale mints fetch a signed transaction from OpenSea's private API when the stage opens — a little slower than public, and reliant on their API. I'll message you the result.</i>`);
    runArmedAllowlist(job);
    return;
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
      pending = { ...r, quantity: 1, walletSpec: settings.defaultWallets, sourceUrl: text.trim(), slug: slugFromUrl(text.trim()) };
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

    // funds + supply gate up front (our edge, kept). The gas reserve is the
    // real one now — gasLimit x the live maxFee — not a fixed guess, so on a
    // cheap chain a wallet holding a few cents of gas is not falsely rejected.
    const gas = await computeGas(p);
    const cost = cfg.priceWei * BigInt(job.quantity);
    const headroom = gas.reserve;
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
      gas,
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

// The authenticated presale path. Different from runArmed: it logs each eligible
// wallet into OpenSea, waits for the stage, fetches the SIGNED transaction, and
// only then signs and fires. Cannot pre-sign — the signature does not exist
// until OpenSea builds it at stage open.
async function runArmedAllowlist(job) {
  try {
    const { ch } = await anyProvider(job.chainKey);
    const signers = [];
    for (const name of job.walletNames) {
      const r = readKey(name);
      if (r.wallet) signers.push({ wallet: r.wallet, name });
    }
    if (!signers.length) { job.state = 'failed'; job.result = 'no usable wallet keys'; saveDrops(); return send(`⛔ <b>${esc(job.name)}</b>: no usable wallet keys`); }
    const res = await allowlistMint({
      signers, slug: job.slug, chainId: ch.id, chainIdentifier: job.chainIdentifier,
      nft: job.contract, quantity: job.quantity, stageIndex: job.stageIndex,
      urls: ch.rpcs, gas: await computeGas(await providerFor(ch)), startMs: job.startMs, leadMs: Math.min(settings.leadMs, 500),
      say: (m) => log(`[${job.name}]`, m),
    });
    job.state = res.ok ? 'minted' : 'failed';
    job.result = res.msg;
    saveDrops();
    if (res.ok) {
      const lines = res.runs.filter((r) => r.ok).map((r) => `· ${short(r.name)} — block ${r.block}, tx <code>${short(r.hash)}</code>`).join('\n');
      await send(`🎉 <b>MINTED ${esc(job.name)}</b>\n${esc(res.msg)}\n${lines}`);
    } else {
      const why = res.runs?.map((r) => `· ${short(r.name)}: ${esc(r.msg || r.kind)}`).join('\n') || esc(res.msg);
      await send(`❌ <b>${esc(job.name)}</b> — presale did not mint\n${why}`);
    }
  } catch (e) {
    job.state = 'failed'; job.result = String(e.message); saveDrops();
    await send(`⛔ <b>${esc(job.name)}</b> presale errored: ${esc(String(e.message).slice(0, 200))}`);
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
for (const d of drops.filter((x) => x.state === 'armed')) (d.mode === 'allowlist' ? runArmedAllowlist : runArmed)(d);
for (;;) { await poll().catch((e) => log('poll error', e?.message)); await new Promise((r) => setTimeout(r, 400)); }
