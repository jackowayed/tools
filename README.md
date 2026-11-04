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

## Breastfeeding tracker

Open `breastfeeding.html` (or `/breastfeeding` on the deployed site). Start or
switch sides, pause, save, reset, and edit current or saved feeds. The summary
measures time since the latest saved feed started; `*` marks its last breast used.

Feeds and the current timer are stored in a separate IndexedDB database on this
device. Open **Sync between devices**, create sync on one device, and copy its
`nf1` key into the other device’s Connect field. All timer actions and saved-feed
edits sync automatically; visible devices check every five seconds. Nursing keys
are separate from baby-weight keys. Offline changes queue for reconnection.
See [SYNC.md](SYNC.md#breastfeeding-sync) for deployment and conflict behavior. Active timers recover elapsed time after closing or
reloading the page. Editing the current feed pauses it; resume either side after
applying changes. Reset clears only the current timer, after confirmation.

Run `npm test` for timer logic and `npm run test:browser:nursing` for the mobile
workflow (install Chromium with `npm run test:browser:install`, or set
`CHROMIUM_PATH` to an existing Chromium executable).
