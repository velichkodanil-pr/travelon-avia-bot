import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ddmmyyyyToISO,
  buildSupplierRe,
  supplierLabelMatches,
  applyTransportNet,
  pickSupplierOption,
  matchedExcludedHotel,
  buildHotelExcludeRe,
  pickTransportAmount,
  pickStatusIds,
  isCancelledStatus,
  splitRowStatus,
} from '../src/travelon.js';
import { config, ALREADY_SENT_PATTERNS } from '../src/config.js';
import { tallySentByDay, topSentDays } from '../src/report.js';
import { parseRow } from '../src/runCycle.js';

// The real auto-filled message text (per the operator's spec).
const AUTOFILL_SAMPLE =
  'Шановні колеги, доброго дня!\n' +
  'Інформуємо, що ваш тур заброньований на регулярний рейс. ' +
  'Просимо звернути увагу, що зміни/повернення регулюються правилами тарифу.';

// Pegasus auto-fill carries the single " _ " placeholder for the penalty amount.
const PEGASUS_SAMPLE =
  'Шановні колеги! Ваш тур заброньований на регулярний рейс Pegasus. ' +
  'У разі ануляції утримується штраф в розмірі _ євро згідно правил тарифу.';

test('ddmmyyyyToISO parses date and datetime', () => {
  assert.equal(ddmmyyyyToISO('17.06.2026 15:20:23'), '2026-06-17');
  assert.equal(ddmmyyyyToISO('19.06.2026'), '2026-06-19');
  assert.equal(ddmmyyyyToISO('garbage'), null);
});

test('supplier names match realistic dropdown labels', () => {
  assert.ok(supplierLabelMatches('DRCT', 'DRCT'));
  assert.ok(supplierLabelMatches('DRCT', 'DRCT (avia)'));
  assert.ok(supplierLabelMatches('Tickets.ua', 'Tickets.ua'));
  assert.ok(supplierLabelMatches('Tickets.ua', 'Tickets ua'));
  assert.ok(supplierLabelMatches('Fly One Avia', 'Fly One Avia'));
  assert.ok(supplierLabelMatches('Fly One Avia', 'FLY ONE AVIA LLC'));
  assert.ok(supplierLabelMatches('Skyup', 'SkyUp'));
  assert.ok(supplierLabelMatches('Skyup', 'SkyUp Airlines'));
  // JETIT (Pegasus supplier) and its UAH variant.
  assert.ok(supplierLabelMatches('JETIT', 'JETIT'));
  assert.ok(supplierLabelMatches('JETIT', 'JetIt'));
  assert.ok(supplierLabelMatches('JETIT UAH', 'JETIT UAH'));
  // Must NOT match an unrelated supplier.
  assert.equal(supplierLabelMatches('Skyup', 'Itravel'), false);
  assert.equal(supplierLabelMatches('DRCT', 'E.Line Tour'), false);
});

test('buildSupplierRe is case-insensitive and loose', () => {
  assert.ok(buildSupplierRe('Fly One Avia').test('fly  one   avia'));
  assert.ok(buildSupplierRe('Tickets.ua').test('TICKETS-UA'));
});

test('config defaults are the AVIA criteria', () => {
  assert.deepEqual(config.supplierNames, [
    'DRCT',
    'DRCT Euro Ryanair',
    'Tickets.ua',
    'Fly One Avia',
    'Skyup',
    'JETIT',
    'JETIT UAH',
  ]);
  // Empty allow-list = process every status; Canceled is excluded.
  assert.deepEqual(config.targetStatuses, []);
  assert.deepEqual(config.excludeStatuses, ['Canceled', 'Cancelled']);
  // Server-side list filter never requests id 5 = Анульовано.
  assert.deepEqual(config.excludeStatusIds, ['5']);
  // Regular sends from "Авіа"; Pegasus (JETIT) sends from "Бронювання".
  assert.equal(config.message.regular.department, 'Авіа');
  assert.equal(config.message.pegasus.department, 'Бронювання');
  assert.equal(config.bookingDateMode, 'today');
  assert.equal(config.checkCron, '*/5 * * * *');
  // Regular subject keeps the literal backslashes.
  assert.ok(config.message.regular.subject.includes('ТІКЕТСИ\\ДРСТ\\СКАЙ АП'));
  assert.equal(config.message.regular.fillTransportNet, false);
  // Pegasus subject + amount flag.
  assert.ok(config.message.pegasus.subject.includes('Pegasus'));
  assert.equal(config.message.pegasus.fillTransportNet, true);
});

