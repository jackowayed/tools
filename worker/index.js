// Edge Worker for the tools site.
//
// Static assets (the .html tool pages, index, colophon, …) are served directly
// by Cloudflare's asset layer before this code runs. This Worker only handles
// requests that don't match a static file — in practice, the MinuteCryptic
// daily-puzzle proxy below, plus a fallback to the assets' 404 handling.

const UPSTREAM_ORIGIN = "https://www.minutecryptic.com";

// stock-compare.html fetches daily price data through /api/quote-timeseries so
// the Alpha Vantage API key stays server-side. Responses are cached at the edge
// for 12h (the daily time series changes at most once a day) to stay under the
// free-tier rate limit.
const QUOTE_CACHE_SECONDS = 60 * 60 * 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Transparent same-origin proxy for the MinuteCryptic daily puzzle API.
    // Replaces the old Netlify _redirects rule:
    //   /api/daily_puzzle/*  https://www.minutecryptic.com/api/daily_puzzle/:splat  200
    // Serving it from our own origin avoids the cross-origin/CORS problems a
    // plain redirect would cause (cryptic-scratchpad.html fetches it directly).
    if (url.pathname.startsWith("/api/daily_puzzle/")) {
      const upstream = UPSTREAM_ORIGIN + url.pathname + url.search;
      return fetch(new Request(upstream, request));
    }

    // Cached proxy for the Alpha Vantage daily quote series (stock-compare.html).
    if (url.pathname === "/api/quote-timeseries") {
      return handleQuote(url, env, ctx);
    }

    // With html_handling: "none", the asset layer serves /foo.html directly but
    // stops mapping "/" to index.html — so serve the homepage explicitly here.
    if (url.pathname === "/") {
      return env.ASSETS.fetch(new URL("/index.html", url));
    }

    // Anything else that reached the Worker didn't match a static asset;
    // defer to the assets layer so its 404 handling applies.
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(url, env, ctx) {
  const symbol = (url.searchParams.get("symbol") || "").trim();
  if (!symbol) {
    return jsonError("Missing symbol", 400);
  }

  // Cache key normalized on the symbol so casing/whitespace don't fragment it.
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.internal/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    { method: "GET" },
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  let body;
  try {
    const upstream = await fetch(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${encodeURIComponent(symbol)}&apikey=${env.ALPHA_VANTAGE_KEY}`,
    );
    body = await upstream.text();
  } catch (error) {
    console.error(error);
    return jsonError("An error occurred", 500);
  }

  // Alpha Vantage returns HTTP 200 even for rate-limit / error payloads
  // (a "Note"/"Information" object with no time series). Only cache real data.
  const isValidData = body.includes("Time Series (Daily)");

  const response = new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": isValidData ? `public, max-age=${QUOTE_CACHE_SECONDS}` : "no-store",
    },
  });

  if (isValidData) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
