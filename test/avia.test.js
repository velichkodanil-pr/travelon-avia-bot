import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ddmmyyyyToISO,
  buildSupplierRe,
  supplierLabelMatches,
  applyTransportNet,
} from '../src/travelon.js';
import { config, ALREADY_SENT_PATTERNS } from '../src/config.js';

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
    'Tickets.ua',
    'Fly One Avia',
    'Skyup',
    'JETIT',
    'JETIT UAH',
  ]);
  assert.deepEqual(config.targetStatuses, ['In Work']);
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
