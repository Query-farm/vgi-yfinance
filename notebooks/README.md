# Yahoo Finance: align dates before comparing price paths

[01 · Align dates before comparing adjusted price paths](01_align_adjusted_price_paths.ipynb)
retrieves daily January–March 2024 bars for AAPL, MSFT and SPY. Visible SQL
materializes history once, audits missing values, selects shared observation dates,
rebases adjusted closes and computes a past-only running peak. Two charts explain
how the starting date affects both an index and an in-window drawdown.

## Run

Install [uv](https://docs.astral.sh/uv/), then from this directory:

```sh
uv sync --locked
uv run --locked python execute.py
```

The complete `notebooks/` directory runs on its own. No worker checkout, Bun, local
worker build or API key is needed. The visible literal ATTACH uses
`github-auto://Query-farm/vgi-yfinance@v0.6.0`; VGI downloads the published archive
for macOS arm64, Linux x64 or Linux arm64, verifies its checksum and caches it.
Other platforms need a separately supported worker runtime. The Python environment
is locked to Haybarn 2.0.0rc11 and its compatible notebook dependencies.

For VS Code, select `notebooks/.venv/bin/python`. The runner uses a disposable kernel
specification; it does not register a global kernel. Connections and analytical SQL
are shown, while setup, plotting, assertions and cleanup are folded. Saved outputs
are replaced only after successful execution.

## Controlled experiment

```sh
uv run --locked python execute.py --parameters '{"DISPLAY_START":"2024-02-01"}' --output-dir validation/february
```

Overrides require a separate destination. The runner rejects unknown parameters
and invalid dates without replacing the last successful notebook. Copies include
the assets, runner and locked environment. The supported display-start range is
2024-01-01 through 2024-03-01. Reset to 2024-01-01 for the default example; restart
the kernel and run all after editing.

Each run performs fresh public reads for the same fixed interval
`[2024-01-01, 2024-04-01)`, using daily regular-session bars. Yahoo can revise even
historical values. The default and experiment are a controlled comparison only
when their underlying price data agree. The final check cell writes ignored
`validation/data/history.csv`, `comparison.csv` and `run.json` so those values can
be compared directly. Network failures stop execution; there is no synthetic or
recorded-data fallback. Initial package, extension and release downloads also need
network access.

An empty temporary SQL secret directory with persistent secrets disabled prevents
saved credentials from affecting the connection. This worker itself is keyless.
No account, trades or remote writes are involved.

## Read the charts carefully

- The fixed examples are two equities and an ETF, not a selection rule or portfolio.
- Each adjusted-price index starts at 100 on the first shared observed date, which
  may follow the selected lower bound. No missing price is forward-filled.
- `adjclose` is Yahoo's vendor-adjusted series. Its adjustment factors may be
  revised. The notebook does not simulate cash distributions, reinvestment trades,
  execution, taxes or fees.
- A drawdown uses only the highest adjusted close already seen in the selected
  window. Earlier peaks and excluded dates can change what it measures. Zero is a
  selected-window high, not zero risk.
- UTC dates identify these US regular-session observations. Price history alone
  cannot establish an exchange's holiday calendar or distinguish all missing-data
  causes.

Twelve SQL checks validate unique keys, bounds, alignment, common start values,
finite positive adjusted closes, nondecreasing peaks and an independent correlated
past-only peak calculation. They test the mechanics, not completeness or future
performance. The fixed source period remains visible in SQL.

Data is retrieved from [Yahoo Finance](https://finance.yahoo.com/) and its public
chart endpoint. Review [Yahoo's terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)
for the intended use. No raw API response fixture is distributed. The saved example
contains its executed tables and charts with retrieval timestamps; reruns may vary.
The unchanged official Query.Farm Strata Sun wordmark is linked at both ends of the
notebook, with the VGI logo near the top.

Validation observed small differences in 119 of 183 adjusted closes between the
default and experiment: maximum absolute difference 0.000123, maximum relative
difference below 0.000025%. All other source columns matched exactly. The experiment
agreed with independently recomputing the changed window on the original prices
within 0.0001 index or percentage points. This documents those runs; it does not
promise a bound on future vendor changes.
