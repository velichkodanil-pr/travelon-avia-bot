import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddmmyyyyToISO, buildSupplierRe, supplierLabelMatches } from '../src/travelon.js';
import { config, ALREADY_SENT_PATTERNS } from '../src/config.js';

// The real auto-filled message text (per the operator's spec).
const AUTOFILL_SAMPLE =
  'Шановні колеги, доброго дня!\n' +
  'Інформуємо, що ваш тур заброньований на регулярному рейсі. ' +
  'Просимо звернути увагу, що зміни/повернення регулюються правилами тарифу.';

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
  // Must NOT match an unrelated supplier.
  assert.equal(supplierLabelMatches('Skyup', 'Itravel'), false);
  assert.equal(supplierLabelMatches('DRCT', 'E.Line Tour'), false);
});

test('buildSupplierRe is case-insensitive and loose', () => {
  assert.ok(buildSupplierRe('Fly One Avia').test('fly  one   avia'));
  assert.ok(buildSupplierRe('Tickets.ua').test('TICKETS-UA'));
});

test('config defaults are the AVIA criteria', () => {
  assert.deepEqual(config.supplierNames, ['DRCT', 'Tickets.ua', 'Fly One Avia', 'Skyup']);
  assert.deepEqual(config.targetStatuses, ['New reservation', 'In Work', 'Confirmed Print']);
  assert.equal(config.message.department, 'Авіа');
  assert.equal(config.bookingDateMode, 'today');
  assert.equal(config.checkCron, '*/5 * * * *');
  // Subject keeps the literal backslashes.
  assert.ok(config.message.subject.includes('ТІКЕТСИ\\ДРСТ\\СКАЙ АП'));
});

test('expectedContains IS a substring of the real auto-fill text', () => {
  // This is the gate the bot uses before sending — it MUST hold for the real text.
  assert.ok(
    AUTOFILL_SAMPLE.includes(config.message.expectedContains),
    `auto-fill must contain "${config.message.expectedContains}"`
  );
});

test('subjectRe matches the subject label', () => {
  assert.ok(config.message.subjectRe.test(config.message.subject));
  assert.ok(config.message.subjectRe.test('Бронювання на регулярному рейсі'));
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
