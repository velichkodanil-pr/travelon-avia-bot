// Cycle with a fake browser client (no Playwright, no network): date window,
// Sheet-journal restore, chat checks, subject selection, graceful stop, state.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runCycle;
let stop;
let tv; // ../src/travelon.js
let config;
let ALREADY_SENT_PATTERNS;
let sentIdsFromRows;
let store;
let dataDir;
const warnings = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avia-cycle-'));
  process.env.DATA_DIR = dataDir;
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  process.env.AVIA_SUPPLIERS = 'DRCT';
  process.env.SCREENSHOT_ON_ERROR = 'false';
  process.env.LOG_LEVEL = 'warn';
  console.warn = (...a) => warnings.push(a.join(' '));
  ({ runCycle } = await import('../src/runCycle.js'));
  stop = await import('../src/stop.js');
  tv = await import('../src/travelon.js');
  ({ config, ALREADY_SENT_PATTERNS } = await import('../src/config.js'));
  ({ sentIdsFromRows } = await import('../src/report.js'));
  store = await import('../src/store.js');
});
afterEach(() => stop.resetStop());

const AVIA_TEXT =
  'Шановні колеги, доброго дня!\nІнформуємо, що ваш тур заброньований на регулярний рейс.';
const dmy = (iso) => iso.split('-').reverse().join('.');
const today = () => tv.todayISOInTz(config.tz);
const daysAgo = (n) => {
  let d = today();
  for (let i = 0; i < n; i++) d = tv.prevDayISO(d);
  return d;
};
// A list row as scanRows returns it, created `ago` days back.
const row = (id, ago = 0) => ({
  text: `${id} Hotel X Transport: DRCT ${dmy(daysAgo(ago))} 10:00:00 В роботі`,
  status: 'В роботі',
  bookingDate: `${dmy(daysAgo(ago))} 10:00:00`,
});

function fakeClient({
  rows = [],
  drawer = {}, // id -> drawer text (history already there)
  lateHistory = {}, // id -> history that shows up only on the second look
  feed = {}, // id -> chat-feed messages; missing = feed unreadable
  closedDrawer = [], // drawer never opens
  hiddenId = [], // drawer opens but does not show this booking's id
  onOpenChat,
  onResolveStatuses,
} = {}) {
  const calls = { filters: 0, openChat: [], looks: [], feed: [], sent: [] };
  let page = 1;
  let chatId = null;
  const looks = {};
  return {
    calls,
    async init() {},
    async login() {},
    async openRequests() {},
    async resolveSupplierIds(names) {
      return names.map((name, i) => ({ name, id: String(5848 + i), label: name }));
    },
    async resolveScanStatusIds() {
      if (onResolveStatuses) onResolveStatuses();
      return { ids: ['6', '1', '2'], dropped: ['Анульовано=5'], missing: [], total: 7 };
    },
    async applySupplierFilter() {
      calls.filters += 1;
      page = 1;
    },
    async goToPage(p) {
      page = p;
    },
    async scanRows() {
      return page === 1 ? rows : [];
    },
    async openEdit() {},
    async readTransportAmount() {
      return '100.00';
    },
    async openChat(id) {
      chatId = id;
      calls.openChat.push(id);
      if (onOpenChat) onOpenChat(id);
      return !closedDrawer.includes(id) && !hiddenId.includes(id);
    },
    async chatPanelVisible() {
      return !closedDrawer.includes(chatId);
    },
    async readChatFeed(id) {
      calls.feed.push(id);
      return feed[id] ? { ok: true, status: 200, messages: feed[id] } : { ok: false, status: 500, messages: [] };
    },
    async chatAlreadySent() {
      looks[chatId] = (looks[chatId] || 0) + 1;
      calls.looks.push(chatId);
      const late = looks[chatId] > 1 ? lateHistory[chatId] || '' : ''; // not loaded on the 1st look
      const text = `${drawer[chatId] || ''} ${late}`;
      return ALREADY_SENT_PATTERNS.some((re) => re.test(text));
    },
    async verifyAndSendAvia({ bundleId, dryRun }) {
      if (!dryRun) calls.sent.push(bundleId);
      return { verified: true, sent: !dryRun, filled: AVIA_TEXT };
    },
    async closeChat() {},
    async screenshot() {},
    async close() {},
  };
}

const noJournal = () => null;

// --- 1. date window: today + yesterday --------------------------------------

test('prevDayISO crosses month, year and leap-day boundaries', () => {
  assert.equal(tv.prevDayISO('2026-10-08'), '2026-10-07');
  assert.equal(tv.prevDayISO('2026-10-01'), '2026-09-30');
  assert.equal(tv.prevDayISO('2027-01-01'), '2026-12-31');
  assert.equal(tv.prevDayISO('2028-03-01'), '2028-02-29');
});

