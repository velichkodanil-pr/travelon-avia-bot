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

RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

# Run the browser HEADED inside a virtual display (Xvfb). The TravelON chat
# composer only transmits with real rendering; pure headless no-ops the Send.
# Ensure the Xvfb binary exists (it ships with the Playwright image; install
# defensively just in case).
RUN which Xvfb >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*)
ENV HEADLESS=false

# start.sh launches Xvfb (DISPLAY=:99) then node — quoting-proof (no xvfb-run).
CMD ["bash", "start.sh"]
