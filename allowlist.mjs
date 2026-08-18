// The allowlist / presale runner.
//
// This path cannot use the pre-sign trick the public path relies on: an
// allowlist mint's calldata carries a per-wallet signature that only exists
// once OpenSea builds it, at or after the stage opens. So the hot path here is
// unavoidably: log in → wait for the stage → fetch the signed transaction →
// check it isn't lying to us → sign and blast. That is a hair slower than the
// public path, and it does not matter: an allowlist spot is reserved for an
// eligible wallet, so this is "claim my guaranteed place", not a race against a
// thousand strangers.
//
// The safety rule that governs the whole thing: OpenSea hands back opaque bytes,
// and we never sign them until they have been decoded and confirmed to be a
// SeaDrop mint, for our quantity, crediting our wallet.
import { JsonRpcProvider, Wallet } from 'ethers';
import { login, stages, fetchMintTx, validateMintTx } from './opensea-auth.mjs';
import { warm, blast, wasAccepted, waitReceipt, verifyChain, waitUntil } from './fire.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Check every selected wallet's eligibility for a collection, one login each.
// Returns per-wallet stage eligibility so the user can see exactly who can mint
// what before committing.
export async function checkEligibility({ signers, slug, chainId, say }) {
  const out = [];
  for (const s of signers) {
    try {
      const session = await login(s.wallet, slug, chainId);
      const info = await stages(session);
      out.push({ name: s.name, address: s.wallet.address, ok: true, nft: info.nft, chainIdentifier: info.chainIdentifier, stages: info.stages });
    } catch (e) {
      out.push({ name: s.name, address: s.wallet.address, ok: false, err: String(e.message).slice(0, 120) });
    }
    await sleep(300); // be gentle with the private API
  }
  return out;
}

// Run one authenticated mint for one wallet at one stage. Separate per wallet
// because each has its own session and its own signature.
async function mintOne({ wallet, slug, chainId, chainIdentifier, nft, quantity, stageIndex, urls, gas, startMs, leadMs, say }) {
  const session = await login(wallet, slug, chainId);

  // wait for the stage (OpenSea only builds the signature once it is live)
  if (startMs && Date.now() < startMs) {
    await waitUntil(startMs, leadMs, (left) => say?.(`${wallet.address.slice(0, 8)}… waiting ${Math.round(left / 60000)} min for the presale`));
  }

  // poll for the signed transaction — it can take a moment to become available
  const provider = new JsonRpcProvider(urls[0], chainId, { staticNetwork: true });
  const w = wallet.connect(provider);
  const nonce = await provider.getTransactionCount(w.address, 'pending');
  let built = null;
  const deadline = Date.now() + 60_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      built = await fetchMintTx(session, { nftContract: nft, chainIdentifier, quantity, tokenId: '0' });
      break;
    } catch (e) {
      lastErr = String(e.message);
      if (/not eligible/i.test(lastErr)) return { name: wallet.address, ok: false, kind: 'not-eligible', msg: 'wallet is not eligible for this stage' };
      await sleep(400); // signature not ready yet — keep asking
    }
  }
  if (!built) return { name: wallet.address, ok: false, kind: 'no-action', msg: `OpenSea never returned a mint tx: ${lastErr.slice(0, 100)}` };

  // NEVER blind-sign — decode and confirm before the key touches it
  validateMintTx(built, { quantity, walletAddress: w.address });

  await warm(urls);
  const raw = await w.signTransaction({
    to: built.to, data: built.data, value: built.value, nonce,
    maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.priority, gasLimit: gas.limit, type: 2, chainId,
  });
  const { hash, settled } = blast(raw, urls);
  const results = await settled;
  if (!wasAccepted(results)) {
    const reasons = [...new Set(results.map((r) => r.err).filter(Boolean))];
    return { name: wallet.address, ok: false, kind: 'rejected', msg: 'rejected by every endpoint', reasons };
  }
  const rc = await waitReceipt(hash, urls[0], 90_000);
  return { name: wallet.address, ok: rc?.status === 1, kind: rc?.status === 1 ? 'minted' : 'accepted-no-confirm', hash, block: rc?.block ?? null };
}

// Run the authenticated mint across every eligible wallet, in parallel.
export async function allowlistMint({ signers, slug, chainId, chainIdentifier, nft, quantity, stageIndex, urls, gas, startMs, leadMs = 500, say }) {
  urls = await verifyChain(urls, chainId);
  if (!urls.length) return { ok: false, msg: 'no endpoint is on the right chain' };
  const runs = await Promise.all(
    signers.map((s) =>
      mintOne({ wallet: s.wallet, slug, chainId, chainIdentifier, nft, quantity, stageIndex, urls, gas, startMs, leadMs, say })
        .catch((e) => ({ name: s.wallet.address, ok: false, kind: 'error', msg: String(e.message).slice(0, 140) })),
    ),
  );
  const wins = runs.filter((r) => r.ok);
  return { ok: wins.length > 0, runs, msg: wins.length ? `${wins.length}/${runs.length} wallet(s) minted` : 'no wallet minted on the allowlist' };
}