test('bookings created today and yesterday are in scope, the day before is not', async () => {
  const c = fakeClient({ rows: [row('73001', 0), row('73002', 1), row('73003', 2)] });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(s.matched, ['73001/DRCT', '73002/DRCT']);
  assert.deepEqual(c.calls.sent, ['73001', '73002']);
  // dedup still holds across cycles: nothing is sent twice
  const c2 = fakeClient({ rows: [row('73001', 0), row('73002', 1)] });
  const s2 = await runCycle({ makeClient: () => c2, loadSentIds: noJournal });
  assert.deepEqual(c2.calls.sent, []);
  assert.deepEqual(s2.skippedStore, ['73001', '73002']);
});

test("a late-evening booking already messaged from the chat is not sent again the next day", async () => {
  // made at ~23:50 yesterday, after the last cycle; someone else already sent it
  const c = fakeClient({ rows: [row('73004', 1)], drawer: { 73004: AVIA_TEXT } });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(s.skippedAlready, ['73004']);
});

// --- 2. "already sent" restored from the Sheet journal ----------------------

test('sentIdsFromRows: only rows marked "так" (header, ні, DRY-RUN and blanks ignored)', () => {
  const rows = [
    ['№ заявки', 'Постачальник', 'Статус заявки', 'Дата бронювання', 'Відправлено'],
    ['73101', 'DRCT', 'В роботі', '2026-10-07', 'так'],
    ['73102', 'Skyup', 'В роботі', '2026-10-07', ' Так '],
    ['73103', 'DRCT', 'В роботі', '2026-10-07', 'ні'],
    ['73104', 'DRCT', 'В роботі', '2026-10-07', 'DRY-RUN'],
    ['', '', '', '', 'так'],
    [73105, 'JETIT', 'В роботі', '2026-10-07', 'так'],
    ['73106'],
  ];
  assert.deepEqual([...sentIdsFromRows(rows)], ['73101', '73102', '73105']);
  assert.equal(sentIdsFromRows(undefined).size, 0);
});

test('the Sheet journal seeds "already sent": no chat is opened for those after a restart', async () => {
  const c = fakeClient({ rows: [row('73111', 0), row('73112', 1)] });
  const s = await runCycle({ makeClient: () => c, loadSentIds: async () => new Set(['73111']) });
  assert.deepEqual(c.calls.openChat, ['73112'], 'journal hit — chat not even opened');
  assert.deepEqual(s.skippedStore, ['73111']);
  assert.deepEqual(c.calls.sent, ['73112']);
});

