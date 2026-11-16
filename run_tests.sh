#!/usr/bin/env bash
# The SQLLogic suite now runs through the starter-standard ci/run-integration.sh over
# every transport (stdio, launch, http): with no VGI_TEST_WORKER this is
# `make test-sql-all` (one transport: `make test-sql TRANSPORT=launch`).
#
# VGI_TEST_WORKER=<url> ./run_tests.sh still runs the same suite against an already
# running worker, e.g. `wrangler dev` (http://localhost:8787) or the deployed
# Cloudflare Worker, using the pinned runner from `make tools`.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${VGI_TEST_WORKER:-}" ]]; then
    exec make -C "$REPO_ROOT" test-sql-all
fi
make -C "$REPO_ROOT" --no-print-directory tools
cd "$REPO_ROOT"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
printf 'statement ok\nFORCE INSTALL vgi FROM community;\n\nstatement ok\nINSTALL httpfs FROM core;\n' > "$STAGE/warm.test"
.tools/bin/haybarn-unittest --keep-home --test-dir "$STAGE" "warm.test" >/dev/null
# require vgi is not linked into the runner; the .test files LOAD httpfs, and ATTACH autoloads vgi.
.tools/bin/haybarn-unittest --keep-home --test-dir "$REPO_ROOT" "${1:-test/sql/*}"
