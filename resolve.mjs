// OpenSea link -> which chain, which contract, and how do you mint it.
//
// The scrape is deliberately loose and the verification is strict. OpenSea's
// HTML shape is theirs to change; what cannot change is that the collection's
// contract is an ERC-721 on the stated chain whose name matches the page. So:
// gather every address on the page, then ask the chain which one is real.
import { JsonRpcProvider, Contract, Interface, id as keccakId } from 'ethers';
import { chainFor } from './chains.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ERC721_IFACE = '0x80ac58cd';

export function slugFromUrl(url) {
  const m = String(url).match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

export async function provider(chain) {
  for (const url of chain.rpcs) {
    try {
      const p = new JsonRpcProvider(url, chain.id, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch {
      /* try the next endpoint */
    }
  }
  throw new Error(`no working RPC for ${chain.name}`);
}

// ── step 1: the page ───────────────────────────────────────────────────────
export async function scrapeCollection(slug) {
  const res = await fetch(`https://opensea.io/collection/${slug}`, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`OpenSea returned HTTP ${res.status} for "${slug}"`);
  const html = await res.text();

  // the chain is stated right next to the slug
  let chainId = null;
  const anchored = html.match(new RegExp(`"slug":"${slug}","contracts":\\[\\{"chain":\\{"identifier":"([a-z_]+)"`));
  if (anchored) chainId = anchored[1];
  if (!chainId) {
    const any = html.match(/"chain":\{"identifier":"([a-z_]+)"/);
    if (any) chainId = any[1];
  }

  // candidate contracts, most-mentioned first
  const counts = new Map();
  for (const m of html.matchAll(/"(?:contractAddress|address)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g)) {
    const a = m[1].toLowerCase();
    if (/^0x0{40}$/.test(a)) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a).slice(0, 15);

  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  return { chainId, candidates, title: title.replace(/\s*[-|]\s*(Collection\s*\|\s*)?OpenSea.*$/i, '').trim() };
}

// ── step 2: ask the chain which candidate is actually the collection ───────
export async function verifyContract(p, candidates, title) {
  const abi = [
    'function supportsInterface(bytes4) view returns (bool)',
    'function name() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function maxSupply() view returns (uint256)',
  ];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = [];
  for (const a of candidates) {
    try {
      const c = new Contract(a, abi, p);
      if (!(await c.supportsInterface(ERC721_IFACE).catch(() => false))) continue;
      const name = await c.name().catch(() => '');
      const total = await c.totalSupply().catch(() => null);
      const max = await c.maxSupply().catch(() => null);
      found.push({ address: a, name, total, max, match: Boolean(title && norm(name) && norm(title).includes(norm(name))) });
    } catch {
      /* not this one */
    }
  }
  if (!found.length) throw new Error('no ERC-721 among the addresses on that page — send "<contract> <chain>" instead');
  // a name that matches the page title is decisive; otherwise the most-cited
  return found.find((f) => f.match) || found[0];
}

// ── step 3: how is it minted ───────────────────────────────────────────────
// Fingerprint by selector, following an EIP-1167 clone to its implementation
// first, because a 45-byte proxy tells you nothing.
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
];

export async function implementationOf(p, addr) {
  const code = await p.getCode(addr);
  const m = code.match(/363d3d373d3d3d363d73([a-fA-F0-9]{40})5af43d82803e903d91602b57fd5bf3/);
  if (m) return { code: await p.getCode('0x' + m[1]), impl: '0x' + m[1] };
  // EIP-1967 implementation slot
  const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const raw = await p.getStorage(addr, slot).catch(() => null);
  if (raw && /[1-9a-fA-F]/.test(raw.slice(26))) {
    const impl = '0x' + raw.slice(26);
    return { code: await p.getCode(impl), impl };
  }
  return { code, impl: null };
}

const has = (code, sig) => code.includes(keccakId(sig).slice(2, 10));

export const ADAPTERS = [
  {
    name: 'opensea-seadrop',
    label: 'OpenSea SeaDrop',
    // The NFT exposes mintSeaDrop(), which only the SeaDrop contract may call,
    // so buyers go through SeaDrop rather than the NFT itself.
    detect: (code) => has(code, 'mintSeaDrop(address,uint256)'),
    async config(p, nft) {
      const sd = new Contract(SEADROP, SEADROP_ABI, p);
      const d = await sd.getPublicDrop(nft);
      const fees = await sd.getAllowedFeeRecipients(nft);
      if (d.restrictFeeRecipients && !fees.length) throw new Error('SeaDrop has no allowed fee recipient — not mintable');
      if (!Number(d.startTime)) throw new Error('no public phase is configured for this collection yet');
      return {
        priceWei: d.mintPrice,
        startMs: Number(d.startTime) * 1000,
        endMs: Number(d.endTime) * 1000,
        perWallet: Number(d.maxTotalMintableByWallet),
        target: SEADROP,
        feeRecipient: fees[0] || '0x' + '0'.repeat(40),
      };
    },
    tx(nft, cfg, qty) {
      const i = new Interface(SEADROP_ABI);
      return {
        to: SEADROP,
        data: i.encodeFunctionData('mintPublic', [nft, cfg.feeRecipient, '0x' + '0'.repeat(40), qty]),
        value: cfg.priceWei * BigInt(qty),
      };
    },
  },
  {
    // The plain case: a public mint function on the NFT itself. Neither price
    // nor timing is standardised here, so whatever cannot be read is asked for.
    name: 'simple-mint',
    label: 'direct mint() on the contract',
    detect: (code) => has(code, 'mint(uint256)') || has(code, 'publicMint(uint256)'),
    async config(p, nft) {
      const abi = [
        'function mintPrice() view returns (uint256)',
        'function price() view returns (uint256)',
        'function cost() view returns (uint256)',
        'function maxPerWallet() view returns (uint256)',
      ];
      const c = new Contract(nft, abi, p);
      let priceWei = null;
      for (const fn of ['mintPrice', 'price', 'cost']) {
        try {
          priceWei = await c[fn]();
          break;
        } catch {
          /* not this one */
        }
      }
      let perWallet = 0;
      try {
        perWallet = Number(await c.maxPerWallet());
      } catch {
        /* unlimited or not exposed */
      }
      const code = await p.getCode(nft);
      const fnName = has(code, 'mint(uint256)') ? 'mint' : 'publicMint';
      return { priceWei, startMs: null, endMs: null, perWallet, target: nft, fnName, needsManualPrice: priceWei === null };
    },
    tx(nft, cfg, qty) {
      const i = new Interface([`function ${cfg.fnName}(uint256) payable`]);
      return { to: nft, data: i.encodeFunctionData(cfg.fnName, [qty]), value: (cfg.priceWei ?? 0n) * BigInt(qty) };
    },
  },
];

export async function detectAdapter(p, nft) {
  const { code, impl } = await implementationOf(p, nft);
  for (const a of ADAPTERS) if (a.detect(code)) return { adapter: a, impl };
  throw new Error('unrecognised mint mechanism — this one needs a hand-written adapter');
}

// ── the whole pipeline ─────────────────────────────────────────────────────
export async function resolve(input) {
  let chainKey = null;
  let contract = null;
  let title = '';
  let candidates = [];
  const direct = String(input).trim().match(/^(0x[a-fA-F0-9]{40})\s+([a-z_]+)$/i);
  if (direct) {
    contract = direct[1].toLowerCase();
    chainKey = direct[2].toLowerCase();
    candidates = [contract];
  } else {
    const slug = slugFromUrl(input);
    if (!slug) throw new Error('that is not an OpenSea collection link. Send the link, or "<contract> <chain>".');
    const s = await scrapeCollection(slug);
    if (!s.chainId) throw new Error('could not tell which chain that collection is on');
    chainKey = s.chainId;
    title = s.title;
    candidates = s.candidates;
  }
  const chain = chainFor(chainKey);
  if (!chain.ok) throw new Error(chain.why);
  const p = await provider(chain);
  const info = await verifyContract(p, candidates, title);
  const { adapter, impl } = await detectAdapter(p, info.address);
  const cfg = await adapter.config(p, info.address);
  return { chain, p, contract: info.address, name: info.name, total: info.total, max: info.max, adapter, impl, cfg };
}
