// Chains the minter can operate on. OpenSea's own identifier is the key,
// because that is what the collection page reports and therefore what the
// resolver reads. A chain with no RPC here is not an error the user should
// discover at mint time, so `chainFor` says so plainly instead.
export const CHAINS = {
  robinhood: { id: 4663, name: 'Robinhood Chain', sym: 'ETH', rpcs: ['https://sequencer.mainnet.chain.robinhood.com', 'https://rpc.mainnet.chain.robinhood.com', 'https://rpc.arrowrpc.com'] },
  ethereum:  { id: 1, name: 'Ethereum', sym: 'ETH', rpcs: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://ethereum-rpc.publicnode.com'] },
  base:      { id: 8453, name: 'Base', sym: 'ETH', rpcs: ['https://mainnet-sequencer.base.org', 'https://mainnet.base.org', 'https://base.llamarpc.com'] },
  arbitrum:  { id: 42161, name: 'Arbitrum', sym: 'ETH', rpcs: ['https://arb1.arbitrum.io/rpc'] },
  optimism:  { id: 10, name: 'Optimism', sym: 'ETH', rpcs: ['https://mainnet.optimism.io'] },
  matic:     { id: 137, name: 'Polygon', sym: 'POL', rpcs: ['https://polygon-rpc.com'] },
  zora:      { id: 7777777, name: 'Zora', sym: 'ETH', rpcs: ['https://rpc.zora.energy'] },
  blast:     { id: 81457, name: 'Blast', sym: 'ETH', rpcs: ['https://rpc.blast.io'] },
  ape_chain: { id: 33139, name: 'ApeChain', sym: 'APE', rpcs: ['https://apechain.calderachain.xyz/http'] },
  abstract:  { id: 2741, name: 'Abstract', sym: 'ETH', rpcs: ['https://api.mainnet.abs.xyz'] },
};

// Extra endpoints from the environment win, so a private/faster RPC can be
// dropped in without editing code: RPC_ROBINHOOD=https://…,https://…
export function chainFor(identifier) {
  const key = String(identifier || '').toLowerCase();
  const c = CHAINS[key];
  if (!c) return { ok: false, key, why: `chain "${identifier}" is not configured — add it to chains.mjs with an RPC` };
  const extra = (process.env[`RPC_${key.toUpperCase()}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { ok: true, key, ...c, rpcs: [...extra, ...c.rpcs] };
}
