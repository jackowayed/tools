# tools

A little collection of single-page tools — a spiritual successor to
[Simon Willison's tools](https://github.com/simonw/tools).

Each tool has an `.html` entry point in the root of this repo. Baby-weight also
uses adjacent JavaScript modules for durable storage and optional sync.

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

A tool appears on the homepage as soon as you drop its `.html` file in this
directory. The pages have no third-party runtime dependencies. Node development
dependencies support the sync Worker, local D1, and tests.

### Automatic rebuilds

A GitHub Actions workflow (`.github/workflows/build.yml`) runs `./build.sh`
on every push to `main` and commits the regenerated `index.html` and
`colophon.html` back to the repo, so you don't have to build them by hand.
It skips its own commits to avoid a loop. You can still run `./build.sh`
locally to preview changes before pushing.

## Baby-weight sync

See [SYNC.md](SYNC.md) for local setup, D1 deployment, protocol details, and
verification commands. Sync is opt-in; the tool saves locally using IndexedDB
when disconnected.
