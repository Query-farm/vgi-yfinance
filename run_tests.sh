#!/usr/bin/env bash
# Run the SQLLogic (haybarn) suite in test/sql/ against the TypeScript worker, using the
# haybarn DuckDB distribution's unittest runner (which loads the `vgi` extension from the
# community repository).
#
# Prerequisites (one-time):
#   uv tool install haybarn-unittest                      # the DuckDB unittest binary
#   echo "INSTALL vgi FROM community;" | uvx haybarn-cli  # install the vgi extension
#   echo "INSTALL httpfs;" | uvx haybarn-cli               # HTTP transport (auto-installed below)
#   bun install                                           # the worker's deps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

UNITTEST="${VGI_UNITTEST:-$(command -v haybarn-unittest || true)}"
if [[ -z "$UNITTEST" || ! -x "$UNITTEST" ]]; then
    echo "ERROR: haybarn-unittest not found. Install it with:" >&2
    echo "       uv tool install haybarn-unittest" >&2
    exit 1
fi

# Ensure the vgi community extension is installed for this haybarn version.
if ! echo "LOAD vgi;" | uvx haybarn-cli >/dev/null 2>&1; then
    echo "==> Installing vgi extension from community repository"
    echo "INSTALL vgi FROM community;" | uvx haybarn-cli
fi
# httpfs carries the HTTP transport (VGI_TEST_WORKER = a URL); the .test files `LOAD` it.
if ! echo "LOAD httpfs;" | uvx haybarn-cli >/dev/null 2>&1; then
    echo "==> Installing httpfs extension"
    echo "INSTALL httpfs;" | uvx haybarn-cli
fi

# NOTE: the last arg is a Catch2 test-name filter, not a shell glob. Catch2 only honors a
# trailing `*` wildcard, so use `test/sql/*` (not `test/sql/*.test`).
# VGI_TEST_WORKER overrides the ATTACH LOCATION — e.g. `wrangler dev`'s http://localhost:8787
# or the deployed Cloudflare Worker URL — to run the same suite over HTTP.
WORKER="${VGI_TEST_WORKER:-$REPO_ROOT/bin/vgi-yfinance-worker}"
TEST_GLOB="${1:-test/sql/*}"

echo "==> Running SQLLogic tests"
echo "    worker:   $WORKER"
echo "    unittest: $UNITTEST"
echo "    tests:    $TEST_GLOB"

VGI_TEST_WORKER="$WORKER" \
VGI_WORKER_CATALOG_NAME="yfinance" \
    "$UNITTEST" --test-dir "$REPO_ROOT" "$TEST_GLOB"
