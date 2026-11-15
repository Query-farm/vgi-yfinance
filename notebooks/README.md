# Yahoo Finance notebooks

Two independent SQL stories use actual public Yahoo Finance responses through the
native **v0.6.0** release. They do not submit trades, use credentials, or substitute
recorded/fabricated data when a service fails.

| Notebook | Question | Local experiment |
| --- | --- | --- |
| [Align adjusted price paths](01_align_adjusted_price_paths.ipynb) | How do shared observation dates and the chosen starting point affect rebased prices and in-window drawdowns? | `DISPLAY_START`: 2024-01-01 → 2024-02-01 |
| [Search candidates and quote provenance](02_search_candidates_and_quote_provenance.ipynb) | Which identities and fields survive from a bounded name search to snapshots with their own timestamps? | `CANDIDATE_LIMIT`: 3 → 7 |

The first preserves the original AAPL/MSFT/SPY analysis for the fixed half-open
period **[2024-01-01, 2024-04-01)**, with daily regular-session bars materialized
once, no interpolation and no forward fill. Vendor-adjusted close is not a
simulated investment account; fees, taxes and reinvestment transactions are not
modeled. The release falls back from absent upstream adjusted-close cells to close and has no per-cell origin flag; returned adjustment factors are descriptive, not independently certified. Missing dates are not automatically exchange holidays.

The second asks `search('apple', count:=8)` once, joins its entire returned roster
to the eight-row illustrative `symbol_reference` view, and obtains one quote per
distinct candidate. A local rank limit changes the display after retrieval; it
**does not** reduce requests. Search scores are relevance values, not probabilities
or investment quality. Registry membership is a symbol-format example, not an
approved investment universe. Different quote currencies/types are displayed and
never summed or ranked by raw price.

## Run locally or in Colab

Use either notebook's Colab link and Run all. Its brief setup installs the base
shared package and fetches the immutable, SHA-256-verified presentation helper.
A notebook-only directory works; no local worker checkout or Bun installation is
required. For local publication, use the locked runner extra:

```sh
cd notebooks
uv sync --locked
uv run --locked vgi-notebooks
uv run --locked python -m ipykernel install --user --name vgi-yfinance-notebooks --display-name 'VGI Yahoo Finance notebooks'
```

Choose that kernel in a local editor. The shared environment supports Python
3.11–3.14; a fresh Python 3.12 kernel with eight existing data/plotting/Jupyter
libraries loaded validates bootstrap compatibility. Hosted Colab UI execution is
not claimed. Dependencies, companions and release downloads need network access;
each analytical run also needs the live Yahoo endpoints.

The visible connection is literal and release-pinned:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'yfinance' AS yf (
 TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-yfinance@v0.6.0'
);
```

Shared connection creation fixes UTC and isolates persisted SQL secrets in an
empty temporary directory before ATTACH. This worker has no auth requirement.
The native binary checksum is verified; no source build or local binary fallback
is used. Native cold download was tested anonymously on macOS ARM64. Other native
assets and hosted Colab were not manually operated.

## Save parameter experiments separately

```sh
uv run --locked vgi-notebooks 01_align_adjusted_price_paths.ipynb \
  --parameters '{"DISPLAY_START":"2024-02-01"}' --output-dir validation/february
uv run --locked vgi-notebooks 02_search_candidates_and_quote_provenance.ipynb \
  --parameters '{"CANDIDATE_LIMIT":7}' --output-dir validation/seven-candidates
```

The historical request window stays fixed. The first common observation, rebasing
and backward-looking peak reset after local selection. Each run retrieves live
prices again: compare raw values/fingerprints, and use the validation comparison
on fixed default prices to separate window effects from vendor revisions.

In final validation, 127 of 183 adjusted closes changed slightly between live runs: maximum absolute difference 0.0001221 and relative difference 2.542e-7 (about 0.0000254%). All other source columns matched exactly. February’s curves agreed with recomputation on the default prices within 0.000042 index/percentage points. Those are measured run differences, not guaranteed precision bounds. The common-date cohort changed from 61 dates beginning January 2 to 40 beginning February 1.

The second run retains the full bounded search and quote population, then expands
only the displayed ranks. Search can return fewer than eight candidates. Its
request budget is one search plus at most eight logical quotes, derived from the
reviewed implementation; no network interception/request audit is claimed. A
snapshot age is elapsed calendar time from the vendor's regular-market timestamp
to retrieval end, not a market-open test, exchange-session count or freshness guarantee.

In final snapshot validation, all seven candidate identities, relevance scores, quote values, vendor times and availability flags matched across the two runs. Calendar ages advanced by 55 seconds with the retrieval clock while the local display grew from three to seven rows.

The released quote function catches per-symbol failures and may omit those rows;
the notebook left-joins from the requested roster and labels them unavailable.
It cannot diagnose whether an omission means an unknown symbol, service failure,
rate limit or missing metadata. Search/history HTTP errors stop execution. No
missing value is filled with zero. Nonempty useful data and identity/accounting
checks are required in each run.

## Catalog, source differences and validation

The [coverage manifest](coverage.json) links complete actual catalog evidence,
visible SQL, saved outputs and interpretation. The release has **four logical
surfaces**: `history`, `search`, `quote`, and the `symbol_reference` view. All four
have meaningful executed coverage; the inventory includes all public functions,
views, tables and COPY formats (no ordinary tables or COPY formats are present).

The release tag peels to `b6a1efed55aff238f0f645f2339b50a1903184b4`.
Current source `d49e9e0c876ce7a28bf7053464cea3f7b743da42` has the same public
signatures and view definition, but includes newer strict history-date validation,
a latest-candle missing-close fill, and a corrected search-count clamp for zero or
negative values. Its Wrangler development dependency also changed. These examples
use valid historical date bounds, past candles and `count:=8`, so the reviewed
changes do not alter these selected operations. We do not claim universal runtime
equivalence: coverage is **4/4 exact release**, **4/4 current compatible interface**,
and **0 exact current-source executions**. No worker was rebuilt.

The unchanged worker reuses [green source CI](https://github.com/Query-farm/vgi-yfinance/actions/runs/43587723456).
The separate existing [image-publish failure](https://github.com/Query-farm/vgi-yfinance/actions/runs/43587723462)
failed its nested live SQLLogic job while the ordinary source CI at the same revision passed. This pre-existing discrepancy is retained; no image/deployment workflow is dispatched here.
Default/experiment runs, 13 historical and 12 snapshot SQL checks, output comparisons, six runner
guards, fresh preloaded bootstrap, figure review and public SVG byte verification
cover the notebook changes. Run timestamps and source labels distinguish live data
from illustrative narrative. Values and search rankings can change on rerun.

The proper worker title/subtitle come from actual catalog metadata. The maintained
[shared notebook standard](https://github.com/Query-farm/vgi-example-notebooks/blob/main/docs/standard.md)
provides branding, SVG output and safe execution. Committed content-addressed SVG
links render on GitHub; Jupyter/Colab retain native SVG. Logs, data exports and
review PNGs remain ignored. `yfinance_example.py` only validates the display date
and plots SQL-returned results; all financial calculations remain visible SQL.
