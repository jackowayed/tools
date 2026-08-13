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
directory. Re-run `./build.sh` after adding or committing a tool, then commit
the regenerated `index.html` and `colophon.html`.
