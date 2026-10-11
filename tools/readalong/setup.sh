#!/usr/bin/env bash
# Sets up the read-along tool: an isolated Python environment with speech recognition (GPU if an
# NVIDIA card and driver are present) and a private config file for your TorBox key.
# Safe to re-run.
set -euo pipefail
HOME_DIR="$HOME/.local/share/earmark-readalong"
CONF_DIR="$HOME/.config/earmark-readalong"
mkdir -p "$HOME_DIR" "$CONF_DIR"
command -v ffmpeg >/dev/null || { echo "ffmpeg is missing: sudo apt-get install -y ffmpeg"; exit 1; }
[ -x "$HOME_DIR/venv/bin/python" ] || python3 -m venv "$HOME_DIR/venv"
"$HOME_DIR/venv/bin/pip" install -q --upgrade pip
"$HOME_DIR/venv/bin/pip" install -q faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10" \
  rapidfuzz beautifulsoup4 lxml requests
if [ ! -f "$CONF_DIR/config.json" ]; then
  printf '{\n  "torbox_api_key": "PASTE-YOUR-TORBOX-KEY-HERE",\n  "ebook_search_url": ""\n}\n' > "$CONF_DIR/config.json"
  chmod 600 "$CONF_DIR/config.json"
  echo "Now put your TorBox key in $CONF_DIR/config.json (replace only the PASTE-... text, keep the quotes)."
  echo "Set ebook_search_url there to use the ebook-search command."
fi
echo "Ready. Run it with: $HOME_DIR/venv/bin/python tools/readalong/readalong.py --help"
