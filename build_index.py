#!/usr/bin/env python3
"""Generate index.html — the homepage listing every tool.

Simplified counterpart to Simon Willison's build_index.py. Each tool is
discovered from the ``.html`` files in this directory; the list is sorted
by most recently changed (from git history).
"""

from build_common import collect_tools, esc, format_date, page, ROOT


def build():
    tools = collect_tools()

    rows = []
    for tool in tools:
        updated = format_date(tool["updated"])
        rows.append(
            f"""    <li class="tool">
      <a class="tool-link" href="{esc(tool['filename'])}">{esc(tool['title'])}</a>
      <span class="meta">updated {esc(updated)} ·
        <a href="colophon.html#{esc(tool['slug'])}">history</a></span>
    </li>"""
        )

    count = len(tools)
    body = f"""<h1>Tools</h1>
<p class="subtitle">A little collection of {count} single-page tools.
Spiritual successor to <a href="https://tools.simonwillison.net/">Simon
Willison's tools</a>.</p>
<ul class="tools">
{chr(10).join(rows)}
</ul>
<style>
  .tools {{ list-style: none; padding: 0; margin: 0; }}
  .tool {{
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--border);
  }}
  .tool-link {{ font-size: 1.15rem; font-weight: 600; text-decoration: none; }}
  .tool-link:hover {{ text-decoration: underline; }}
  .meta {{ display: block; color: var(--muted); font-size: 0.85rem; margin-top: 0.15rem; }}
  .meta a {{ color: var(--muted); }}
</style>"""

    out = ROOT / "index.html"
    out.write_text(page("Tools", "index", body), encoding="utf-8")
    print(f"Wrote {out.name} ({count} tools)")


if __name__ == "__main__":
    build()
