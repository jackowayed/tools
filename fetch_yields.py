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

import html
import json
import re
import ssl
import urllib.parse
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
# Victory Capital 30-day SEC yield — the authoritative number for the funds
# Victory publishes (via investorapi.vcm.com, the same feed that powers their
# public fund pages). MAFRX is a Pioneer fund that Victory acquired; it isn't
# in this feed yet, but wiring it by ticker means the real 30-day SEC yield
# will appear automatically once Victory finishes migrating the Pioneer funds.
# --------------------------------------------------------------------------

# Public front-end key embedded in Victory's fund pages. We scrape a fresh
# one each run so a rotation doesn't break us; this is only the fallback.
_VICTORY_KEY_FALLBACK = "orcyfZFHdC9GK5Tk4haPn7o3CU5ItULauov6JsF9"
_victory_cache = {}


def _victory_api_key():
    if "key" in _victory_cache:
        return _victory_cache["key"]
    key = _VICTORY_KEY_FALLBACK
    try:
        page = http_get(
            "https://investor.vcm.com/products/mutual-funds/mutual-funds-list"
        )
        m = re.search(r'fundApiKey"?\s*value="([^"]+)"', page)
        if m:
            key = m.group(1)
    except Exception:
        pass
    _victory_cache["key"] = key
    return key


def _victory_fund_index():
    """Map upper-case ticker -> (fundId, share_class), cached per run."""
    if "index" in _victory_cache:
        return _victory_cache["index"]
    index = {}
    try:
        funds = json.loads(
            http_get(
                "https://investorapi.vcm.com/search/products/FUND",
                {"x-api-key": _victory_api_key()},
            )
        )
        for fund in funds:
            for cls in fund.get("classes", []):
                tk = (cls.get("ticker") or "").upper()
                if tk:
                    index[tk] = (fund["fundId"], cls.get("share_class"))
    except Exception:
        pass
    _victory_cache["index"] = index
    return index


def fetch_victory_sec_yield(ticker):
    """Return (30-day SEC yield percent, as_of 'YYYY-MM-DD'), or (None, None)."""
    fund_id, share = _victory_fund_index().get(ticker.upper(), (None, None))
    if not fund_id:
        return None, None
    try:
        rows = json.loads(
            http_get(
                f"https://investorapi.vcm.com/search/product/{fund_id}/Yields",
                {"x-api-key": _victory_api_key()},
            )
        )
    except Exception:
        return None, None
    for row in rows:
        if row.get("share_class") == share:
            fx = row.get("yields_fixed_income") or {}
            raw = fx.get("thirtyday_sec_yield")
            if raw:
                as_of = fx.get("as_of_date")  # e.g. "07/31/2026"
                if as_of and re.match(r"\d{2}/\d{2}/\d{4}", as_of):
                    mm, dd, yy = as_of.split("/")
                    as_of = f"{yy}-{mm}-{dd}"
                return round(float(raw), 2), as_of
    return None, None


# --------------------------------------------------------------------------
# SGOV 30-day SEC yield — iShares (BlackRock) renders it right into the fund
# page, both as a visible value and inside a JSON datapoint blob. We read the
# JSON field, which is the most stable anchor. The page needs its full slug
# URL (the numeric-id-only URL is blocked), so that lives in the config.
# --------------------------------------------------------------------------

def fetch_ishares_sec_yield(url):
    """Return (30-day SEC yield percent, as_of 'YYYY-MM-DD') for an iShares ETF."""
    try:
        # The datapoint JSON is HTML-entity-escaped in the served markup.
        page = html.unescape(http_get(url))
    except Exception:
        return None, None

    m = re.search(
        r'"thirtyDaySecYield":\{[^}]*?"formattedValue":"([0-9.]+)%"', page
    )
    if not m:
        return None, None
    value = round(float(m.group(1)), 2)

    as_of = None
    d = re.search(
        r'"30 Day SEC Yield as of","value":"[0-9.]+%",'
        r'"valueReference":\{[^}]*?"value":"([^"]+)"',
        page,
    )
    if d:
        try:
            as_of = datetime.strptime(d.group(1).strip(), "%b %d, %Y").strftime(
                "%Y-%m-%d"
            )
        except ValueError:
            as_of = None
    return value, as_of


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
            page = http_get(url)
        except Exception:
            continue
        for pat in _APY_PATTERNS:
            for m in pat.finditer(page):
                try:
                    v = float(m.group(1))
                except ValueError:
                    continue
                if 0.5 <= v <= 10:  # sanity band for a cash APY
                    return v
    return None