test('an unreadable Sheet journal does not break the cycle (in-chat check only)', async () => {
  warnings.length = 0;
  const c = fakeClient({ rows: [row('73121', 0), row('73122', 0)], drawer: { 73121: AVIA_TEXT } });
  const s = await runCycle({
    makeClient: () => c,
    loadSentIds: async () => {
      throw new Error('quota exceeded');
    },
  });
  assert.ok(!s.errors.some((e) => e.startsWith('cycle:')), s.errors.join(' | '));
  assert.deepEqual(s.skippedAlready, ['73121']);
  assert.deepEqual(c.calls.sent, ['73122']);
  assert.ok(warnings.some((w) => /Sheet journal unreadable.*quota exceeded/.test(w)), warnings.join('\n'));

  // a loader that throws synchronously is caught the same way
  const c2 = fakeClient({ rows: [row('73123', 0)] });
  const s2 = await runCycle({
    makeClient: () => c2,
    loadSentIds: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(c2.calls.sent, ['73123']);
  assert.ok(!s2.errors.some((e) => e.startsWith('cycle:')));
});

// --- 3. chat: never decide "not sent yet" blind -----------------------------

test('a chat drawer that did not open is skipped, never messaged blind', async () => {
  const c = fakeClient({ rows: [row('73201', 0)], closedDrawer: ['73201'] });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(c.calls.looks, [], 'history not even looked at');
  assert.ok(s.errors.some((e) => /73201: chat did not open/.test(e)), s.errors.join(' | '));
});

test('a drawer that does not show THIS booking (and no chat feed) is skipped', async () => {
  const c = fakeClient({ rows: [row('73202', 0)], hiddenId: ['73202'] });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(c.calls.looks, []);
  assert.ok(s.errors.some((e) => /73202: chat history not confirmed/.test(e)), s.errors.join(' | '));
});

test('history that loads late is seen on the second look (no duplicate)', async () => {
  const c = fakeClient({ rows: [row('73203', 0)], lateHistory: { 73203: AVIA_TEXT } });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(c.calls.looks, ['73203', '73203']);
  assert.deepEqual(s.skippedAlready, ['73203']);
});

test("the server chat feed is THIS booking's history: it decides, the drawer is not needed", async () => {
  const sentFeed = [
    'Нова заявка 73204<br>',
    '<p>Шановні колеги, доброго дня!<br>Інформуємо, що ваш тур&nbsp;заброньований на регулярний рейс.</p>',
  ];
  const c = fakeClient({
    rows: [row('73204', 0), row('73205', 0)],
    feed: { 73204: sentFeed, 73205: ['Нова заявка 73205<br>'] },
    hiddenId: ['73204', '73205'], // drawer header without the id: the feed still decides
    drawer: { 73205: AVIA_TEXT }, // a stale drawer must not override the server feed
  });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(s.skippedAlready, ['73204']);
  assert.deepEqual(c.calls.sent, ['73205']);
  assert.deepEqual(c.calls.looks, [], 'feed readable — the drawer is not scanned');
});

test('textHasId / feedHasAviaMessage', () => {
  assert.equal(tv.textHasId('Заявка 72585\nНова заявка', '72585'), true);
  assert.equal(tv.textHasId('Request 72585', 72585), true);
  assert.equal(tv.textHasId('№72585:', '72585'), true);
  assert.equal(tv.textHasId('Заявка 172585', '72585'), false);
  assert.equal(tv.textHasId('Заявка 725851', '72585'), false);
  assert.equal(tv.textHasId('', '72585'), false);
  assert.equal(tv.textHasId('Заявка 72585', ''), false);
  assert.equal(tv.feedHasAviaMessage(['Нова заявка 1<br>', AVIA_TEXT.replace('\n', '<br>')]), true);
  assert.equal(tv.feedHasAviaMessage(['заброньований&nbsp;на <b>регулярний</b> рейс']), true);
  assert.equal(tv.feedHasAviaMessage(['Нова заявка 1<br>', 'Бронювання на регулярному рейсі']), false);
  assert.equal(tv.feedHasAviaMessage([]), false);
  assert.equal(tv.feedHasAviaMessage(undefined), false);
});

// --- 4. subject option: no 45 s label wait ----------------------------------

// Live-like composer options: the subject label differs from AVIA_SUBJECT only
// by the slash style, so an exact { label } match never fires.
const SUBJECT_OPTS = [
  { v: '', t: 'Оберіть тему' },
  { v: '84', t: 'Бронювання авіаквитків Pegasus' },
  { v: '85', t: 'Перевірка часу рейса' },
  { v: '86', t: 'Бронювання на регулярному рейсі (ТІКЕТСИ/ДРСТ/СКАЙ АП)' },
];

test('pickOption: exact, then normalised, then regex, then substring; never the placeholder', () => {
  const reg = config.message.regular;
  const peg = config.message.pegasus;
  assert.equal(tv.pickOption(SUBJECT_OPTS, 'Перевірка часу рейса').v, '85');
  assert.equal(tv.pickOption(SUBJECT_OPTS, reg.subject, reg.subjectRe).v, '86'); // "\" vs "/"
  assert.equal(tv.pickOption(SUBJECT_OPTS, peg.subject, peg.subjectRe).v, '84');
  const renamed = [{ v: '86', t: 'Бронювання на регулярному рейсі (тікетси, дрст, скай ап)' }, ...SUBJECT_OPTS.slice(1, 3)];
  assert.equal(tv.pickOption(renamed, reg.subject, reg.subjectRe).v, '86'); // via the regex
  assert.equal(tv.pickOption([{ v: '9', t: 'Авіа ' }, { v: '3', t: 'Бронювання' }], 'Авіа').v, '9');
  assert.equal(tv.pickOption(SUBJECT_OPTS, 'pegasus').v, '84'); // substring
  assert.equal(tv.pickOption(SUBJECT_OPTS, 'Оберіть тему'), null); // placeholder has no value
  assert.equal(tv.pickOption(SUBJECT_OPTS, 'Немає такої'), null);
  assert.equal(tv.pickOption([], reg.subject, reg.subjectRe), null);
  // the regular regex never lands on the Pegasus subject and vice versa
  assert.notEqual(tv.pickOption(SUBJECT_OPTS.slice(0, 3), reg.subject, reg.subjectRe)?.v, '84');
});

// A <select> like Playwright's: selectOption({ label }) for a label that is not
// there waits out the timeout (45 s live, 1 s here) and then throws.
function fakeSelect(optsByRead) {
  let reads = 0;
  const selected = [];
  return {
    selected,
    get reads() {
      return reads;
    },
    locator: () => ({
      evaluateAll: async () => optsByRead[Math.min(reads++, optsByRead.length - 1)],
    }),
    async selectOption(v) {
      selected.push(v);
      const opts = optsByRead[optsByRead.length - 1];
      if (v && typeof v === 'object' && 'label' in v && !opts.some((o) => o.t === v.label)) {
        await new Promise((r) => setTimeout(r, 1000));
        throw new Error(`Timeout: option "${v.label}" not found`);
      }
    },
  };
}

test('selectOptionLoose selects by value at once — no wait for an exact label', async () => {
  const client = new tv.AviaClient();
  client.page = { waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const reg = config.message.regular;

  const sel1 = fakeSelect([SUBJECT_OPTS]);
  const t0 = Date.now();
  assert.equal(await client.selectOptionLoose(sel1, reg.subject, reg.subjectRe), true);
  assert.deepEqual(sel1.selected, [{ value: '86' }], 'by value only — never { label }');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);

  // the subject list renders only after the department is chosen: it is polled
  const sel2 = fakeSelect([[SUBJECT_OPTS[0]], [SUBJECT_OPTS[0]], SUBJECT_OPTS]);
  assert.equal(await client.selectOptionLoose(sel2, reg.subject, reg.subjectRe), true);
  assert.deepEqual(sel2.selected, [{ value: '86' }]);
  assert.equal(sel2.reads, 3);

  // nothing matches -> false after the short poll, nothing selected
  const sel3 = fakeSelect([SUBJECT_OPTS]);
  const t1 = Date.now();
  assert.equal(await client.selectOptionLoose(sel3, 'Немає такої', null, { timeout: 300 }), false);
  assert.deepEqual(sel3.selected, []);
  assert.ok(Date.now() - t1 < 1500);
});

// --- 5. graceful stop + atomic state ----------------------------------------

test('SIGTERM mid-cycle: the request in progress is finished, the rest waits', async () => {
  const c = fakeClient({
    rows: [row('73301', 0), row('73302', 0), row('73303', 1)],
    onOpenChat: () => stop.requestStop('SIGTERM'),
  });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.deepEqual(c.calls.sent, ['73301']);
  assert.deepEqual(c.calls.openChat, ['73301']);
  assert.equal(s.interrupted, 'SIGTERM');
  // the two left over are still new on the next cycle
  stop.resetStop();
  const c2 = fakeClient({ rows: [row('73301', 0), row('73302', 0), row('73303', 1)] });
  const s2 = await runCycle({ makeClient: () => c2, loadSentIds: noJournal });
  assert.deepEqual(c2.calls.sent, ['73302', '73303']);
  assert.deepEqual(s2.skippedStore, ['73301']);
  assert.equal(s2.interrupted, '');
});

test('SIGTERM before the scan: no list is filtered and no chat is opened', async () => {
  const c = fakeClient({
    rows: [row('73311', 0)],
    onResolveStatuses: () => stop.requestStop('SIGTERM'),
  });
  const s = await runCycle({ makeClient: () => c, loadSentIds: noJournal });
  assert.equal(c.calls.filters, 0);
  assert.deepEqual(c.calls.openChat, []);
  assert.equal(s.interrupted, 'SIGTERM');
});

test('sent.json writes are atomic: no temp files left, JSON stays valid', async () => {
  await Promise.all(['73401', '73402', '73403'].map((id) => store.markSent(id, { supplier: 'DRCT' })));
  const files = fs.readdirSync(dataDir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')), files.join(','));
  JSON.parse(fs.readFileSync(path.join(dataDir, 'sent.json'), 'utf8'));
  await store.markSent('73404', { supplier: 'DRCT' });
  assert.equal(await store.wasSent('73404'), true);
});

test('a write killed midway leaves the previous sent.json intact', async () => {
  await store.markSent('73411', { supplier: 'DRCT' });
  const real = fs.promises.writeFile;
  fs.promises.writeFile = async (file, data, enc) => {
    await real(file, String(data).slice(0, 20), enc); // half a file, then "killed"
    throw new Error('killed mid-write');
  };
  try {
    await store.markSent('73412', { supplier: 'DRCT' }); // logs a warning, never throws
  } finally {
    fs.promises.writeFile = real;
  }
  JSON.parse(fs.readFileSync(path.join(dataDir, 'sent.json'), 'utf8'));
  assert.equal(await store.wasSent('73411'), true, 'history survived');
  assert.equal(await store.wasSent('73412'), false);
  for (const f of fs.readdirSync(dataDir)) if (f.endsWith('.tmp')) fs.unlinkSync(path.join(dataDir, f));
});
