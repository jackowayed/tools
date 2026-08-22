// Edge Worker for the tools site.
//
// Static assets (the .html tool pages, index, colophon, …) are served directly
// by Cloudflare's asset layer before this code runs. This Worker only handles
// requests that don't match a static file — in practice, the MinuteCryptic
// daily-puzzle proxy below, plus a fallback to the assets' 404 handling.

const UPSTREAM_ORIGIN = "https://www.minutecryptic.com";

export default {
  async fetch(request, env) {
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
