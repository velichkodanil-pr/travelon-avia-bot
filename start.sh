#!/usr/bin/env bash
# Start a virtual X display, then run the AVIA bot HEADED. The TravelON chat
# composer only actually transmits the message under real (headed) rendering —
# pure headless clicks Send but posts nothing. An explicit Xvfb here avoids the
# xvfb-run argument-quoting/hang issues seen on Railway.
set -e
rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
# give Xvfb a moment to accept connections
sleep 2
exec node src/index.js
