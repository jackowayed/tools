#!/usr/bin/env python3
"""Generate colophon.html — the development history of every tool.

Simplified counterpart to Simon Willison's build_colophon.py. For each
tool it lists the git commit messages that touched it, newest first, so
the page is a transparent record of how each tool came to be.
"""

import re

from build_common import collect_tools, esc, format_date, page, ROOT

URL_RE = re.compile(r"(https?://[^\s<]+)")


def format_message(message):
    """Escape a commit message and linkify any URLs it contains."""
    escaped = esc(message)
    return URL_RE.sub(r'<a href="\1">\1</a>', escaped)


def build():
    tools = collect_tools()

    sections = []
    for tool in tools:
        commits = tool["commits"]
        if commits:
            items = "\n".join(
                f"""        <li>
          <span class="commit-date">{esc(format_date(c['date']))}</span>
          <span class="commit-msg">{format_message(c['subject'])}</span>
          <code class="commit-hash">{esc(c['hash'])}</code>
        </li>"""
                for c in commits
            )
            history = f"""      <ul class="commits">
{items}
      </ul>"""
        else:
            history = '      <p class="no-history">Not yet committed to git.</p>'

        sections.append(
            f"""  <section class="entry" id="{esc(tool['slug'])}">
    <h2><a href="{esc(tool['filename'])}">{esc(tool['title'])}</a></h2>
    <p class="entry-meta">
      Added {esc(format_date(tool['created']))} ·
      {len(commits)} commit{'s' if len(commits) != 1 else ''}
    </p>
{history}
  </section>"""
        )

    body = f"""<h1>Colophon</h1>
<p class="subtitle">How each tool was built, straight from the git log.
{len(tools)} tools in total.</p>
{chr(10).join(sections)}
<style>
  .entry {{ padding: 1.25rem 0; border-bottom: 1px solid var(--border); }}
  .entry:target {{
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 8px;
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }}
  .entry h2 {{ margin: 0 0 0.25rem; }}
  .entry h2 a {{ text-decoration: none; }}
  .entry h2 a:hover {{ text-decoration: underline; }}
  .entry-meta {{ color: var(--muted); font-size: 0.85rem; margin: 0 0 0.75rem; }}
  .commits {{ list-style: none; padding: 0; margin: 0; }}
  .commits li {{
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.35rem 0;
    font-size: 0.92rem;
  }}
  .commit-date {{ color: var(--muted); white-space: nowrap; font-size: 0.82rem; }}
  .commit-hash {{ color: var(--muted); font-size: 0.8rem; }}
  .no-history {{ color: var(--muted); font-style: italic; }}
  @media (max-width: 560px) {{
    .commits li {{ grid-template-columns: 1fr; gap: 0.1rem; }}
  }}
</style>"""

    out = ROOT / "colophon.html"
    out.write_text(page("Colophon", "colophon", body), encoding="utf-8")
    print(f"Wrote {out.name} ({len(tools)} tools)")


if __name__ == "__main__":
    build()
