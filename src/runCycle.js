// One full AVIA pass: login -> per supplier filter+scan today's requests ->
// per request: dedup -> open chat -> choose Авіа + subject -> verify auto-fill
// -> send (unless dry-run) -> report.
import {
  AviaClient,
  todayISOInTz,
  ddmmyyyyToISO,
  matchedExcludedHotel,
  isCancelledStatus,
} from './travelon.js';
import { config } from './config.js';
import { log } from './logger.js';
import { wasSent, markSent } from './store.js';
import { notify, notifyEnabled } from './notify.js';
import { reportEnabled, upsertRows, writeHeartbeat } from './report.js';

const DASH = '—';

// Reject if `p` doesn't settle within `ms`, so one hung Playwright call can't
// freeze a whole cycle. The underlying op is abandoned (not truly cancelled);
// the cycle watchdog in index.js is the final safety net.
function withTimeout(p, ms, label) {
  let t;
  const guard = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

function matchesBookingDate(iso, today) {
  if (!iso) return false;
  return config.bookingDateMode === 'today_or_later' ? iso >= today : iso === today;
}

// Keep a row only if: it has a 5-digit id, it is NOT cancelled, its status is
// one of the targets, and its booking (request) date matches today. Skips are
// logged only for TODAY's rows (older rows on the page are just noise).
export function parseRow(row, supplierName, today) {
  const flat = row.text || '';
  const idM = flat.match(/\b(\d{5})\b/);
  if (!idM) return null;
  const iso = ddmmyyyyToISO(row.bookingDate);
  const isToday = matchesBookingDate(iso, today);
  // Hard exclusion by hotel name (e.g. Work&Travelon / ON TRIP) — these must
  // never receive the regular-flight message.
  const badHotel = matchedExcludedHotel(flat, config.hotelExcludes);
  if (badHotel) {
    if (isToday) log.info(`Skip ${idM[1]}: hotel excluded ("${badHotel}").`);
    return null;
  }
  const status = (row.status || '').trim();
  const sl = status.toLowerCase();
  // Never message a cancelled booking (Анульовано / Canceled / ...). The list is
  // already requested WITHOUT cancelled status ids; this is the second guard.
  if (isCancelledStatus(status, config.excludeStatuses)) {
    if (isToday) log.info(`Skip ${idM[1]}: cancelled ("${status}").`);
    return null;
  }
  // Empty allow-list = accept every (non-excluded) status.
  const okStatus =
    config.targetStatuses.length === 0 ||
    config.targetStatuses.some((s) => s.toLowerCase() === sl);
  if (!okStatus) return null;
  if (!isToday) return null;
  return { id: idM[1], supplier: supplierName, status, bookingDateISO: iso };
}

// The list is sorted newest-first (verified live: ids AND request dates descend
// across pages). The next page can hold today's bookings only if THIS page's
// last dated row is still today; rows without a date (the per-page totals row)
// are ignored. For testing.
export function needNextPage(rows, today) {
  let last = null;
  for (const r of rows || []) {
    const iso = ddmmyyyyToISO(r && r.bookingDate);
    if (iso) last = iso;
  }
  return Boolean(last) && matchesBookingDate(last, today);
}

const mkRow = (c, o = {}) => ({
  bookingId: c.id,
  supplier: c.supplier,
  bookingStatus: c.status,
  bookingDate: c.bookingDateISO || '',
  sent: '',
  result: '',
  note: '',
  ...o,
});

export async function runCycle() {
  const startedAt = new Date();
  const summary = {
    dryRun: config.dryRun,
    matched: [],
    sent: [],
    wouldSend: [],
    skippedAlready: [],
    skippedStore: [],
    mismatch: [],
    errors: [],
  };
  const rowsForReport = [];
  const candidates = [];
  const client = new AviaClient();

  try {
    await client.init();
    await client.login();
    await client.openRequests();
    const today = todayISOInTz(config.tz);

    // Resolve supplier names -> partner IDs and the status filter: every status
    // EXCEPT cancelled (Анульовано = id 5), so cancelled bookings never come back.
    const suppliers = await client.resolveSupplierIds(config.supplierNames);
    const st = await client.resolveScanStatusIds({
      allow: config.targetStatuses,
      exclude: config.excludeStatuses,
      excludeIds: config.excludeStatusIds,
    });
    // Fail-safe: an EMPTY status filter makes Travelon return every status,
    // cancelled included — never scan unfiltered.
    if (!st.ids.length) {
      throw new Error(
        `status filter: no status ids resolved (${st.total} options) — refusing to scan unfiltered`
      );
    }
    if (!st.dropped.length) {
      log.warn('Status filter: no cancelled status found in the dropdown — check AVIA_EXCLUDE_STATUS_IDS.');
    }
    const statusIds = st.ids;
    log.info('Suppliers: ' + suppliers.map((s) => `${s.name}=${s.id ?? 'NOT FOUND'}`).join(', '));
    log.info(
      `Status IDs: ${statusIds.join(',')} (excluded: ${st.dropped.join(', ') || DASH}) | today=${today} (${config.bookingDateMode})`
    );

    // Scan each supplier's list, keeping today's matching requests (dedup by id).
    const seen = new Set();
    for (const sup of suppliers) {
      if (!sup.id) {
        summary.errors.push(`supplier "${sup.name}" not found in dropdown`);
        log.warn(`Supplier "${sup.name}" not found in the partner dropdown — skipping.`);
        continue;
      }
      try {
        await withTimeout(
          (async () => {
            await client.applySupplierFilter(sup.id, statusIds);
            let prevFirstId = null;
            let supCount = 0;
            for (let page = 1; page <= config.maxListPages; page++) {
              if (page > 1) await client.goToPage(page);
              const rows = await client.scanRows();
              const ids = rows.map((r) => (r.text.match(/\b(\d{5})\b/) || [])[1]).filter(Boolean);
              if (!ids.length) break;
              if (prevFirstId && ids[0] === prevFirstId) break; // same page repeated -> end
              prevFirstId = ids[0];
              for (const r of rows) {
                const c = parseRow(r, sup.name, today);
                if (!c) continue;
                if (!seen.has(c.id)) {
                  seen.add(c.id);
                  candidates.push(c);
                  supCount += 1;
                }
              }
              // List is date-desc: open the next page only while this one still
              // ends with today's bookings (each page is ~2 MB to load).
              if (!needNextPage(rows, today)) break;
            }
            log.info(`${sup.name}: ${supCount} request(s) today`);
          })(),
          config.supplierScanTimeoutMs,
          `scan ${sup.name}`
        );
      } catch (err) {
        summary.errors.push(`scan ${sup.name}: ${err.message}`);
        log.warn(`Supplier ${sup.name} scan failed/timed out — skipping: ${err.message}`);
      }
    }
    summary.matched = candidates.map((c) => `${c.id}/${c.supplier}`);
    log.info(`Matched ${candidates.length}: ${summary.matched.join(', ') || DASH}`);

    // Process each candidate.
    let sends = 0;
    for (const c of candidates) {
      try {
        if (await wasSent(c.id)) {
          summary.skippedStore.push(c.id);
          // keep: an existing "так" row is left untouched (original result,
          // send time and brutto note survive); only missing rows are added.
          rowsForReport.push(mkRow(c, { sent: 'так', result: 'Надіслано раніше (журнал)', keep: true }));
          log.info(`Skip ${c.id}: already messaged on a previous run.`);
          continue;
        }

        // Pick the message profile by supplier: JETIT (+ UAH) -> pegasus
        // (subject 84 + transport BRUTTO amount); everyone else -> regular.
        const isPegasus = config.pegasusSuppliers.some(
          (n) => n.toLowerCase() === c.supplier.toLowerCase()
        );
        const prof = isPegasus ? config.message.pegasus : config.message.regular;

        // Pegasus: the penalty is the transport BRUTTO — the Agency column of the
        // Транспорт row in "Prices by modules" (what "Сума брутто" sums up), NOT
        // the net cost. If it can't be read we do NOT send: a blank or wrong
        // penalty is worse than retrying on the next cycle.
        let transportNet = '';
        if (prof.fillTransportNet) {
          await client.openEdit(c.id);
          transportNet = await client.readTransportAmount(prof.amountField);
          if (!transportNet) {
            summary.errors.push(`${c.id}: transport brutto not found`);
            rowsForReport.push(
              mkRow(c, { sent: 'ні', result: 'Брутто транспорту не знайдено — НЕ надіслано' })
            );
            log.warn(`${c.id}: transport ${prof.amountField} not found (Pegasus) — NOT sent, will retry.`);
            continue;
          }
          log.info(`${c.id}: Transport brutto (${prof.amountField}) = ${transportNet} (Pegasus).`);
        }

        await client.openChat(c.id);

        if (await client.chatAlreadySent()) {
          summary.skippedAlready.push(c.id);
          if (!config.dryRun) await markSent(c.id, { supplier: c.supplier, reason: 'already-in-chat' });
          rowsForReport.push(mkRow(c, { sent: 'так', result: 'Вже надіслано у чаті', keep: true }));
          log.info(`Skip ${c.id}: AVIA message already present in chat.`);
          await client.closeChat();
          continue;
        }

        const sendArgs = {
          bundleId: c.id,
          department: prof.department,
          subject: prof.subject,
          subjectRe: prof.subjectRe,
          expectedContains: prof.expectedContains,
          audience: config.message.audience,
          transportNet,
        };

        if (config.dryRun) {
          const res = await client.verifyAndSendAvia({ ...sendArgs, dryRun: true });
          if (res.verified) {
            summary.wouldSend.push(c.id);
            rowsForReport.push(mkRow(c, { sent: 'DRY-RUN', result: 'Відправив би (текст ОК)' }));
            log.info(`[DRY-RUN] Would send to ${c.id} (${c.supplier}); auto-fill verified.`);
          } else {
            summary.mismatch.push(c.id);
            rowsForReport.push(
              mkRow(c, {
                sent: 'ні',
                result: 'Текст не співпав — НЕ надіслав би',
                note: (res.filled || '').slice(0, 80),
              })
            );
            log.warn(`[DRY-RUN] ${c.id}: auto-fill text did NOT match — would skip.`);
          }
          await client.closeChat();
          continue;
        }

        if (sends >= config.maxSendsPerRun) {
          log.warn(`Reached MAX_SENDS_PER_RUN=${config.maxSendsPerRun}; stopping sends.`);
          await client.closeChat();
          break;
        }

        const res = await client.verifyAndSendAvia({ ...sendArgs, dryRun: false });
        if (!res.verified) {
          summary.mismatch.push(c.id);
          rowsForReport.push(
            mkRow(c, {
              sent: 'ні',
              result: 'Текст не співпав — НЕ надіслано',
              note: (res.filled || '').slice(0, 80),
            })
          );
          log.warn(`${c.id}: auto-fill text did NOT match expected phrase — NOT sent.`);
          await client.closeChat();
          continue;
        }
        if (res.sent) {
          await markSent(c.id, { supplier: c.supplier });
          sends += 1;
          summary.sent.push(c.id);
          rowsForReport.push(
            mkRow(c, {
              sent: 'так',
              result: isPegasus ? 'Надіслано (Pegasus)' : 'Надіслано',
              note: isPegasus && transportNet ? `Брутто транспорт: ${transportNet}` : '',
            })
          );
          log.info(`Sent to ${c.id} (${c.supplier})${isPegasus ? ' [Pegasus]' : ''}.`);
        } else {
          summary.errors.push(`${c.id}: send not confirmed`);
          rowsForReport.push(mkRow(c, { sent: 'ні', result: 'Send не підтверджено — повтор' }));
          log.warn(`${c.id}: verified but send NOT confirmed — will retry next cycle.`);
        }
        await client.closeChat();
      } catch (err) {
        summary.errors.push(`${c.id}: ${err.message}`);
        log.error(`Request ${c.id} failed:`, err.message);
        await client.screenshot(`req-${c.id}-error`);
        rowsForReport.push(mkRow(c, { sent: 'ні', result: 'Помилка', note: err.message }));
        await client.closeChat().catch(() => {});
      }
    }
  } catch (err) {
    summary.errors.push(`cycle: ${err.message}`);
    log.error('Cycle failed:', err.message);
    await client.screenshot('cycle-error');
  } finally {
    await client.close();
  }

  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  const lines = [
    `TravelON AVIA bot cycle ${config.dryRun ? '[DRY-RUN]' : '[LIVE]'} — ${took}s`,
    `Matched: ${summary.matched.length} (${summary.matched.join(', ') || DASH})`,
    config.dryRun
      ? `Would send: ${summary.wouldSend.join(', ') || DASH}`
      : `Sent: ${summary.sent.join(', ') || DASH}`,
    `Text mismatch (not sent): ${summary.mismatch.join(', ') || DASH}`,
    `Skipped (already in chat): ${summary.skippedAlready.join(', ') || DASH}`,
    `Skipped (sent before): ${summary.skippedStore.join(', ') || DASH}`,
    `Errors: ${summary.errors.join(' | ') || DASH}`,
  ];
  let report = lines.join('\n');
  log.info('Cycle summary:\n' + report);
  if (notifyEnabled()) await notify(report);

  // Google Sheet tracker (best-effort; never breaks the cycle).
  if (reportEnabled()) {
    try {
      const res = await upsertRows(rowsForReport);
      log.info(
        `Report: Google Sheet — ${res.updated} оновлено, ${res.appended} додано, ${res.kept || 0} без змін.`
      );
    } catch (e) {
      log.warn('Report update failed (continuing): ' + e.message);
    }

    // Liveness heartbeat — proof the bot is alive even on quiet cycles.
    await writeHeartbeat({
      mode: config.dryRun ? 'DRY-RUN' : 'LIVE',
      took,
      matched: summary.matched.length,
      sent: config.dryRun ? summary.wouldSend.length : summary.sent.length,
      errors: summary.errors,
      cycleFailed: summary.errors.some((e) => e.startsWith('cycle:')),
    });
  }

  return summary;
}
