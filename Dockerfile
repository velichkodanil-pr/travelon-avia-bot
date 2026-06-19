# ----------------------------------------------------------------------------
#  Playwright's official image already contains Chromium + all system libs.
#  Keep this tag's version in sync with the "playwright" version in
#  package.json (currently 1.47.2). If you bump one, bump the other.
# ----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Persisted runtime data (sent-IDs, screenshots). Mount a Railway Volume here
# to keep state across restarts (optional — the in-chat duplicate check still
# prevents double-sends even without it).
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

# Run the browser HEADED inside a virtual display (Xvfb). The TravelON chat
# composer only actually transmits the message with real (headed) rendering;
# pure headless clicked Send but posted nothing (confirmed: the identical click
# works headed, no-ops headless). Xvfb ships with the Playwright image; install
# defensively in case it's missing.
RUN which xvfb-run >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*)
ENV HEADLESS=false

# Long-running worker: node-cron keeps it alive and fires every 5 min.
# xvfb-run gives Chromium a real (virtual) display so headed mode works.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "node", "src/index.js"]
