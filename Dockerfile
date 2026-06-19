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

# Long-running worker: node-cron keeps it alive and fires every 5 min.
CMD ["node", "src/index.js"]
