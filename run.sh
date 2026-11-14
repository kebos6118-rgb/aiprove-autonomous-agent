#!/usr/bin/env bash
# Convenience wrapper: dry-run by default; pass --live to submit for real.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
exec node src/agent.js "$@"
