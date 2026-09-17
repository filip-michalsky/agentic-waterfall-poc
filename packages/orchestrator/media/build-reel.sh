#!/usr/bin/env bash
# One story in three social formats. Recordings and exports stay local.
set -euo pipefail
python3 "$(dirname "$0")/render-story.py" "$@"
