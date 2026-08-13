#!/usr/bin/env python3
"""Fetch the effective yield of each place cash is kept and update
``cash-yields.json``.

Run by ``.github/workflows/update-yields.yml`` on a schedule (and on
demand). Everything here is best-effort: each source is fetched inside its
own ``try``/``except`` so one failure never sinks the whole run, and a
source that can't be fetched this time keeps its last-known value (marked
``stale``) rather than disappearing.

Design notes
------------
* Stdlib only — no pip install in CI, matching the rest of this repo.
* The three bank savings accounts (Citi, Ally, Wealthfront) have no data
  API, so we make a best-effort scrape of their published-APY pages. Those
  pages are often JavaScript-rendered and will frequently *not* contain the
  number in raw HTML; when that happens we fall back to the ``manual`` value
  you can set in ``cash-yields.json``, then to the last-known value.
* Treasury bill rates come from the U.S. Treasury's public XML feed.
* SPY and MAFRX yields are computed from trailing-12-month distributions
  (via Yahoo's public chart endpoint) divided by the latest price.
"""

import json
import re
import ssl
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "cash-yields.json"

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
TIMEOUT = 30
_CTX = ssl.create_default_context()


def http_get(url, headers=None):
    """GET ``url`` and return the decoded body text, or raise."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=_CTX) as resp:
        return resp.read().decode("utf-8", errors="replace")


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# 4-week Treasury bill — U.S. Treasury daily XML feeds (no key required).
# --------------------------------------------------------------------------

def fetch_tbill_4week():
    """Return the 4-week bill coupon-equivalent yield (percent), or None.

    Primary source: the daily *Treasury Bill Rates* feed, whose
    ``ROUND_B1_YIELD_4WK_2`` field is the coupon-equivalent (bond-equivalent)
    yield. Fallback: the 1-month point (``BC_1MONTH``) of the daily par
    yield curve, which tracks the 4-week bill closely.
    """
    year = datetime.now(timezone.utc).year
    base = (
        "https://home.treasury.gov/resource-center/data-chart-center/"
        "interest-rates/pages/xml"
    )

    def last_value(xml, field):
        # Feeds are ascending by date, so the last non-empty value is newest.
        vals = re.findall(rf"<d:{field}[^>]*>([^<]*)</d:{field}>", xml)
        for v in reversed(vals):
            v = v.strip()
            if v:
                try:
                    return float(v)
                except ValueError:
                    continue
        return None

    # Try current year then previous, in case Jan 1 has no rows yet.
    for yr in (year, year - 1):
        try:
            xml = http_get(
                f"{base}?data=daily_treasury_bill_rates&field_tdr_date_value={yr}"
            )
        except Exception:
            continue
        v = last_value(xml, "ROUND_B1_YIELD_4WK_2")
        if v is not None:
            return v, "U.S. Treasury bill-rates feed (coupon equivalent)"

    for yr in (year, year - 1):
        try:
            xml = http_get(
                f"{base}?data=daily_treasury_yield_curve&field_tdr_date_value={yr}"
            )
        except Exception:
            continue
        v = last_value(xml, "BC_1MONTH")
        if v is not None:
            return v, "U.S. Treasury par yield curve (1-month)"

    return None, None


# --------------------------------------------------------------------------
# SPY / MAFRX — trailing-12-month distribution yield from Yahoo's chart API.
# --------------------------------------------------------------------------

def fetch_distribution_yield(symbol):
    """Return (trailing-12mo distributions / latest price) * 100, or None."""
    now = datetime.now(timezone.utc).timestamp()
    one_year_ago = now - 365 * 24 * 3600
    hosts = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
    data = None
    for host in hosts:
        url = (
            f"https://{host}/v8/finance/chart/{symbol}"
            "?range=1y&interval=1d&events=div"
        )
        try:
            data = json.loads(http_get(url))
            break
        except Exception:
            data = None
    if not data:
        return None

    try:
        result = data["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        return None

    meta = result.get("meta", {})
    price = meta.get("regularMarketPrice")
    if not price:
        # Fall back to the most recent close in the series.
        try:
            closes = [c for c in result["indicators"]["quote"][0]["close"] if c]
            price = closes[-1] if closes else None
        except (KeyError, IndexError, TypeError):
            price = None
    if not price:
        return None

    divs = (result.get("events", {}) or {}).get("dividends", {}) or {}
    trailing = sum(
        d["amount"]
        for d in divs.values()
        if d.get("date", 0) >= one_year_ago and d.get("amount") is not None
    )
    if trailing <= 0:
        return None
    return round(trailing / price * 100, 2)


# --------------------------------------------------------------------------
# Bank savings APYs — best-effort scrape of published-rate pages.
# --------------------------------------------------------------------------

# These pages are often JS-rendered, so a hit is a bonus, not a guarantee.
BANK_PAGES = {
    "citi": [
        "https://www.citi.com/banking/savings-account",
    ],
    "ally": [
        "https://www.ally.com/bank/online-savings-account/",
    ],
    "wealthfront": [
        "https://www.wealthfront.com/cash",
    ],
}

# Match "3.90% APY" or "APY ... 3.90%", capturing a plausible rate.
_APY_PATTERNS = [
    re.compile(r"(\d\.\d{1,2})\s*%\s*APY", re.IGNORECASE),
    re.compile(r"APY[^0-9%]{0,25}(\d\.\d{1,2})\s*%", re.IGNORECASE),
]


def scrape_bank_apy(bank_id):
    """Best-effort: return an APY (percent) found in the page HTML, or None."""
    for url in BANK_PAGES.get(bank_id, []):
        try:
            html = http_get(url)
        except Exception:
            continue
        for pat in _APY_PATTERNS:
            for m in pat.finditer(html):
                try:
                    v = float(m.group(1))
                except ValueError:
                    continue
                if 0.5 <= v <= 10:  # sanity band for a cash APY
                    return v
    return None


# --------------------------------------------------------------------------
# Orchestration.
# --------------------------------------------------------------------------

def update_source(src):
    """Update one source dict in place. Returns nothing."""
    sid = src["id"]
    value, method = None, None

    try:
        if sid in BANK_PAGES:
            value = scrape_bank_apy(sid)
            method = "scraped bank page" if value is not None else None
        elif sid == "tbill4w":
            value, method = fetch_tbill_4week()
        elif sid == "spy":
            value = fetch_distribution_yield("SPY")
            method = "Yahoo Finance" if value is not None else None
        elif sid == "mafrx":
            value = fetch_distribution_yield("MAFRX")
            method = "Yahoo Finance" if value is not None else None
    except Exception as exc:  # never let one source break the run
        print(f"  ! {sid}: {exc}")
        value = None

    if value is not None:
        src["yield"] = value
        src["method"] = method
        src["as_of"] = today()
        src["status"] = "ok"
        print(f"  ok {sid}: {value}% ({method})")
        return

    # Fetch failed — fall back to a manual value, then to last-known.
    manual = src.get("manual")
    if manual is not None:
        src["yield"] = manual
        src["method"] = "manual value"
        src["as_of"] = today()
        src["status"] = "manual"
        print(f"  ~ {sid}: using manual value {manual}%")
    elif src.get("yield") is not None:
        src["status"] = "stale"
        print(f"  ~ {sid}: keeping last-known {src['yield']}% (stale)")
    else:
        src["status"] = "unavailable"
        print(f"  x {sid}: unavailable")


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    print("Fetching yields...")
    for src in data["sources"]:
        update_source(src)
    data["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    DATA.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {DATA.name}")


if __name__ == "__main__":
    main()
