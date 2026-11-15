"""Plot SQL-returned Yahoo data; do not retrieve or change analytical values."""

from datetime import date
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
from vgi_notebooks import finish

COLORS = {"AAPL": "#267358", "MSFT": "#456fba", "SPY": "#c57b40"}


def validate_start(value):
    if not isinstance(value, str):
        raise ValueError("DISPLAY_START must be an ISO date from January through March 1, 2024")
    chosen = date.fromisoformat(value)
    if chosen.isoformat() != value or not date(2024, 1, 1) <= chosen <= date(2024, 3, 1):
        raise ValueError("DISPLAY_START must be from 2024-01-01 through 2024-03-01")


def source(time):
    return f"Source: Yahoo Finance live public data · retrieval began {time}\nVGI Yahoo Finance v0.6.0 native release + visible SQL · descriptive example, not an investment strategy"


def price_paths(paths, start, retrieved):
    fig, ax = plt.subplots(figsize=(11.8, 6.4))
    for symbol, rows in paths.groupby("symbol", sort=True):
        ax.plot(
            pd.to_datetime(rows.observation_date),
            rows.adjusted_index,
            label=symbol,
            color=COLORS[symbol],
            linewidth=2.3,
        )
    ax.axhline(100, color="#708377", linewidth=1, linestyle="--")
    ax.set(ylabel="Adjusted-price index · first common date = 100", xlabel="Observed session date")
    ax.legend(loc="best")
    ax.margins(x=0.03, y=0.12)
    finish(
        fig,
        "Compare paths from the same observed starting date",
        f"Historical daily bars · display start {start} · {paths.observation_date.nunique()} common dates",
        source(retrieved),
        name="01-adjusted-paths",
    )


def drawdowns(paths, start, retrieved):
    fig, ax = plt.subplots(figsize=(11.8, 6.4))
    for symbol, rows in paths.groupby("symbol", sort=True):
        ax.plot(
            pd.to_datetime(rows.observation_date),
            rows.drawdown_pct,
            label=symbol,
            color=COLORS[symbol],
            linewidth=2.3,
        )
    ax.axhline(0, color="#708377", linewidth=1)
    ax.set(
        ylabel="Decline from running in-window high · %",
        xlabel="Observed session date",
        ylim=(None, 0.8),
    )
    ax.legend(loc="best")
    ax.margins(x=0.03)
    finish(
        fig,
        "Use only peaks already observed inside the window",
        f"Window begins {start} · adjusted closes on shared dates · no forward filling",
        source(retrieved),
        name="02-window-drawdowns",
    )


def quote_fields(data, limit, retrieved):
    shown = data.loc[data.candidate_rank <= limit].copy()
    fields = [
        "returned",
        "has_currency",
        "finite_price",
        "has_timestamp",
        "has_day_range",
        "has_year_range",
    ]
    labels = ["Quote row", "Currency", "Finite price", "Market time", "Day range", "52-week range"]
    values = shown[fields].astype(int).to_numpy()
    from matplotlib.colors import ListedColormap

    fig, ax = plt.subplots(figsize=(11.8, max(4.9, 3.6 + 0.42 * len(shown))))
    ax.imshow(values, cmap=ListedColormap(["#e5e9e7", "#397f91"]), vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(len(fields)), labels, rotation=12, ha="right")
    ax.set_yticks(
        range(len(shown)), [f"#{r.candidate_rank} {r.requested_symbol}" for r in shown.itertuples()]
    )
    for i in range(len(shown)):
        for j in range(len(fields)):
            ax.text(
                j,
                i,
                "yes" if values[i, j] else "missing",
                ha="center",
                va="center",
                color="white" if values[i, j] else "#43574a",
                fontsize=10,
            )
    ax.grid(False)
    finish(
        fig,
        "Present fields do not establish a fresh snapshot",
        f"Local first {limit} ranks · {len(shown)} shown of {len(data)} fetched candidates · availability is not quality",
        source(retrieved),
        name="03-quote-fields",
    )


def quote_ages(data, limit, retrieved):
    shown = data.loc[data.candidate_rank <= limit].copy()
    fig, ax = plt.subplots(figsize=(11.8, max(4.9, 3.6 + 0.42 * len(shown))))
    finite = shown.market_age_days[np.isfinite(shown.market_age_days)]
    maximum = max(float(finite.max()) if len(finite) else 1, 1)
    for i, row in enumerate(shown.itertuples()):
        if np.isfinite(row.market_age_days):
            ax.barh(i, row.market_age_days, color="#397f91", height=0.55)
            ax.text(
                row.market_age_days + maximum * 0.025,
                i,
                f"{row.market_age_days:.2f} d",
                va="center",
            )
        else:
            ax.text(
                0.02,
                i,
                "No returned timestamp",
                transform=ax.get_yaxis_transform(),
                va="center",
                fontstyle="italic",
            )
    ax.set_yticks(
        range(len(shown)), [f"#{r.candidate_rank} {r.requested_symbol}" for r in shown.itertuples()]
    )
    ax.invert_yaxis()
    ax.set(
        xlim=(0, maximum * 1.27),
        xlabel="Elapsed days from vendor regular-market time to retrieval end",
    )
    ax.grid(axis="y", visible=False)
    finish(
        fig,
        "Returned snapshots need their own timestamps",
        f"Local first {limit} ranks · calendar time, not exchange sessions or a market-open test",
        source(retrieved),
        name="04-quote-ages",
    )
