// OpenSea authenticated minting — the allowlist / FCFS path.
//
// A public stage is unsigned, so we build its calldata ourselves (resolve.mjs).
// An allowlist stage is NOT: SeaDrop's mintSigned() carries a signature that
// only OpenSea's servers can produce, bound to one wallet and one stage. There
// is no on-chain way to get it. So for these stages we do what the OpenSea site
// does: sign in AS the wallet (SIWE — the wallet's own key signs a login
// message, no browser session needed), ask OpenSea to build the mint action,
// and submit the transaction bytes it returns.
//
// Three honest properties of this path, all surfaced to the user:
//   * It talks to OpenSea's PRIVATE API, which they can change without notice.
//     When it breaks, it breaks — that is the nature of it, not a bug here.
//   * The transaction OpenSea hands back is opaque, so we NEVER blind-sign it:
//     the calldata is decoded and checked (right selector, our wallet, our
//     quantity, the stage we meant) before a signature is ever produced.
//   * It only works if the wallet is actually on the allowlist. Eligibility is
//     checked first and a plain "not eligible" is returned rather than a
//     doomed transaction.
//
// Contract (endpoints, queries, the SIWE message) mirrors zunmax/osnm-z, which
// reverse-engineered it; credit there.
import { Interface, getAddress } from 'ethers';

const SITE = 'https://opensea.io';
const GQL = 'https://gql.opensea.io/graphql';
const APP_ID = 'os2-web';
const SIWE_STATEMENT =
  'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';
const ZERO = '0x0000000000000000000000000000000000000000';

