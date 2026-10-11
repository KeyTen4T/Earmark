#!/usr/bin/env bash
# One-time setup after cloning Earmark onto another Linux Mint / Ubuntu computer.
# Run from the project folder:  bash new-machine.sh
# Safe to re-run. See "Moving to another computer" in README.md for the steps this can't do for you.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Build tools (Node, Java 17, Android SDK) and the app's packages"
bash ./install-prereqs.sh

# install-prereqs.sh installs Node through nvm in its own shell; load it here too, or npm is not found.
export NVM_DIR="$HOME/.nvm"
set +u; . "$NVM_DIR/nvm.sh"; set -u

echo "==> Desktop app packages"
npm --prefix desktop install

echo "==> Android project (android/ is not stored in git; it is generated from app.json)"
[ -d android ] || npx expo prebuild --platform android --no-install
# Point Gradle at the SDK, so the build works even in a shell that has not loaded ~/.bashrc.
[ -f android/local.properties ] || echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties

echo "==> ocd: the wrapper Claude Code uses to hand work to opencode"
mkdir -p "$HOME/.local/bin"
install -m 755 tools/ocd/ocd "$HOME/.local/bin/ocd"
# Claude's instructions for every project; not overwritten if this machine already has its own
mkdir -p "$HOME/.claude"
if [ -e "$HOME/.claude/CLAUDE.md" ] && ! cmp -s tools/ocd/CLAUDE.global.md "$HOME/.claude/CLAUDE.md"; then
  echo "    ~/.claude/CLAUDE.md exists and differs from tools/ocd/CLAUDE.global.md; left as is"
else
  install -m 644 tools/ocd/CLAUDE.global.md "$HOME/.claude/CLAUDE.md"
fi

echo "==> Read-along tool"
bash tools/readalong/setup.sh

echo
if [ -z "$(git config --global user.email || true)" ]; then
  echo "git has no name/email on this computer, so commits will fail. Set them once:"
  echo "  git config --global user.name \"Your Name\" && git config --global user.email you@example.com"
fi
if grep -q PASTE "$HOME/.config/earmark-readalong/config.json" 2>/dev/null; then
  echo "The read-along tool still has the placeholder TorBox key in ~/.config/earmark-readalong/config.json"
fi
echo "Done. Still to do by hand (see README.md): install OpenCode and sign in, then check with"
echo "  ocd -C \"\$PWD\" --plan \"Reply with exactly: pong\""