test('pegasusSuppliers are exactly JETIT and JETIT UAH', () => {
  assert.deepEqual(config.pegasusSuppliers, ['JETIT', 'JETIT UAH']);
  // Every Pegasus supplier is also in the scanned supplier list.
  for (const s of config.pegasusSuppliers) {
    assert.ok(
      config.supplierNames.some((n) => n.toLowerCase() === s.toLowerCase()),
      `${s} must be in supplierNames so it is scanned`
    );
  }
});

test('expectedContains IS a substring of the real auto-fill text', () => {
  // The gate the bot uses before sending — MUST hold for the real text.
  assert.ok(
    AUTOFILL_SAMPLE.includes(config.message.regular.expectedContains),
    `regular auto-fill must contain "${config.message.regular.expectedContains}"`
  );
  assert.ok(
    PEGASUS_SAMPLE.includes(config.message.pegasus.expectedContains),
    `pegasus auto-fill must contain "${config.message.pegasus.expectedContains}"`
  );
});

test('subjectRe matches its subject label', () => {
  assert.ok(config.message.regular.subjectRe.test(config.message.regular.subject));
  assert.ok(config.message.regular.subjectRe.test('Бронювання на регулярному рейсі'));
  assert.ok(config.message.pegasus.subjectRe.test(config.message.pegasus.subject));
  assert.ok(config.message.pegasus.subjectRe.test('Бронювання авіаквитків Pegasus'));
  // Regular subjectRe must NOT fire on the Pegasus label, and vice-versa.
  assert.equal(config.message.regular.subjectRe.test('Бронювання авіаквитків Pegasus'), false);
  assert.equal(config.message.pegasus.subjectRe.test('Бронювання на регулярному рейсі'), false);
});

test('applyTransportNet inserts the amount with a decimal comma', () => {
  // 810.43 -> 810,43 inserted in place of " _ ".
  const r = applyTransportNet(PEGASUS_SAMPLE, '810.43');
  assert.equal(r.replaced, true);
  assert.ok(r.message.includes('розмірі 810,43 євро'));
  assert.ok(!r.message.includes(' _ '));
  // Already comma-formatted input is preserved.
  assert.equal(applyTransportNet(PEGASUS_SAMPLE, '810,43').message.includes('810,43'), true);
  // Whitespace inside the amount is stripped.
  assert.ok(applyTransportNet(PEGASUS_SAMPLE, ' 1 234.50 ').message.includes('1234,50'));
});

test('applyTransportNet is a no-op without an amount or placeholder', () => {
  // No amount -> unchanged.
  const noAmt = applyTransportNet(PEGASUS_SAMPLE, '');
  assert.equal(noAmt.replaced, false);
  assert.equal(noAmt.message, PEGASUS_SAMPLE);
  // Amount but no placeholder -> unchanged text, replaced=false.
  const noHole = applyTransportNet('текст без плейсхолдера', '810.43');
  assert.equal(noHole.replaced, false);
  assert.equal(noHole.message, 'текст без плейсхолдера');
});

test('ALREADY_SENT_PATTERNS detect the auto-fill in chat history (dedup)', () => {
  assert.ok(
    ALREADY_SENT_PATTERNS.some((re) => re.test(AUTOFILL_SAMPLE)),
    'at least one dedup pattern must match the sent message'
  );
  // Should NOT fire on an unrelated chat message.
  const unrelated = 'Добрий день, надішліть, будь ласка, ваучер та контакти готелю.';
  assert.equal(
    ALREADY_SENT_PATTERNS.some((re) => re.test(unrelated)),
    false
  );
});


