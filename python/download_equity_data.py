#!/usr/bin/env python3
"""
NSE Equity Data Downloader

Downloads daily OHLCV data for NSE stocks listed in stock_list.txt.
Folder structure: data/<SYMBOL>/<YYYY-MM-DD>.csv
Skips download if file already exists for that date.
Data range: 2026-01-01 to today.

Dependencies: pip install yfinance pandas
"""

import os
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    sys.exit("yfinance not installed. Run: pip install yfinance pandas")

import pandas as pd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
STOCK_LIST_FILE = SCRIPT_DIR / "stock_list.txt"
DATA_DIR = SCRIPT_DIR / "data"
START_DATE = date(2026, 1, 1)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_stock_list(filepath: Path) -> list[str]:
    """Read stock symbols from file, ignoring blank lines and comments."""
    symbols = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                symbols.append(line.upper())
    return symbols


def trading_dates(start: date, end: date) -> list[date]:
    """Return weekdays between start and end (inclusive)."""
    days = []
    current = start
    while current <= end:
        if current.weekday() < 5:  # Mon-Fri
            days.append(current)
        current += timedelta(days=1)
    return days


def download_symbol(symbol: str, start: date, end: date) -> None:
    """Download daily data for one symbol and save per-day CSV files."""
    ticker = f"{symbol}.NS"
    symbol_dir = DATA_DIR / symbol
    symbol_dir.mkdir(parents=True, exist_ok=True)

    # Determine which dates are missing
    dates_needed = trading_dates(start, end)
    missing_dates = [
        d for d in dates_needed
        if not (symbol_dir / f"{d}.csv").exists()
    ]

    if not missing_dates:
        print(f"  [{symbol}] All dates present, skipping.")
        return

    # Fetch the full range in one API call (efficient)
    fetch_start = missing_dates[0].strftime("%Y-%m-%d")
    fetch_end = (missing_dates[-1] + timedelta(days=1)).strftime("%Y-%m-%d")  # yf end is exclusive

    print(f"  [{symbol}] Fetching {len(missing_dates)} missing date(s) "
          f"({fetch_start} -> {missing_dates[-1]})...")

    try:
        df = yf.download(
            ticker,
            start=fetch_start,
            end=fetch_end,
            interval="1d",
            auto_adjust=True,
            progress=False,
        )
    except Exception as exc:
        print(f"  [{symbol}] Download error: {exc}")
        return

    if df.empty:
        print(f"  [{symbol}] No data returned (non-trading period or delisted).")
        return

    # yfinance returns a MultiIndex when downloading a single ticker with auto_adjust
    # Flatten columns if needed
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df.index = pd.to_datetime(df.index).date  # ensure date objects

    saved = 0
    for d in missing_dates:
        filepath = symbol_dir / f"{d}.csv"
        if filepath.exists():
            continue  # another process may have written it
        if d in df.index:
            row = df.loc[[d]]
            row.index.name = "Date"
            row.to_csv(filepath)
            saved += 1
        # If date not in df it was a market holiday — silently skip

    print(f"  [{symbol}] Saved {saved} file(s).")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if not STOCK_LIST_FILE.exists():
        sys.exit(f"Stock list not found: {STOCK_LIST_FILE}")

    symbols = load_stock_list(STOCK_LIST_FILE)
    if not symbols:
        sys.exit("No symbols found in stock list.")

    today = date.today()
    if START_DATE > today:
        sys.exit(f"Start date {START_DATE} is in the future.")

    print(f"NSE Equity Downloader")
    print(f"  Stock list : {STOCK_LIST_FILE}")
    print(f"  Data dir   : {DATA_DIR}")
    print(f"  Date range : {START_DATE} -> {today}")
    print(f"  Symbols    : {len(symbols)}")
    print()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for symbol in symbols:
        download_symbol(symbol, START_DATE, today)

    print("\nDone.")


if __name__ == "__main__":
    main()
