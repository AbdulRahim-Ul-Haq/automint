# automint

Paste an OpenSea collection link into Telegram. The bot works out the chain, the
contract and how it mints — reading it straight from the blockchain, not the
website — waits for the drop to open, and fires. One wallet or many, in parallel.

It runs **on your own device** — a laptop, a spare PC, a Raspberry Pi — and you
drive the whole thing from your phone. **Your private keys never leave that
device and never travel through Telegram.**

---

## Why this and not a browser extension or a paid bot

- **Reads the mint from on-chain data.** No OpenSea login, no API key, no rate
  limit to lose a mint to. Price, timing, fee recipient and per-wallet limit all
  come from the contract itself.
- **Pre-signs before the stage opens.** Every transaction is signed and
  serialised *during the wait*, so at the exact start time the only work left is
  writing bytes to the network. That's as fast as a mint bot gets.
- **Blasts to every RPC at once**, warms the connections first, and fires a
  chosen number of milliseconds early so the transaction is already in the
  mempool when the contract flips live.
- **Won't waste gas on a dead drop.** It checks supply before firing and, while
  waiting, watches for an earlier phase selling out — if it does, it tells you
  and sends *nothing*.
- **Runs headless.** No terminal window to keep open. Close your laptop; if it's
  on a Pi it just keeps going. Control it from Telegram.

---

## Setup (about 5 minutes)

You need [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/AbdulRahim-Ul-Haq/automint.git
cd automint

./setup.sh
```

Then:

1. **Make a Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, follow the prompts, copy the token.
2. **Find your chat id.** Message [@userinfobot](https://t.me/userinfobot); it
   replies with your numeric id.
3. Put both into `automint.env` (`TELEGRAM_TOKEN` and `OWNER_CHAT_ID`).
4. Start it:

   ```bash
   ./run.sh
   ```

   You'll get a "🟢 automint up" message. If you don't, re-check the token and id.

To keep it running after you close the terminal, use `pm2 start run.sh --name automint`, a `systemd` service (an example unit is in `automint.service`), or just leave the window open.

---

## Your first mint

In the Telegram chat:

```
/newwallet main
```

It generates a fresh wallet **on your device** and shows you its address. Send
that address some of the chain's native token — enough for the mint plus a little
gas. Then paste a collection link:

```
https://opensea.io/collection/some-drop
```

The bot replies with a card: chain, contract, price, when it opens, per-wallet
limit, current supply. If it looks right:

```
/arm
```

That's it. It waits and fires on its own, and messages you the result — the
transaction hash and block if it minted, or a plain reason if it didn't.

---

## Multiple wallets

Generate or add as many as you like; each is a file in `keys/`.

```
/newwallet w1
/newwallet w2
/newwallet w3
/mywallets                     ← lists them with balances
/fund main 0.05 w1,w2,w3       ← spread funds from one wallet to several
```

By default a drop uses every wallet. To pick a subset, after resolving a link:

```
/wallets w1,w2
```

All selected wallets pre-sign and fire in parallel when the stage opens. Each
one mints its own `/qty` (subject to the drop's per-wallet limit) into its own
address. Afterwards:

```
/sweep 0xYourColdWallet all    ← pull funds back out of the hot wallets
```

---

## Every command

**Drops**
| Command | Does |
|---|---|
| *(paste a link)* | Resolve a collection and show its card |
| `/arm` | Schedule the resolved drop |
| `/qty n` | How many per wallet |
| `/wallets all\|a,b` | Which wallets this drop uses |
| `/price 0.012` | Set price if the contract doesn't publish one |
| `/list` | Armed drops |
| `/cancel n` | Remove an armed drop |
| `/check` | Re-read supply for armed drops |

**Wallets** — keys stay on the machine, never in chat
| Command | Does |
|---|---|
| `/newwallet name` | Generate a wallet here |
| `/mywallets` | List with balances |
| `/fund funder amount a,b\|all` | Spread funds |
| `/sweep toAddress a,b\|all` | Pull funds back |
| `/removewallet name` | Delete a key file |

**Settings**
| Command | Does |
|---|---|
| `/set gas maxGwei tipGwei` | Fee ceiling and tip |
| `/set lead ms` | Fire this many ms early |
| `/set gaslimit n` | Gas limit per mint |
| `/settings` | Show all |
| `/status` | Overview |

---

## Keeping keys safe

- Keys live only in `keys/`, one file each, `chmod 600`. **Nothing ever sends a
  key over Telegram** — if you try to paste one into chat, it isn't accepted;
  you're told to create a file instead.
- Use **dedicated hot wallets** funded with only what a mint needs. Generate them
  with `/newwallet` and sweep the proceeds out afterwards.
- Back up `keys/` somewhere safe. Deleting a key file with `/removewallet`
  destroys it — an unswept balance is then unreachable.
- `MAX_SPEND_ETH` in `automint.env` caps what any single wallet can spend on a
  mint. **No chat command can raise it** — that lives on the device on purpose,
  so even someone who steals your bot token can't drain a wallet.
- Rotate your bot token if it's ever exposed: `/revoke` in BotFather, update
  `automint.env`, restart.

---

## Supported chains

Robinhood, Ethereum, Base, Arbitrum, Optimism, Polygon, Zora, Blast, ApeChain,
Abstract. A drop on any other chain is reported clearly rather than mis-fired.
Add one by appending an entry to `chains.mjs`.

## What it does not do

- **Allowlist / FCFS phases.** Those need a per-wallet signature from OpenSea's
  own servers, which can't be built from on-chain data. Only **public** phases
  are mintable here. (This is the same limit both tools this was modelled on
  hit — it's a property of how allowlists work, not a missing feature.)
- **Custom mint contracts** it doesn't recognise get "needs a hand-written
  adapter" rather than a wrong guess. SeaDrop and plain `mint()`/`publicMint()`
  work out of the box.

## Credit

The speed design — pre-signing during the wait, multi-RPC blasting, connection
warming — follows two open-source CLIs worth reading:
[morsyxbt/nft-public-mint](https://github.com/morsyxbt/nft-public-mint) and
[zunmax/osnm-z](https://github.com/zunmax/osnm-z). automint's own additions are
the Telegram control surface, the sold-out guard, and headless operation.

Experimental software. Blockchain transactions are irreversible. Use dedicated
wallets funded with only what you intend to spend.