test('tallySentByDay counts "так" rows grouped by booking date (col D/E)', () => {
  // Columns A..H: [id, supplier, status, bookingDate, sent, updatedAt, result, note]
  const rows = [
    ['60643', 'Skyup', 'In Work', '2026-06-19', 'так', 't', 'Надіслано', ''],
    ['60676', 'Tickets.ua', 'In Work', '2026-06-19', 'так', 't', 'Надіслано раніше (журнал)', ''],
    ['60685', 'Skyup', 'In Work', '2026-06-19', 'ні', 't', 'Send не підтверджено', ''],
    ['60707', 'JETIT', 'In Work', '2026-06-20', 'так', 't', 'Надіслано (Pegasus)', ''],
    ['60698', 'Skyup', 'In Work', '2026-06-20', 'так', 't', 'Вже надіслано у чаті', ''],
    ['', '', '', '', '', '', '', ''],
  ];
  const counts = tallySentByDay(rows);
  assert.equal(counts.get('2026-06-19'), 2);
  assert.equal(counts.get('2026-06-20'), 2);
  assert.equal(counts.size, 2);
  // Empty input is safe.
  assert.equal(tallySentByDay([]).size, 0);
  assert.equal(tallySentByDay(undefined).size, 0);
});

test('topSentDays sorts newest date first and caps to the limit', () => {
  const counts = new Map([
    ['2026-06-19', 2],
    ['2026-06-21', 5],
    ['2026-06-20', 3],
  ]);
  assert.deepEqual(topSentDays(counts), [
    ['2026-06-21', 5],
    ['2026-06-20', 3],
    ['2026-06-19', 2],
  ]);
  assert.deepEqual(topSentDays(counts, 2), [
    ['2026-06-21', 5],
    ['2026-06-20', 3],
  ]);
});

test('pickSupplierOption prefers an exact label match (DRCT vs DRCT Euro Ryanair)', () => {
  // Real dropdown ids: DRCT=5848, DRCT Euro Ryanair=6921. The loose regex /DRCT/i
  // matches BOTH, so an exact label match must win — even if the longer name is
  // listed first — otherwise the two suppliers swap partner ids.
  const opts = [
    { value: '6921', label: 'DRCT Euro Ryanair' },
    { value: '5848', label: 'DRCT' },
  ];
  assert.equal(pickSupplierOption('DRCT', opts).value, '5848');
  assert.equal(pickSupplierOption('DRCT Euro Ryanair', opts).value, '6921');
  // Loose fallback still works for names that differ from the label wording.
  const loose = [{ value: '5850', label: 'FLY ONE AVIA LLC' }];
  assert.equal(pickSupplierOption('Fly One Avia', loose).value, '5850');
  // Unknown supplier -> null (caller logs "not found in dropdown").
  assert.equal(pickSupplierOption('Nope Airlines', opts), null);
  assert.equal(pickSupplierOption('DRCT', []), null);
});

test('DRCT Euro Ryanair uses the REGULAR profile (not Pegasus)', () => {
  assert.ok(config.supplierNames.includes('DRCT Euro Ryanair'));
  assert.ok(!config.pegasusSuppliers.includes('DRCT Euro Ryanair'));
});

test('excluded hotels block the message (Work&Travelon / ON TRIP)', () => {
  const ex = config.hotelExcludes;
  assert.deepEqual(ex, ['Work&Travelon', 'ON TRIP']);
  // Real row text carries the hotel name, so match against the whole row.
  const row1 = '1 65477 Hotel: Kalanit Transport: JETIT 29.07.2026 IVANOV WORK&TRAVELON PROGRAM 2adl';
  const row2 = '2 65478 Hotel: X Transport: DRCT 29.07.2026 PETROV ON TRIP HOSTEL 1adl';
  assert.equal(matchedExcludedHotel(row1, ex), 'Work&Travelon');
  assert.equal(matchedExcludedHotel(row2, ex), 'ON TRIP');
  // Spacing around "&" is flexible.
  assert.equal(matchedExcludedHotel('WORK & TRAVELON APARTMENTS', ex), 'Work&Travelon');
  // A normal booking is NOT excluded.
  assert.equal(matchedExcludedHotel('GYPSOPHILA CLUB MARINE ULTRA ALL INCLUSIVE 4adl', ex), null);
  assert.equal(matchedExcludedHotel('', ex), null);
});

