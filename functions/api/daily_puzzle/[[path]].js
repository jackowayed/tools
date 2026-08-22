// Cloudflare Pages Function: proxy /api/daily_puzzle/* to MinuteCryptic.
//
// This replaces the Netlify `_redirects` rewrite
//
//   /api/daily_puzzle/*  https://www.minutecryptic.com/api/daily_puzzle/:splat  200
//
// which proxied the request server-side (a 200 rewrite, not a 3xx redirect)
// so the browser never talks to minutecryptic.com directly and dodges CORS.
// Cloudflare Pages' own `_redirects` only supports 3xx redirects for external
// URLs, so the proxy is reimplemented here as a Pages Function instead.

const UPSTREAM = "https://www.minutecryptic.com";

export async function onRequest(context) {
  const { request, params } = context;
  const incoming = new URL(request.url);

  // `params.path` is the catch-all segments matched by [[path]].
  const splat = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");

  const target = new URL(`/api/daily_puzzle/${splat}`, UPSTREAM);
  target.search = incoming.search;

  // Forward the request to the upstream API. fetch() rewrites the Host header
  // to minutecryptic.com based on the target URL, so the puzzle endpoint sees
  // a normal same-origin-looking request and the browser never touches it
  // cross-origin.
  const upstreamRequest = new Request(target.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  // Return the upstream response as-is. The Workers runtime keeps the body and
  // its content-encoding consistent, so no header surgery is needed.
  return fetch(upstreamRequest);
}