def scrape_aggregator_apy(aggregators):
    """Try each {url, pattern} rate aggregator; return (apy_percent, host).

    Aggregators (e.g. rate trackers) often render a bank's APY server-side
    even when the bank's own page hides it behind JavaScript. Each entry's
    ``pattern`` must capture the rate in group 1. Best-effort and brittle by
    nature, so it sits behind the direct scrape and ahead of the manual
    fallback.
    """
    for agg in aggregators or []:
        try:
            page = http_get(agg["url"])
        except Exception:
            continue
        # Reduce to visible text so patterns aren't broken by inline markup
        # (e.g. "Current Rate: <b>3.00% APY</b>").
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(page)))
        m = re.search(agg["pattern"], text, re.IGNORECASE)
        if not m:
            continue
        try:
            v = float(m.group(1))
        except (ValueError, IndexError):
            continue
        if 0.5 <= v <= 8:  # sanity band for a cash APY
            host = re.sub(r"^www\.", "", urllib.parse.urlparse(agg["url"]).netloc)
            return v, host
    return None, None


# --------------------------------------------------------------------------
# Orchestration.
# --------------------------------------------------------------------------

def update_source(src):
    """Update one source dict in place. Returns nothing."""
    sid = src["id"]
    value, method = None, None
    metric = None   # override src["metric"] when a source has several forms
    as_of = None    # override the "as of" date (else today, on success)

    try:
        if sid in BANK_PAGES:
            value = scrape_bank_apy(sid)
            method = "scraped bank page" if value is not None else None
            if value is None and src.get("aggregators"):
                value, host = scrape_aggregator_apy(src["aggregators"])
                if value is not None:
                    method = f"rate aggregator ({host})"
        elif sid == "tbill4w":
            value, method = fetch_tbill_4week()
        elif sid == "sgov":
            url = src.get("ishares_url")
            if url:
                value, as_of = fetch_ishares_sec_yield(url)
                if value is not None:
                    method = "iShares fund page"
                    metric = "30-day SEC yield"
        elif sid == "mafrx":
            # Prefer the real 30-day SEC yield from Victory. If that's not
            # available (Pioneer funds aren't in the feed yet) and no manual
            # SEC value is set, approximate with the trailing distribution
            # yield from Yahoo — clearly relabelled so the two aren't confused.
            tk = src.get("victory_ticker")
            if tk:
                value, as_of = fetch_victory_sec_yield(tk)
                if value is not None:
                    method = "Victory Capital 30-day SEC yield"
                    metric = "30-day SEC yield"
            if value is None and src.get("manual") is None:
                value = fetch_distribution_yield("MAFRX")
                if value is not None:
                    method = "Yahoo Finance (distribution yield)"
                    metric = "trailing 12-mo distribution yield"
                    as_of = today()
    except Exception as exc:  # never let one source break the run
        print(f"  ! {sid}: {exc}")
        value = None

    if value is not None:
        src["yield"] = value
        src["method"] = method
        src["as_of"] = as_of or today()
        src["status"] = "ok"
        if metric:
            src["metric"] = metric
        print(f"  ok {sid}: {value}% ({method})")
        return

    # Fetch failed — fall back to a manual value, then to last-known.
    manual = src.get("manual")
    if manual is not None:
        src["yield"] = manual
        src["method"] = "manual value"
        src["as_of"] = today()
        src["status"] = "manual"
        # A manual value for MAFRX is meant to be the 30-day SEC yield.
        if sid == "mafrx":
            src["metric"] = "30-day SEC yield"
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