test('ON TRIP must NOT match "ON TRIPLE ROOM" (word boundary)', () => {
  const ex = config.hotelExcludes;
  // This is the whole point of the word-bounded regex: room descriptions like
  // "EXTRA BED ON TRIPLE ROOM" must still be messaged normally.
  assert.equal(matchedExcludedHotel('SUNRISE RESORT EXTRA BED ON TRIPLE ROOM 3adl', ex), null);
  assert.equal(buildHotelExcludeRe('ON TRIP').test('ON TRIPLE'), false);
  assert.equal(buildHotelExcludeRe('ON TRIP').test('ON TRIP HOTEL'), true);
  // Not tripped by an unrelated word containing the letters.
  assert.equal(buildHotelExcludeRe('ON TRIP').test('MONTRIP'), false);
});

// Real "Prices by modules" of booking 69811 (UK UI). Travelon showed
// "Сума брутто" 2711.74 = sum of agency_cost; the old code inserted the
// transport NET (transport[net_cost] = 889.84) — the bug ops reported.
const MODS_69811 = [
  { label: 'Готелі', gross_cost: '1588.86', operator_cost: '1671.35', agency_cost: '1671.35', client_cost: '1857.06' },
  { label: 'Страховка', gross_cost: '11.2', operator_cost: '11.78', agency_cost: '11.78', client_cost: '13.09' },
  { label: 'Трансфер', gross_cost: '88.0', operator_cost: '92.57', agency_cost: '92.57', client_cost: '102.85' },
  { label: 'Транспорт', gross_cost: '890.37', operator_cost: '936.04', agency_cost: '936.04', client_cost: '1040.04' },
];

test('Pegasus penalty = transport BRUTTO (agency_cost), not netto', () => {
  assert.equal(config.message.pegasus.amountField, 'agency_cost');
  assert.equal(pickTransportAmount(MODS_69811), '936.04');
  assert.equal(pickTransportAmount(MODS_69811, 'gross_cost'), '890.37'); // net column
  assert.equal(pickTransportAmount(MODS_69811, 'client_cost'), '1040.04');
  // agency_cost across modules == Travelon's "Сума брутто" for 69811.
  const brutto = MODS_69811.reduce((acc, m) => acc + Number(m.agency_cost), 0);
  assert.equal(brutto.toFixed(2), '2711.74');
  // End to end: the message gets 936,04 (decimal comma), never the net 889,84.
  const msg = applyTransportNet(PEGASUS_SAMPLE, pickTransportAmount(MODS_69811)).message;
  assert.ok(msg.includes('розмірі 936,04 євро'));
  assert.ok(!msg.includes('889,84'));
});

test('pickTransportAmount: EN labels, Transfer never confused, missing/zero -> empty', () => {
  assert.equal(
    pickTransportAmount([
      { label: 'Transfer', agency_cost: '92.57' },
      { label: 'Transport', agency_cost: '387.0' },
    ]),
    '387.0'
  );
  assert.equal(pickTransportAmount([{ label: 'Трансфер', agency_cost: '92.57' }]), '');
  assert.equal(pickTransportAmount([{ label: 'Транспорт', agency_cost: '0' }]), '');
  assert.equal(pickTransportAmount([{ label: 'Транспорт', agency_cost: '' }]), '');
  assert.equal(pickTransportAmount([]), '');
  assert.equal(pickTransportAmount(undefined), '');
});

