# tools

A little collection of single-page tools — a spiritual successor to
[Simon Willison's tools](https://github.com/simonw/tools).

Each tool is a self-contained `.html` file in the root of this repo.

## Building

The homepage (`index.html`) and colophon (`colophon.html`) are generated
from the tool files and git history:

```sh
./build.sh
```

- **`build_index.py`** — writes `index.html`, listing every tool sorted by
  most recently changed.
- **`build_colophon.py`** — writes `colophon.html`, showing each tool's git
  commit history.
- **`build_common.py`** — shared helpers: tool discovery, title extraction
  from the `<title>` tag, git log parsing, and the page chrome.

There are no manifests to maintain and no third-party dependencies — a tool
appears on the homepage as soon as you drop its `.html` file in this
directory.

## API proxy (Cloudflare Pages)

The Cryptic Helper (`cryptic-scratchpad.html`) fetches the day's puzzle from
`/api/daily_puzzle/*`, which is proxied server-side to
[MinuteCryptic](https://www.minutecryptic.com) so the browser never makes a
cross-origin request (dodging CORS).

This used to be a Netlify `_redirects` rewrite:

```
/api/daily_puzzle/*  https://www.minutecryptic.com/api/daily_puzzle/:splat  200
```

Cloudflare Pages' `_redirects` only supports 3xx redirects to external URLs,
not 200 rewrites, so the proxy now lives in a
[Pages Function](https://developers.cloudflare.com/pages/functions/) at
`functions/api/daily_puzzle/[[path]].js`. The repo root is served as the
static site; anything under `functions/` becomes a serverless route.

### Automatic rebuilds

A GitHub Actions workflow (`.github/workflows/build.yml`) runs `./build.sh`
on every push to `main` and commits the regenerated `index.html` and
`colophon.html` back to the repo, so you don't have to build them by hand.
It skips its own commits to avoid a loop. You can still run `./build.sh`
locally to preview changes before pushing.
