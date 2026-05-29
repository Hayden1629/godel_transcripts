#!/bin/bash
# Launches Chrome with remote debugging so Playwright can connect to it.
# A separate profile dir is used so it doesn't conflict with your normal Chrome.
# Login session is saved between runs.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$SCRIPT_DIR/chrome-profile"

echo "Opening Chrome with remote debugging on port 9222..."
echo "Log in at https://app.godelterminal.com/, then run: npm start"
echo ""

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "https://app.godelterminal.com/" &