// Live travelon.to status filter options (UK UI, checked 07.10.2026).
const STATUS_OPTS_UK = [
  { value: '6', label: 'Нове бронювання' },
  { value: '1', label: 'В роботі' },
  { value: '2', label: 'Підтверджено' },
  { value: '3', label: 'Підтверджено друк документів' },
  { value: '4', label: 'Не підтверджено' },
  { value: '5', label: 'Анульовано' },
  { value: '7', label: 'Не підтверджено з сайту' },
];

test('status filter requests every status EXCEPT Анульовано (id 5)', () => {
  const r = pickStatusIds(STATUS_OPTS_UK, {
    allow: config.targetStatuses,
    exclude: config.excludeStatuses,
    excludeIds: config.excludeStatusIds,
  });
  assert.deepEqual(r.ids, ['6', '1', '2', '3', '4', '7']);
  assert.deepEqual(r.dropped, ['Анульовано=5']);
});

test('cancelled is dropped by label in any UI language, and by explicit id', () => {
  const en = [
    { value: '', label: 'All' }, // placeholder without a value is ignored
    { value: '6', label: 'New booking' },
    { value: '2', label: 'Confirmed' },
    { value: '9', label: 'Canceled' },
  ];
  assert.deepEqual(pickStatusIds(en).ids, ['6', '2']);
  const ru = [
    { value: '2', label: 'Подтверждено' },
    { value: '5', label: 'Аннулировано' },
  ];
  assert.deepEqual(pickStatusIds(ru).ids, ['2']);
  const renamed = [
    { value: '5', label: 'Xyz' },
    { value: '1', label: 'В роботі' },
  ];
  assert.deepEqual(pickStatusIds(renamed, { excludeIds: ['5'] }).ids, ['1']);
  // Nothing usable -> empty ids (runCycle then refuses to scan unfiltered).
  assert.deepEqual(pickStatusIds([], { excludeIds: ['5'] }).ids, []);
});

test('allow-list resolves exact-first and can never re-enable cancelled', () => {
  const r = pickStatusIds(STATUS_OPTS_UK, { allow: ['Підтверджено', 'Анульовано'], excludeIds: ['5'] });
  assert.deepEqual(r.ids, ['2']); // exact "Підтверджено", not "Не підтверджено"
  assert.deepEqual(r.missing, ['Анульовано']);
});

test('isCancelledStatus: cancelled labels only (UK/EN/RU)', () => {
  for (const s of ['Анульовано', 'Canceled', 'Cancelled', 'Скасовано', 'Аннулировано', 'Отменено']) {
    assert.equal(isCancelledStatus(s), true, s);
  }
  for (const s of STATUS_OPTS_UK.filter((o) => o.value !== '5').map((o) => o.label).concat(['', null])) {
    assert.equal(isCancelledStatus(s), false, String(s));
  }
  assert.equal(isCancelledStatus('Custom stop', ['custom']), true);
});

test('splitRowStatus reads the booking status before the room-status marker', () => {
  assert.equal(splitRowStatus('Нове бронювання Статус кімнати : New'), 'Нове бронювання');
  assert.equal(splitRowStatus('Анульовано\nСтатус кімнати : Cancelled'), 'Анульовано');
  assert.equal(splitRowStatus('Confirmed Room status : OK'), 'Confirmed');
  assert.equal(splitRowStatus('no marker'), '');
});

test('parseRow never returns a cancelled booking (row-level guard)', () => {
  const today = '2026-10-07';
  const row = (status) => ({
    text: '72585 Hotel X 07.10.2026 12:00:00 ' + status,
    status,
    bookingDate: '07.10.2026 12:00:00',
  });
  assert.equal(parseRow(row('Анульовано'), 'DRCT', today), null);
  assert.equal(parseRow(row('Canceled'), 'DRCT', today), null);
  const ok = parseRow(row('Нове бронювання'), 'DRCT', today);
  assert.equal(ok && ok.id, '72585');
  assert.equal(ok.status, 'Нове бронювання');
  // Status unknown (marker missing) -> the server-side filter is the guard.
  assert.equal(parseRow({ ...row(''), status: null }, 'DRCT', today).id, '72585');
});
