// Move minted NFTs out of the hot wallets to a wallet you actually keep.
//
// The hard part is not the transfer — it is knowing WHICH token ids a wallet
// holds, because a mint does not tell you the id up front and not every
// contract supports enumeration. Two strategies, in order:
//
//   1. ERC721Enumerable: tokenOfOwnerByIndex(owner, i) — one clean call per
//      token when the contract supports it (most SeaDrop collections do).
//   2. Fallback: scan Transfer(_, owner, tokenId) logs to find every id that
//      ever arrived, then confirm current ownership with ownerOf. This works on
//      any ERC-721, at the cost of a log scan.
//
// Either way, ownership is CONFIRMED with ownerOf before a transfer is signed,
// so we never try to move a token the wallet no longer has.
import { Contract, JsonRpcProvider } from 'ethers';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + a.toLowerCase().replace('0x', '').padStart(64, '0');

const NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
];

// Which token ids does `owner` currently hold in this collection?
export async function ownedTokenIds(provider, contract, owner) {
  const c = new Contract(contract, NFT_ABI, provider);
  const bal = Number(await c.balanceOf(owner).catch(() => 0n));
  if (bal === 0) return [];

  // 1. enumerable fast path
  try {
    const ids = [];
    for (let i = 0; i < bal; i++) ids.push((await c.tokenOfOwnerByIndex(owner, i)).toString());
    if (ids.length) return ids;
  } catch {
    /* not enumerable — fall through to the log scan */
  }

  // 2. log-scan fallback: every token that was ever transferred TO this owner,
  //    then filtered by who owns it now.
  const head = await provider.getBlockNumber();
  const found = new Set();
  let chunk = 2_000_000;
  for (let from = 1; from <= head; ) {
    const to = Math.min(from + chunk - 1, head);
    try {
      const logs = await provider.getLogs({ address: contract, topics: [TRANSFER_TOPIC, null, pad(owner)], fromBlock: from, toBlock: to });
      for (const l of logs) {
        // ERC-721 Transfer indexes tokenId as topic[3]; ERC-20 does not have it
        if (l.topics.length === 4) found.add(BigInt(l.topics[3]).toString());
      }
      from = to + 1;
    } catch {
      if (chunk <= 50_000) { from = to + 1; continue; }
      chunk = Math.floor(chunk / 4);
    }
  }
  // confirm current ownership
  const owned = [];
  for (const id of found) {
    try { if ((await c.ownerOf(id)).toLowerCase() === owner.toLowerCase()) owned.push(id); }
    catch { /* burned or moved */ }
  }
  return owned;
}

// Transfer every NFT the given wallets hold in `contract` to `to`.
// Sequential per token so a failure leaves a clear record. Returns per-token
// results. `readKey` maps a wallet name to its signer.
export async function sendNfts({ names, contract, to, provider, chainId, gas, readKey, say }) {
  const results = [];
  for (const name of names) {
    const r = readKey(name);
    if (r.err) { results.push({ name, err: r.err }); continue; }
    const w = r.wallet.connect(provider);
    let ids;
    try { ids = await ownedTokenIds(provider, contract, w.address); }
    catch (e) { results.push({ name, err: 'could not read holdings: ' + String(e?.message || e).slice(0, 60) }); continue; }
    if (!ids.length) { results.push({ name, address: w.address, none: true }); continue; }
    say?.(`${name} holds ${ids.length} token(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}`);
    const c = new Contract(contract, NFT_ABI, w);
    let nonce = await provider.getTransactionCount(w.address, 'pending');
    for (const id of ids) {
      try {
        const tx = await c.safeTransferFrom(w.address, to, id, {
          nonce: nonce++, maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: 150000, type: 2, chainId,
        });
        await tx.wait(1);
        results.push({ name, address: w.address, tokenId: id, hash: tx.hash });
      } catch (e) {
        results.push({ name, tokenId: id, err: String(e?.shortMessage || e?.message || e).slice(0, 80) });
      }
    }
  }
  return results;
}
