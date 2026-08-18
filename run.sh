#!/usr/bin/env bash
# Load automint.env and run. Keeps running; restart it if it stops.
set -a; . "$(dirname "$0")/automint.env"; set +a
exec node "$(dirname "$0")/automint.mjs"
