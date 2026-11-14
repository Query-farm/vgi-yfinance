#!/usr/bin/env bash
# Run the SQLLogic (haybarn) suite in test/sql/ against the TypeScript worker, using the
# haybarn DuckDB distribution's unittest runner (which loads the `vgi` extension from the
# community repository).
#
# Prerequisites (one-time):
#   uv                                                   # runs the matched CLI/test runner below
#   bun install                                           # the worker's deps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Keep the CLI and test runner on the same DuckDB ABI and extension directory.
# Older globally installed runners can load a stale protocol-2.x extension.
HAYBARN_VERSION="${HAYBARN_VERSION:-2.0.0rc11}"
CLI=(uvx --prerelease=allow --from "haybarn-cli==$HAYBARN_VERSION" haybarn-cli)
# --keep-home: Haybarn 2.0 isolates $HOME per run, hiding the installed extensions.
UNITTEST=(uvx --prerelease=allow --from "haybarn-unittest==$HAYBARN_VERSION" haybarn-unittest --keep-home)
if [[ -n "${VGI_UNITTEST:-}" ]]; then
    UNITTEST=("$VGI_UNITTEST" --keep-home)
fi

# Ensure the vgi community extension is installed for this haybarn version.
echo "==> Refreshing vgi extension from community repository"
echo "FORCE INSTALL vgi FROM community;" | "${CLI[@]}"
# httpfs carries the HTTP transport (VGI_TEST_WORKER = a URL); the .test files `LOAD` it.
if ! echo "LOAD httpfs;" | "${CLI[@]}" >/dev/null 2>&1; then
    echo "==> Installing httpfs extension"
    echo "INSTALL httpfs;" | "${CLI[@]}"
fi

# NOTE: the last arg is a Catch2 test-name filter, not a shell glob. Catch2 only honors a
# trailing `*` wildcard, so use `test/sql/*` (not `test/sql/*.test`).
# VGI_TEST_WORKER overrides the ATTACH LOCATION — e.g. `wrangler dev`'s http://localhost:8787
# or the deployed Cloudflare Worker URL — to run the same suite over HTTP.
WORKER="${VGI_TEST_WORKER:-$REPO_ROOT/bin/vgi-yfinance-worker}"
TEST_GLOB="${1:-test/sql/*}"

echo "==> Running SQLLogic tests"
echo "    worker:   $WORKER"
echo "    unittest: ${UNITTEST[*]}"
echo "    tests:    $TEST_GLOB"

VGI_TEST_WORKER="$WORKER" \
VGI_WORKER_CATALOG_NAME="yfinance" \
    "${UNITTEST[@]}" --test-dir "$REPO_ROOT" "$TEST_GLOB"
