#!/usr/bin/env bash
# Reproducible production deploy. The committed wrangler.jsonc keeps MOCK="1" so that a plain
# `npm run dev` and the smoke test run offline without a key. This script bakes MOCK="0" into the
# build so the deployed Worker uses real Crusoe inference, then restores the source.
#
# The CRUSOE_API_KEY secret must be set once on the Worker:
#   npx wrangler secret put CRUSOE_API_KEY
set -euo pipefail

perl -i -pe 's/"MOCK": "1"/"MOCK": "0"/' wrangler.jsonc
npm run build
git checkout -- wrangler.jsonc

grep -q '"MOCK":"0"' dist/marshal/wrangler.json || {
  echo "error: build did not bake MOCK=0 into dist/marshal/wrangler.json" >&2
  exit 1
}

npx wrangler deploy -c dist/marshal/wrangler.json
echo "Deployed with real inference (MOCK=0). If this is a fresh Worker, set the secret:"
echo "  npx wrangler secret put CRUSOE_API_KEY"
