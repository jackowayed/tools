#!/bin/sh
# Regenerate the homepage and colophon from the tool files + git history.
set -e
cd "$(dirname "$0")"
python3 build_index.py
python3 build_colophon.py
