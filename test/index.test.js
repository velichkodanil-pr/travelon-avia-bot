// Process level: a (re)start does not run a cycle, an idle SIGTERM exits at
// once, RUN_ONCE still runs one cycle. Nothing can reach the real site: dummy
// credentials, every URL points at a closed local port, the cron never fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEAD = 'http://127.0.0.1:9';

function startBot(extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.tmpdir(),
    TRAVELON_EMAIL: 'test@example.invalid',
    TRAVELON_PASSWORD: 'x',
    TRAVELON_BASE_URL: DEAD,
    TRAVELON_LOGIN_URL: `${DEAD}/auth`,
    TRAVELON_REQUESTS_URL: `${DEAD}/book/bundle/index`,
    CHECK_CRON: '0 0 1 1 *', // 1 January only — never fires during the test
    DRY_RUN: 'true',
    REPORT_ENABLED: 'false',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    SCREENSHOT_ON_ERROR: 'false',
    NAV_TIMEOUT_MS: '3000',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'avia-index-')),
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = async (re, ms = 10000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; output:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, exited, waitFor, output: () => out };
}

test('a (re)start waits for the schedule; SIGTERM while idle exits at once', async () => {
  const bot = startBot();
  await bot.waitFor(/Scheduler armed/);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(bot.output(), /startup\s+: wait for the schedule/);
  assert.doesNotMatch(bot.output(), /Logging in|Cycle summary/, 'no cycle at startup');
  const t0 = Date.now();
  bot.child.kill('SIGTERM');
  assert.equal(await bot.exited, 0);
  assert.ok(Date.now() - t0 < 3000, `exit took ${Date.now() - t0} ms`);
  assert.match(bot.output(), /SIGTERM received — idle, shutting down/);
});

test('RUN_ONCE=true still runs exactly one cycle at startup, then exits', async () => {
  const bot = startBot({ RUN_ONCE: 'true' });
  const code = await bot.exited;
  assert.equal(code, 0, bot.output());
  assert.match(bot.output(), /Cycle summary/);
  assert.match(bot.output(), /RUN_ONCE=true — exiting after a single cycle/);
  assert.doesNotMatch(bot.output(), /Scheduler armed/);
});
