#!/usr/bin/env bash
# Installs everything needed to build Earmark on Linux Mint / Ubuntu, then installs the app's packages.
#   Node.js 22 (via nvm), Java 17, Android SDK command-line tools, platform-tools (adb), Android 35 SDK.
# Safe to re-run: steps that are already done are skipped.
set -euo pipefail

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$HOME/Android/Sdk"
CMDLINE_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
NVM_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"
BASHRC="$HOME/.bashrc"

# ---------- 1. System packages (needs your password once) ----------
say "Installing system packages: Java 17, unzip, curl, git, ffmpeg, Python venv, Android USB rules"
sudo apt-get update
sudo apt-get install -y curl unzip git ffmpeg python3-venv openjdk-17-jdk-headless android-sdk-platform-tools-common
# Use Java 17 specifically, even if another Java is the system default.
JAVA_HOME_PATH="$(ls -d /usr/lib/jvm/java-17-openjdk-* 2>/dev/null | head -1)"
[ -n "$JAVA_HOME_PATH" ] || die "Java 17 didn't install; check the apt output above."
export JAVA_HOME="$JAVA_HOME_PATH"
ok "Java: $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# Let your user talk to Android phones over USB
if ! id -nG "$USER" | grep -qw plugdev; then
  sudo usermod -aG plugdev "$USER" && ok "Added you to the plugdev group (takes effect after logging out and back in)"
fi

# ---------- 2. Node.js via nvm ----------
say "Installing Node.js 22 (LTS)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL "$NVM_URL" | bash
fi
set +u   # nvm doesn't work with "unset variable" checking
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
ok "Node $(node -v), npm $(npm -v)"

# ---------- 3. Android SDK ----------
say "Installing the Android SDK into $SDK"
mkdir -p "$SDK/cmdline-tools"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  if ! curl -fL "$CMDLINE_URL" -o "$tmp/clt.zip"; then
    die "Couldn't download the Android command-line tools.
   Open https://developer.android.com/studio#command-line-tools-only, copy the Linux download link,
   then re-run:  CMDLINE_URL=<that link> bash install-prereqs.sh"
  fi
  unzip -q "$tmp/clt.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
fi
export ANDROID_HOME="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"

yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0"
yes | sdkmanager --licenses >/dev/null || true
ok "Android SDK ready ($(adb version | head -1))"

# ---------- 4. Environment variables for future terminals ----------
say "Saving environment variables to $BASHRC"
if ! grep -q '# >>> earmark android env >>>' "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" <<EOF

# >>> earmark android env >>>
export JAVA_HOME="$JAVA_HOME"
export ANDROID_HOME="\$HOME/Android/Sdk"
export PATH="\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH"
# <<< earmark android env <<<
EOF
  ok "Added. New terminals will pick them up."
else
  ok "Already there."
fi

# ---------- 5. Project packages ----------
say "Installing Earmark's packages"
cd "$PROJECT_DIR"
bash ./setup.sh

say "All set!"
cat <<'EOF'
Next:
  1. On your phone: Settings → About phone → tap "Build number" 7 times,
     then Settings → System → Developer options → turn on "USB debugging".
  2. Plug the phone in and accept the "Allow USB debugging?" prompt.
  3. Open a NEW terminal in this folder and run:
        adb devices        (your phone should be listed as "device")
        npm run android    (first build takes 5–15 minutes; Gradle downloads the rest)
EOF
