"""Shared helpers for the build scripts.

A deliberately simple take on the build system behind
https://github.com/simonw/tools — tools are just the ``.html`` files
in this directory, their titles come from the ``<title>`` tag, and all
metadata (dates, commit messages) comes straight from ``git log``.
No JSON manifests to keep in sync, no external dependencies.
"""

import html
import re
import subprocess
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent

# Generated pages — never list these as tools.
GENERATED = {"index.html", "colophon.html"}


def find_tools():
    """Return tool .html filenames, sorted alphabetically."""
    return sorted(
        p.name
        for p in ROOT.glob("*.html")
        if p.name not in GENERATED
    )


def get_title(filename):
    """Pull the <title> out of a tool file, falling back to the name."""
    text = (ROOT / filename).read_text(encoding="utf-8", errors="replace")
    match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
    if match:
        return html.unescape(match.group(1).strip())
    # Fall back to a title-cased version of the filename.
    return filename[:-5].replace("-", " ").replace("_", " ").title()


def git_log(filename):
    """Return a list of commits touching ``filename``, newest first.

    Each commit is a dict with ``hash``, ``date`` (a datetime), and
    ``subject``. Returns an empty list for files git doesn't know about
    yet (e.g. a tool that hasn't been committed).
    """
    result = subprocess.run(
        ["git", "log", "--follow", "--format=%h\x1f%aI\x1f%s", "--", filename],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    commits = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        commit_hash, iso_date, subject = line.split("\x1f", 2)
        commits.append(
            {
                "hash": commit_hash,
                "date": datetime.fromisoformat(iso_date),
                "subject": subject,
            }
        )
    return commits


def _ordinal(day):
    if 11 <= day <= 13:
        return f"{day}th"
    return f"{day}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(day % 10, 'th') }"


def format_date(dt):
    """Format a datetime as e.g. ``3rd April 2026``."""
    if dt is None:
        return "unreleased"
    return f"{_ordinal(dt.day)} {dt.strftime('%B %Y')}"


def collect_tools():
    """Build a list of tool metadata dicts, newest change first."""
    tools = []
    for filename in find_tools():
        commits = git_log(filename)
        dates = [c["date"] for c in commits]
        tools.append(
            {
                "filename": filename,
                "slug": filename[:-5],
                "title": get_title(filename),
                "commits": commits,
                "created": min(dates) if dates else None,
                "updated": max(dates) if dates else None,
            }
        )
    tools.sort(
        key=lambda t: t["updated"] or datetime.min.replace(tzinfo=None),
        reverse=True,
    )
    return tools


def esc(text):
    return html.escape(text, quote=True)


STYLE = """
  :root {
    --bg: #f7f5f2;
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --card: #ffffff;
    --border: #e4e0da;
    --accent: #6d28d9;
    --accent-2: #9333ea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17151c;
      --fg: #ececf1;
      --muted: #9a96a6;
      --card: #211e29;
      --border: #322d3d;
      --accent: #a78bfa;
      --accent-2: #c084fc;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
  }
  nav {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    padding: 1rem 1.25rem;
    display: flex;
    gap: 1.25rem;
    align-items: baseline;
  }
  nav a { color: #fff; text-decoration: none; font-weight: 600; }
  nav a:hover { text-decoration: underline; }
  nav .brand { font-size: 1.15rem; margin-right: auto; }
  main { max-width: 820px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  h1 { margin: 1rem 0 0.25rem; }
  .subtitle { color: var(--muted); margin: 0 0 2rem; }
  a { color: var(--accent); }
""".rstrip()


def page(title, active, body):
    """Wrap ``body`` HTML in the shared chrome (nav + layout)."""
    def link(href, label, key):
        current = ' aria-current="page"' if key == active else ""
        return f'<a href="{href}"{current}>{label}</a>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>{STYLE}</style>
</head>
<body>
<nav>
  <a class="brand" href="./">🛠️ tools</a>
  {link("./", "Home", "index")}
  {link("colophon.html", "Colophon", "colophon")}
</nav>
<main>
{body}
</main>
</body>
</html>
"""

