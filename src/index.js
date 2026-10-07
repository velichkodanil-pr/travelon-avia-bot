// Entry point: validate config, run once at startup, then schedule every N min.
import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { log } from './logger.js';
import { runCycle } from './runCycle.js';

let running = false;
let consecutiveBrowserFails = 0;
const START_AT = Date.now();

// Errors meaning Chromium could not launch/operate — typically resource
// exhaustion on a long-lived container. A fresh process fixes it, so we exit and
// let Railway relaunch. The watchdog covers HANGS; this covers FAST-FAIL launch
// errors (which complete in <1s, so the watchdog never fires).
const BROWSER_FAIL_RE =
  /browserType\.launch|browserContext\.newPage|Target (page|context|browser)|pthread_create|Resource temporarily unavailable|Failed to launch|has been closed|Cannot allocate memory/i;

async function safeRun(trigger) {
  if (running) {
    log.warn(`Cycle still running — skipping this ${trigger} tick.`);
    return;
  }
  running = true;
  let watchdog;
  try {
    const summary = await Promise.race([
      runCycle(),
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`cycle exceeded ${config.cycleTimeoutMs}ms watchdog`)),
          config.cycleTimeoutMs
        );
      }),
    ]);
    // Auto-heal: if the browser can't launch/operate (usually resource
    // exhaustion after long uptime), exit after a few tries so Railway
    // relaunches with a fresh container. These cycles fail in <1s, so the
    // watchdog never catches them — hence this explicit check.
    const errs = (summary && summary.errors) || [];
    if (errs.some((e) => BROWSER_FAIL_RE.test(String(e)))) {
      consecutiveBrowserFails += 1;
      log.error(`Browser launch/operate failure #${consecutiveBrowserFails}: ${errs.join(' | ')}`);
      if (consecutiveBrowserFails >= config.browserFailRestartThreshold) {
        log.error('Browser cannot start (likely resource exhaustion) — exiting so the platform restarts with a fresh container.');
        clearTimeout(watchdog);
        process.exit(1);
      }
    } else {
      consecutiveBrowserFails = 0;
    }
  } catch (err) {
    log.error('Unhandled cycle error:', err);
    if (String((err && err.message) || '').includes('watchdog')) {
      // A hung Playwright/browser op can't be reliably cleared in-process, so
      // exit and let Railway relaunch with a fresh browser. The lock resets too.
      log.error('Cycle watchdog fired — exiting so the platform restarts the bot.');
      clearTimeout(watchdog);
      process.exit(1);
    }
  } finally {
    clearTimeout(watchdog);
    running = false;
  }

  // Preemptive periodic restart: before a multi-day container leaks enough to
  // break Chromium, exit after maxUptimeMs of uptime so Railway starts fresh.
  if (config.maxUptimeMs > 0 && Date.now() - START_AT > config.maxUptimeMs) {
    log.info(`Uptime over ${config.maxUptimeMs}ms — exiting for a fresh container (preempt resource leak).`);
    process.exit(1);
  }
}

async function main() {
  const problems = validateConfig();
  if (problems.length) {
    log.error('Configuration problems:\n - ' + problems.join('\n - '));
    log.error('Set the required environment variables and restart.');
    process.exit(1);
  }

  log.info('============================================================');
  log.info(' TravelON AVIA message bot');
  log.info(` mode      : ${config.dryRun ? 'DRY-RUN (no messages sent)' : 'LIVE (will send)'}`);
  log.info(` schedule  : "${config.checkCron}"  tz=${config.tz}`);
  log.info(` suppliers : ${config.supplierNames.join(', ')}`);
  log.info(
    ` statuses  : ${
      config.targetStatuses.length
        ? config.targetStatuses.join(', ')
        : `ALL except cancelled (ids ${config.excludeStatusIds.join(',')}; ${config.excludeStatuses.join('/')}/Анульовано)`
    }`
  );
  log.info(` watchdog  : cycle ${config.cycleTimeoutMs}ms | supplier ${config.supplierScanTimeoutMs}ms`);
  log.info(` bookingDt : ${config.bookingDateMode}`);
  log.info(` dept(r)   : ${config.message.regular.department}`);
  log.info(` subject(r): ${config.message.regular.subject}`);
  log.info(` dept(p)   : ${config.message.pegasus.department}`);
  log.info(` subject(p): ${config.message.pegasus.subject}`);
  log.info(` pegasus   : ${config.pegasusSuppliers.join(', ')}`);
  log.info(` report    : ${config.report.enabled ? 'ON' : 'off'} (tab "${config.report.sheetName}")`);
  log.info('============================================================');

  await safeRun('startup');

  if (config.runOnce) {
    log.info('RUN_ONCE=true — exiting after a single cycle.');
    process.exit(0);
  }

  if (!cron.validate(config.checkCron)) {
    log.error(`Invalid CHECK_CRON: "${config.checkCron}"`);
    process.exit(1);
  }

  cron.schedule(config.checkCron, () => safeRun('scheduled'), { timezone: config.tz });
  log.info('Scheduler armed; running 24/7. Waiting for next tick…');
}

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down.');
  process.exit(0);
});
process.on('SIGINT', () => {
  log.info('SIGINT received — shutting down.');
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});

main();
