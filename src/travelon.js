// AviaClient — wraps a Playwright browser to reproduce the manual AVIA workflow:
//   login -> open requests -> per supplier (DRCT / Tickets.ua / Fly One Avia /
//   Skyup): filter by supplier + statuses, clear date filters, list TODAY'S
//   requests -> per request: open chat, choose Department "Авіа" + the
//   regular-flight subject, WAIT for the auto-filled text, verify it contains
//   the expected phrase, confirm it was not already sent, then click Send.
//
// Login + chat-composer selectors are copied from the proven transfer bot.
import path from 'node:path';
import { chromium } from 'playwright';
import { config, sel, ALREADY_SENT_PATTERNS } from './config.js';
import { log } from './logger.js';

export function todayISOInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // en-CA -> YYYY-MM-DD
}

// "17.06.2026 15:20:23" or "17.06.2026" -> "2026-06-17"
export function ddmmyyyyToISO(d) {
  const m = d && d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a loose, case-insensitive regex for a supplier NAME so it matches the
// dropdown label even with extra words/punctuation (e.g. "Tickets.ua" ->
// /Tickets.*ua/i, "Fly One Avia" -> /Fly.*One.*Avia/i). Exported for testing.
export function buildSupplierRe(name) {
  return new RegExp(escapeRe(name).replace(/\\\.|\s+/g, '.*'), 'i');
}

// True if a dropdown label matches a configured supplier name (exact, loose
// regex, or substring). Exported for testing.
export function supplierLabelMatches(name, label) {
  const n = String(name).toLowerCase();
  const l = String(label || '').toLowerCase();
  if (l === n) return true;
  if (buildSupplierRe(name).test(label || '')) return true;
  return l.includes(n);
}

export class AviaClient {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.context = await this.browser.newContext({
      locale: 'uk-UA',
      timezoneId: config.tz,
      viewport: { width: 1400, height: 1000 },
    });
    this.context.setDefaultTimeout(config.navTimeout);
    this.page = await this.context.newPage();
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }

  // --- helpers --------------------------------------------------------------

  async firstExisting(selectors, { scope = this.page, timeout = 2500 } = {}) {
    const arr = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeout;
    do {
      for (const s of arr) {
        const loc = scope.locator(s).first();
        if ((await loc.count().catch(() => 0)) > 0) return loc;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return null;
  }

  async screenshot(name) {
    if (!config.screenshotOnError) return;
    try {
      const file = path.join(config.dataDir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: file, fullPage: true });
      log.info('Saved screenshot:', file);
    } catch {
      /* ignore */
    }
  }

  // Select an <option> by exact label, then loosely by regex, then by substring.
  async selectOptionLoose(loc, exactLabel, re) {
    try {
      await loc.selectOption({ label: exactLabel });
      return true;
    } catch {
      /* fall through to loose matching */
    }
    const opts = await loc
      .locator('option')
      .evaluateAll((os) =>
        os.map((o) => ({ v: o.value, t: (o.textContent || '').replace(/\s+/g, ' ').trim() }))
      )
      .catch(() => []);
    const hit =
      opts.find((o) => o.t === exactLabel) ||
      (re ? opts.find((o) => re.test(o.t)) : null) ||
      (exactLabel ? opts.find((o) => o.t.includes(exactLabel)) : null);
    if (hit) {
      await loc.selectOption(hit.v).catch(() => {});
      return true;
    }
    return false;
  }

  // --- login (copied from the working transfer bot) -------------------------

  async isLoggedIn() {
    const marker = await this.firstExisting(sel.login.loggedInMarker, { timeout: 1500 });
    return Boolean(marker);
  }

  async login() {
    log.info('Logging in…');
    await this.page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
    if (await this.isLoggedIn()) {
      log.info('Already authenticated.');
      return;
    }
    const emailLoc = await this.firstExisting(sel.login.email);
    const passLoc = await this.firstExisting(sel.login.password);
    if (!emailLoc || !passLoc) {
      await this.screenshot('login-form-not-found');
      throw new Error('Login form not found. Check TRAVELON_LOGIN_URL and sel.login.*');
    }
    await emailLoc.fill(config.email);
    await passLoc.fill(config.password);
    const submit = await this.firstExisting(sel.login.submit);
    if (submit) await submit.click();
    else await passLoc.press('Enter');
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(2000);
    if (!(await this.isLoggedIn())) {
      await this.screenshot('login-failed');
      throw new Error('Login appears to have failed (logged-in marker not found).');
    }
    log.info('Login OK.');
  }

  // --- requests page + filters ---------------------------------------------

  async openRequests() {
    log.info('Opening requests page…');
    await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500); // grid loads via AJAX
  }

  async readPartnerOptions() {
    return await this.page
      .locator(`${sel.requests.partnerSelect} option`)
      .evaluateAll((os) =>
        os.map((o) => ({ value: o.value, label: (o.textContent || '').replace(/\s+/g, ' ').trim() }))
      )
      .catch(() => []);
  }

  // Map configured supplier NAMES to partner IDs by matching dropdown labels.
  // Returns [{ name, id, label }]. Names with no match get id=null.
  async resolveSupplierIds(names) {
    if (config.supplierIdsOverride.length) {
      return names.map((name, i) => ({
        name,
        id: config.supplierIdsOverride[i] || null,
        label: '(override)',
      }));
    }
    const opts = await this.readPartnerOptions();
    return names.map((name) => {
      const hit = opts.find((o) => supplierLabelMatches(name, o.label));
      return { name, id: hit ? hit.value : null, label: hit ? hit.label : null };
    });
  }

  // Map status LABELS to status IDs from filter[status_ids][] options.
  async resolveStatusIds(labels) {
    const opts = await this.page
      .locator(`${sel.requests.statusSelect} option`)
      .evaluateAll((os) =>
        os.map((o) => ({ value: o.value, label: (o.textContent || '').replace(/\s+/g, ' ').trim() }))
      )
      .catch(() => []);
    const ids = [];
    for (const label of labels) {
      const hit =
        opts.find((o) => o.label.toLowerCase() === label.toLowerCase()) ||
        opts.find((o) => o.label.toLowerCase().includes(label.toLowerCase()));
      if (hit) ids.push(hit.value);
      else log.warn(`Status label not found in dropdown: "${label}"`);
    }
    return ids;
  }

  // Apply the list filter for ONE supplier: set partner_id + status_ids, CLEAR
  // every date / order range field (booking date is filtered client-side), then
  // submit and wait for the filtered list. Mirrors the proven transfer-bot
  // filter so subsequent ?page=N GETs stay filtered.
  async applySupplierFilter(partnerId, statusIds) {
    await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1200);
    await Promise.all([
      this.page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
        .catch(() => {}),
      this.page.evaluate(
        ({ partnerId, statusIds }) => {
          const form =
            document.querySelector('form[action="/book/bundle/index"]') ||
            document.querySelector('form');
          if (!form) return;
          const partner = form.querySelector('select[name="filter[partner_id]"]');
          if (partner && partnerId) partner.value = partnerId;
          const st = form.querySelector('select[name="filter[status_ids][]"]');
          if (st && statusIds && statusIds.length)
            Array.from(st.options).forEach((o) => (o.selected = statusIds.includes(o.value)));
          const mkt = form.querySelector('select[name="filter[market_state_ids][]"]');
          if (mkt) Array.from(mkt.options).forEach((o) => (o.selected = false));
          const sv = form.querySelector('[name="filter[search]"]');
          if (sv) sv.value = '';
          // Clear ALL date/order range fields so nothing is restricted by date
          // server-side (we keep only TODAY's booking date client-side).
          form.querySelectorAll('input').forEach((el) => {
            const n = el.getAttribute('name') || '';
            if (/\[(from|to)_/.test(n) || /date/i.test(n)) el.value = '';
          });
          form.submit();
        },
        { partnerId, statusIds }
      ),
    ]);
    await this.page.waitForTimeout(2500);
  }

  // Read each result row: flat text, status label, and booking (request) date.
  async scanRows() {
    return await this.page
      .locator(sel.requests.resultRows)
      .evaluateAll((trs) =>
        trs.map((tr) => {
          const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
          const text = norm(tr.innerText);
          const statusCell = Array.from(tr.querySelectorAll('td')).find((td) =>
            /Room status/i.test(td.innerText)
          );
          const status = statusCell
            ? statusCell.innerText.split(/Room status/i)[0].replace(/\s+/g, ' ').trim()
            : null;
          const cells = Array.from(tr.children);
          // "Date of request" (booking date) is column index 6 (direct cells).
          const bm = cells[6] ? norm(cells[6].innerText).match(/\d{2}\.\d{2}\.\d{4}/) : null;
          const bookingDate = bm ? bm[0] : '';
          return { text, status, bookingDate };
        })
      )
      .catch(() => []);
  }

  async goToPage(page) {
    await this.page
      .goto(`${config.requestsUrl}?page=${page}`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await this.page.waitForTimeout(2000);
  }

  // --- chat (copied from the working transfer bot) --------------------------

  rowLocatorById(id) {
    return this.page.locator(sel.requests.resultRows).filter({ hasText: id }).first();
  }

  async chatPanelVisible() {
    const panel = await this.firstExisting(sel.chat.panel, { timeout: 800 });
    return panel ? panel.isVisible().catch(() => false) : false;
  }

  async openChat(id) {
    const onList = async () =>
      /\/book\/bundle\/index/.test(this.page.url()) &&
      (await this.page
        .evaluate(() => !!(window.EventBus && typeof window.EventBus.emit === 'function'))
        .catch(() => false));

    if (!(await onList())) {
      await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(1200);
    }
    if (await this.chatPanelVisible()) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(400);
    }
    let opened = await this.page
      .evaluate((bundleId) => {
        if (window.EventBus && typeof window.EventBus.emit === 'function') {
          window.EventBus.emit('modal:chatbox:open', {
            locale: (window.I18n && window.I18n.locale) || 'uk',
            bundleId,
          });
          return true;
        }
        return false;
      }, Number(id))
      .catch(() => false);

    if (!opened) {
      const row = this.rowLocatorById(id);
      const icon = row.locator(sel.requests.chatIconInRow).first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 4000 }).catch(() => {});
      }
    }

    await this.page
      .getByText(new RegExp(`request\\s*${id}`, 'i'))
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    await this.firstExisting(sel.chat.textArea, { timeout: 4000 });
    await this.page.waitForTimeout(500);
  }

  async closeChat() {
    const close = await this.firstExisting(sel.chat.closeButton, { timeout: 1000 });
    if (close) await close.click({ timeout: 2000 }).catch(() => {});
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(400);
  }

  async readChatText() {
    const panel = await this.firstExisting(sel.chat.panel, { timeout: 1500 });
    if (panel) return (await panel.innerText().catch(() => '')) || '';
    return (await this.page.locator('body').innerText().catch(() => '')) || '';
  }

  async chatAlreadySent() {
    const text = await this.readChatText();
    return ALREADY_SENT_PATTERNS.some((re) => re.test(text));
  }

  // Poll the composer textarea until the site auto-fills it (or timeout).
  async waitForComposerText(area, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let val = '';
    do {
      val = (await area.inputValue().catch(() => '')) || '';
      if (val && val.trim().length > 0) return val;
      await this.page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return val;
  }

  // Core AVIA action: choose dept + subject, WAIT for the auto-filled text,
  // verify it contains `expectedContains`, then Send (unless dryRun). Never
  // overwrites the auto-filled text. Returns { verified, sent, filled }.
  async verifyAndSendAvia({ department, subject, subjectRe, expectedContains, audience, dryRun }) {
    const dept = await this.firstExisting(sel.chat.departmentSelect, { timeout: 6000 });
    const area = await this.firstExisting(sel.chat.textArea, { timeout: 3000 });
    if (!dept || !area) {
      await this.screenshot('avia-composer-not-found');
      throw new Error('Chat composer fields not found — verify sel.chat.* selectors.');
    }

    const deptOk = await this.selectOptionLoose(
      dept,
      department,
      new RegExp(escapeRe(department), 'i')
    );
    if (!deptOk) {
      await this.screenshot('avia-department-not-found');
      throw new Error(`Department option "${department}" not found in composer.`);
    }

    const subj = await this.firstExisting(sel.chat.subjectSelect, { timeout: 6000 });
    if (!subj) {
      await this.screenshot('avia-subject-select-missing');
      throw new Error('Subject <select> did not appear after choosing department.');
    }
    const subjOk = await this.selectOptionLoose(subj, subject, subjectRe);
    if (!subjOk) {
      await this.screenshot('avia-subject-not-found');
      throw new Error(`Subject option "${subject}" not found in composer.`);
    }

    const filled = await this.waitForComposerText(area, 8000);
    const verified = Boolean(filled && filled.includes(expectedContains));
    if (!verified) {
      await this.screenshot('avia-autofill-mismatch');
      log.warn(`Auto-fill did not match expected phrase. Got: "${(filled || '').slice(0, 120)}…"`);
      return { verified: false, sent: false, filled };
    }

    if (dryRun) return { verified: true, sent: false, filled };

    // The subject's auto-fill already enables Send; we do NOT touch the textarea
    // (clearing/refilling can de-sync the form). Just send and confirm.
    if (audience === 'administrators') {
      const admins = await this.firstExisting(sel.chat.toAdministratorsButton, { timeout: 1500 });
      if (admins) await admins.click().catch(() => {});
    }

    const send = await this.firstExisting(sel.chat.sendButton, { timeout: 5000 });
    if (!send) {
      await this.screenshot('avia-send-not-found');
      throw new Error('Send button not found — verify sel.chat.sendButton.');
    }
    await send.scrollIntoViewIfNeeded().catch(() => {});
    // Trigger via an IN-PAGE JS click: the composer's React onClick fires
    // reliably this way. Playwright's coordinate click is a silent no-op on this
    // fixed-position composer in headless (confirmed by manual testing — an
    // in-page el.click() posts and clears the composer). Fall back to forced click.
    await send.evaluate((el) => el.click()).catch(async () => {
      await send.click({ timeout: 3000, force: true }).catch(() => {});
    });
    await this.page.waitForTimeout(2500);
    // Confirm the send actually happened: the composer clears its textarea on
    // success. If it did NOT clear, treat as not sent so we retry and never log
    // a false "Sent".
    const remaining = (await area.inputValue().catch(() => '')) || '';
    const sent = remaining.trim().length === 0;
    if (!sent) {
      await this.screenshot('avia-send-not-confirmed');
      log.warn('Send did not clear the composer — message may NOT have been sent.');
    }
    return { verified: true, sent, filled };
  }
}