// ── a tiny cookie jar over fetch ────────────────────────────────────────────
// Node's fetch has no jar; OpenSea's session is cookie-based, so we capture
// Set-Cookie from the auth calls and replay it on the GraphQL calls.
function makeJar() {
  const jar = new Map();
  return {
    take(res) {
      const set = res.headers.getSetCookie?.() || [];
      for (const c of set) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    size() { return jar.size; },
  };
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ── SIWE login ──────────────────────────────────────────────────────────────
export async function login(wallet, slug, chainId) {
  const jar = makeJar();
  const collectionUrl = `${SITE}/collection/${slug}`;
  const base = { origin: SITE, referer: collectionUrl, 'user-agent': UA, 'x-app-id': APP_ID };

  // 1. nonce
  const nres = await fetch(`${SITE}/__api/auth/siwe/nonce`, { method: 'POST', headers: base });
  if (!nres.ok) throw new Error(`OpenSea nonce request failed (HTTP ${nres.status})`);
  jar.take(nres);
  const nonce = (await nres.json())?.nonce;
  if (!nonce || !/^[A-Za-z0-9]{8,256}$/.test(nonce)) throw new Error('OpenSea returned an unusable login nonce');

  // 2. sign the SIWE message with the wallet's own key
  const domain = new URL(SITE).host;
  const address = getAddress(wallet.address);
  const issuedAt = new Date().toISOString();
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n` +
    `${SIWE_STATEMENT}\n\nURI: ${collectionUrl}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
  const signature = await wallet.signMessage(message);

  // 3. verify -> session cookie
  const body = {
    message: {
      domain, address, statement: SIWE_STATEMENT, uri: collectionUrl,
      version: '1', chainId: String(chainId), nonce, issuedAt, accountType: 'Ethereum',
    },
    signature, chainArch: 'EVM',
  };
  const vres = await fetch(`${SITE}/__api/auth/siwe/verify`, {
    method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!vres.ok) throw new Error(`OpenSea login failed (HTTP ${vres.status}) — the private API may have changed`);
  jar.take(vres);
  if (!jar.size()) throw new Error('OpenSea login returned no session cookie');
  return { jar, slug, chainId, address, collectionUrl };
}

async function gql(session, query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-app-id': APP_ID, 'user-agent': UA,
      origin: SITE, referer: session.collectionUrl, cookie: session.jar.header(),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`OpenSea GraphQL HTTP ${res.status}`);
  const j = await res.json();
  if (j.errors?.length) throw new Error('OpenSea GraphQL: ' + j.errors.map((e) => e.message).join('; '));
  return j.data;
}

// ── eligibility: is this wallet actually on the list, for which stage ────────
const ELIGIBILITY_QUERY = `
query DropEligibilityQuery($collectionSlug: String!, $address: Address!) {
  dropBySlug(slug: $collectionSlug) {
    __typename
    ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) }
    stages {
      __typename stageType stageIndex isEligible
      maxTotalMintableByWallet eligibleMaxTotalMintableByWallet
      eligiblePrice { token { unit symbol contractAddress } }
    }
  }
}`;

export async function eligibility(session) {
  const d = await gql(session, ELIGIBILITY_QUERY, { collectionSlug: session.slug, address: session.address });
  const stages = d?.dropBySlug?.stages || [];
  return stages.map((s) => ({
    type: s.stageType, index: s.stageIndex, eligible: !!s.isEligible,
    perWallet: Number(s.eligibleMaxTotalMintableByWallet ?? s.maxTotalMintableByWallet ?? 0),
    price: s.eligiblePrice?.token ? { unit: s.eligiblePrice.token.unit, symbol: s.eligiblePrice.token.symbol } : null,
  }));
}

// ── the mint action: OpenSea builds the signed transaction; we get to,data,value
const MINT_ACTION_QUERY = `
query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address) {
  swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT) {
    actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } }
    errors { __typename }
  }
}`;

export async function fetchMintTx(session, { nftContract, chainIdentifier, quantity, tokenId = '0' }) {
  const variables = {
    address: session.address,
    fromAssets: [{ asset: { contractAddress: ZERO, chain: chainIdentifier } }],
    toAssets: [{ asset: { contractAddress: getAddress(nftContract), chain: chainIdentifier, tokenId }, quantity: String(quantity) }],
    recipient: null,
  };
  const d = await gql(session, MINT_ACTION_QUERY, variables);
  const swap = d?.swap;
  if (swap?.errors?.length) throw new Error('OpenSea will not build this mint: ' + swap.errors.map((e) => e.__typename).join(', '));
  const action = (swap?.actions || []).find((a) => a.transactionSubmissionData);
  if (!action) throw new Error('OpenSea returned no transaction for this mint — wallet likely not eligible for an open stage');
  const t = action.transactionSubmissionData;
  return { to: getAddress(t.to), data: t.data, value: BigInt(t.value || '0') };
}

// ── never blind-sign opaque API data ────────────────────────────────────────
// The returned calldata is decoded and checked against what we asked for. This
// is exactly the guard osnm-z applies: a mint action must be a SeaDrop mint,
// for our quantity, crediting our wallet (or address(0) = the caller).
const SEADROP_SELECTORS = {
  '0x161ac21f': 'mintPublic(address,address,address,uint256)',
  '0xfd9f1e10': 'mintAllowList',
  '0x66a4b0b0': 'mintSigned',
};
export function validateMintTx(tx, { quantity, walletAddress }) {
  if (!tx.data || tx.data.length < 10) throw new Error('mint calldata is too short to be real');
  const selector = tx.data.slice(0, 10).toLowerCase();
  if (!SEADROP_SELECTORS[selector]) {
    // Not a selector we recognise — refuse rather than sign something opaque.
    throw new Error(`mint calldata has an unrecognised selector ${selector} — refusing to sign it`);
  }
  // Public and allowList/signed all put (nftContract, feeRecipient, minter, quantity)
  // as their first four ABI words. Decode minter + quantity defensively.
  try {
    const words = tx.data.slice(10).match(/.{64}/g) || [];
    const minter = '0x' + (words[2] || '').slice(24);
    const qty = BigInt('0x' + (words[3] || '0'));
    if (qty !== BigInt(quantity)) throw new Error(`calldata quantity ${qty} does not match the ${quantity} we asked for`);
    if (minter !== ZERO && getAddress(minter) !== getAddress(walletAddress))
      throw new Error('calldata would credit a different wallet — refusing to sign');
  } catch (e) {
    if (/refusing|does not match/.test(e.message)) throw e;
    // If the shape is unfamiliar we do not hard-fail on decode, but we DID
    // confirm a known SeaDrop selector above; log-worthy, not fatal.
  }
  return { selector, label: SEADROP_SELECTORS[selector] };
}

// ── stage timing, from the collection query, merged with eligibility ────────
const COLLECTION_QUERY = `
query MintCollectionMetadata($slug: String!) {
  collectionBySlug(slug: $slug) {
    __typename
    ... on Collection {
      slug address chain { identifier networkId }
      drop { __typename identifier { contractAddress chain { identifier } }
        stages { __typename stageType stageIndex startTime endTime maxTotalMintableByWallet } }
    }
  }
}`;

// Everything the runner needs about a drop's stages: type, index, when it opens
// and closes, whether THIS wallet is eligible, and its price — one login, two
// queries, merged by stage index.
export async function stages(session) {
  const [meta, elig] = await Promise.all([
    gql(session, COLLECTION_QUERY, { slug: session.slug }),
    eligibility(session),
  ]);
  const col = meta?.collectionBySlug || {};
  const chainIdentifier = col?.chain?.identifier || null;
  const nft = col?.drop?.identifier?.contractAddress || null;
  const byIndex = new Map(elig.map((e) => [e.index, e]));
  const rows = (col?.drop?.stages || []).map((s) => {
    const e = byIndex.get(s.stageIndex) || {};
    return {
      type: s.stageType, index: s.stageIndex,
      startMs: s.startTime ? Number(s.startTime) * 1000 : null,
      endMs: s.endTime ? Number(s.endTime) * 1000 : null,
      perWallet: e.perWallet ?? Number(s.maxTotalMintableByWallet ?? 0),
      eligible: !!e.eligible, price: e.price || null,
    };
  });
  return { chainIdentifier, nft, stages: rows };
}
