#!/usr/bin/env bash
# Installs the Expo SDK and the exact native module versions that match it.
set -euo pipefail
npm install
npx expo install react react-native expo-audio expo-secure-store expo-status-bar expo-linear-gradient \
  expo-document-picker expo-file-system @expo/vector-icons @react-native-async-storage/async-storage \
  react-native-safe-area-context
npx expo install typescript @types/react -- --save-dev
npx expo install --fix
echo
echo "Done. Plug in your phone (USB debugging on) or start an emulator, then run:  npm run android"
