#!/usr/bin/env bash
# One-shot local setup for automint. Run it inside the automint folder.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

command -v node >/dev/null || { echo "Node.js 18+ required — get it from https://nodejs.org"; exit 1; }
ver=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$ver" -ge 18 ] || { echo "Node 18+ required, you have $(node -v)"; exit 1; }

echo "Installing dependencies…"
npm install --no-audit --no-fund

[ -f automint.env ] || { cp automint.env.example automint.env; echo "Created automint.env — edit it: add TELEGRAM_TOKEN and OWNER_CHAT_ID"; }
mkdir -p keys && chmod 700 keys

echo
echo "Next:"
echo "  1. Create a Telegram bot with @BotFather, put its token in automint.env"
echo "  2. Message @userinfobot, put your numeric id in automint.env as OWNER_CHAT_ID"
echo "  3. Start it:   node automint.mjs   (or: ./run.sh)"
echo "  4. In Telegram, send /newwallet main — it prints an address to fund."
echo
echo "Your keys never leave this folder. Back up keys/ somewhere safe."
