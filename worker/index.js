// Edge Worker for the tools site.
//
// Static assets (the .html tool pages, index, colophon, …) are served directly
// by Cloudflare's asset layer before this code runs. This Worker only handles
// requests that don't match a static file — in practice, the MinuteCryptic
// daily-puzzle proxy below, Netlify-style pretty URLs (/foo -> /foo.html),
// plus a fallback to the assets' 404 handling.

const UPSTREAM_ORIGIN = "https://www.minutecryptic.com";

// stock-compare.html fetches daily price data through /api/quote-timeseries so
// the Alpha Vantage API key stays server-side. Responses are cached at the edge
// for 12h (the daily time series changes at most once a day) to stay under the
// free-tier rate limit.
const QUOTE_CACHE_SECONDS = 60 * 60 * 12;

// sf-weather.html fetches PurpleAir sensors through /api/purpleair-sensors so
// the PurpleAir read key stays server-side. Sensors update every ~2 minutes,
// so cache at the edge for 2 minutes to stay under the API point budget.
const PURPLEAIR_CACHE_SECONDS = 120;

// Default bounding box: ~2km around SF City Hall (37.7793, -122.4192).
const CITY_HALL = { lat: 37.7793, lon: -122.4192 };
const DEFAULT_BBOX = {
  nwlng: -122.4392,
  nwlat: 37.7993,
  selng: -122.3992,
  selat: 37.7593,
};

// Fields requested from PurpleAir. Kept minimal — the API bills per field.
const PURPLEAIR_FIELDS = [
  "sensor_index",
  "name",
  "latitude",
  "longitude",
  "location_type",
  "last_seen",
  "humidity",
  "pm2.5_cf_1",
  "pm2.5_atm",
  "confidence",
].join(",");

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

    // Cached proxy for PurpleAir sensor data (sf-weather.html).
    if (url.pathname === "/api/purpleair-sensors") {
      return handlePurpleAir(url, env, ctx);
    }

    // With html_handling: "none", the asset layer serves /foo.html directly but
    // stops mapping "/" to index.html — so serve the homepage explicitly here.
    if (url.pathname === "/") {
      return env.ASSETS.fetch(new URL("/index.html", url));
    }

    // Netlify-style pretty URLs: /foo serves /foo.html (both return 200).
    // With html_handling: "none", only the exact /foo.html path matches an
    // asset, so extensionless URLs fall through to this Worker. Try the .html
    // asset before deferring to 404 handling.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      !url.pathname.startsWith("/api/")
    ) {
      const prettyPath = toPrettyUrlAssetPath(url.pathname);
      if (prettyPath !== null) {
        const asset = await env.ASSETS.fetch(
          new URL(prettyPath + url.search, url),
        );
        if (asset.status !== 404) {
          return asset;
        }
      }
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

// Map an extensionless pretty URL to its .html asset, or return null when the
// path shouldn't be rewritten (exact files, API routes, traversal attempts).
// "/blood-pressure" -> "/blood-pressure.html", "/blood-pressure/" -> same.
function toPrettyUrlAssetPath(pathname) {
  if (pathname === "/" || pathname.includes(".")) {
    return null;
  }
  const base =
    pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;
  if (
    base === "" ||
    base === "/" ||
    base.includes(".") ||
    base.includes("//") ||
    base.includes("..")
  ) {
    return null;
  }
  return base + ".html";
}

async function handlePurpleAir(url, env, ctx) {
  const apiKey = env.PURPLEAIR_API_KEY || env.PURPLE_AIR_API_KEY;
  if (!apiKey) {
    return jsonError("PurpleAir API key not configured", 500);
  }

  const num = (name, fallback) => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const nwlng = num("nwlng", DEFAULT_BBOX.nwlng);
  const nwlat = num("nwlat", DEFAULT_BBOX.nwlat);
  const selng = num("selng", DEFAULT_BBOX.selng);
  const selat = num("selat", DEFAULT_BBOX.selat);

  if (nwlng === null || nwlat === null || selng === null || selat === null) {
    return jsonError("Invalid bounding box parameters", 400);
  }
  if (nwlat < -90 || nwlat > 90 || selat < -90 || selat > 90) {
    return jsonError("Invalid bounding box parameters", 400);
  }
  if (nwlng < -180 || nwlng > 180 || selng < -180 || selng > 180) {
    return jsonError("Invalid bounding box parameters", 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.internal/purpleair?nwlng=${nwlng}&nwlat=${nwlat}&selng=${selng}&selat=${selat}`,
    { method: "GET" },
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const upstreamUrl =
    `https://api.purpleair.com/v1/sensors?` +
    `fields=${encodeURIComponent(PURPLEAIR_FIELDS)}` +
    `&location_type=0&max_age=3600` +
    `&nwlng=${nwlng}&nwlat=${nwlat}&selng=${selng}&selat=${selat}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { "X-API-Key": apiKey },
    });
  } catch (error) {
    console.error(error);
    return jsonError("An error occurred", 500);
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control":
        upstream.ok === true
          ? `public, max-age=${PURPLEAIR_CACHE_SECONDS}`
          : "no-store",
    },
  });

  if (upstream.ok) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
