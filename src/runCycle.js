// One full AVIA pass: login -> per supplier filter+scan today's requests ->
// per request: dedup -> open chat -> choose Авіа + subject -> verify auto-fill
// -> send (unless dry-run) -> report.
import { AviaClient, todayISOInTz, ddmmyyyyToISO } from './travelon.js';
import { config } from './config.js';
import { log } from './logger.js';
import { wasSent, markSent } from './store.js';
import { notify, notifyEnabled } from './notify.js';
import { reportEnabled, upsertRows } from './report.js';

const DASH = '—';

function matchesBookingDate(iso, today) {
  if (!iso) return false;
  return config.bookingDateMode === 'today_or_later' ? iso >= today : iso === today;
}

// Keep a row only if: it has a 5-digit id, its status is one of the targets,
// and its booking (request) date matches today (per AVIA_BOOKING_DATE).
function parseRow(row, supplierName, today) {
  const flat = row.text || '';
  const idM = flat.match(/\b(\d{5})\b/);
  if (!idM) return null;
  const status = (row.status || '').trim();
  const okStatus = config.targetStatuses.some((s) => s.toLowerCase() === status.toLowerCase());
  if (!okStatus) return null;
  const iso = ddmmyyyyToISO(row.bookingDate);
  if (!matchesBookingDate(iso, today)) return null;
  return { id: idM[1], supplier: supplierName, status, bookingDateISO: iso };
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

    // Resolve supplier names -> partner IDs and status labels -> status IDs.
    const suppliers = await client.resolveSupplierIds(config.supplierNames);
    const statusIds = await client.resolveStatusIds(config.targetStatuses);
    log.info('Suppliers: ' + suppliers.map((s) => `${s.name}=${s.id ?? 'NOT FOUND'}`).join(', '));
    log.info(`Status IDs: ${statusIds.join(',') || DASH} | today=${today} (${config.bookingDateMode})`);

    // Scan each supplier's list, keeping today's matching requests (dedup by id).
    const seen = new Set();
    for (const sup of suppliers) {
      if (!sup.id) {
        summary.errors.push(`supplier "${sup.name}" not found in dropdown`);
        log.warn(`Supplier "${sup.name}" not found in the partner dropdown — skipping.`);
        continue;
      }
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
        let todayOnPage = 0;
        for (const r of rows) {
          const c = parseRow(r, sup.name, today);
          if (!c) continue;
          todayOnPage += 1;
          if (!seen.has(c.id)) {
            seen.add(c.id);
            candidates.push(c);
            supCount += 1;
          }
        }
        // List is date-desc: once a page (that had id-rows) yields no today
        // requests, the rest are older — stop paging this supplier.
        if (todayOnPage === 0) break;
      }
      log.info(`${sup.name}: ${supCount} request(s) today`);
    }
    summary.matched = candidates.map((c) => `${c.id}/${c.supplier}`);
    log.info(`Matched ${candidates.length}: ${summary.matched.join(', ') || DASH}`);

    // Process each candidate.
    let sends = 0;
    for (const c of candidates) {
      try {
        if (await wasSent(c.id)) {
          summary.skippedStore.push(c.id);
          rowsForReport.push(mkRow(c, { sent: 'так', result: 'Надіслано раніше (журнал)' }));
          log.info(`Skip ${c.id}: already messaged on a previous run.`);
          continue;
        }

        await client.openChat(c.id);

        if (await client.chatAlreadySent()) {
          summary.skippedAlready.push(c.id);
          if (!config.dryRun) await markSent(c.id, { supplier: c.supplier, reason: 'already-in-chat' });
          rowsForReport.push(mkRow(c, { sent: 'так', result: 'Вже надіслано у чаті' }));
          log.info(`Skip ${c.id}: AVIA message already present in chat.`);
          await client.closeChat();
          continue;
        }

        const sendArgs = {
          department: config.message.department,
          subject: config.message.subject,
          subjectRe: config.message.subjectRe,
          expectedContains: config.message.expectedContains,
          audience: config.message.audience,
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
          rowsForReport.push(mkRow(c, { sent: 'так', result: 'Надіслано' }));
          log.info(`Sent to ${c.id} (${c.supplier}).`);
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
      log.info(`Report: Google Sheet — ${res.updated} оновлено, ${res.appended} додано.`);
    } catch (e) {
      log.warn('Report update failed (continuing): ' + e.message);
    }
  }

  return summary;
}
