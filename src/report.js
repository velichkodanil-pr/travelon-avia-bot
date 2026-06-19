// Веде Google-таблицю "AVIA — оброблені заявки": один рядок на заявку, upsert
// по № заявки (стовпець A). Авторизація — OAuth2 user-token (client id/secret +
// refresh token), діє від імені Google-акаунта, що володіє таблицею. Працює
// лише коли REPORT_ENABLED=true і задані всі креди. НІКОЛИ не кидає виняток у
// викликача — збій звіту не має ламати роботу бота (googleapis імпортується
// динамічно, виклик обгорнутий try/catch у runCycle).
import { config } from './config.js';
import { log } from './logger.js';

// Порядок стовпців фіксований — має збігатися з шапкою у таблиці.
export const HEADER = [
  '№ заявки',
  'Постачальник',
  'Статус заявки',
  'Дата бронювання',
  'Відправлено',
  'Дата/час обробки',
  'Результат',
  'Примітки',
];

// 1 -> "A", 2 -> "B", ... 26 -> "Z", 27 -> "AA".
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const LAST_COL = colLetter(HEADER.length); // "H"

export function reportEnabled() {
  const r = config.report;
  return Boolean(r.enabled && r.spreadsheetId && r.clientId && r.clientSecret && r.refreshToken);
}

// "YYYY-MM-DD HH:mm" у часовому поясі бота.
function nowInTz() {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

function rowToValues(r, updatedAt) {
  return [
    r.bookingId ?? '',
    r.supplier ?? '',
    r.bookingStatus ?? '',
    r.bookingDate ?? '',
    r.sent ?? '',
    updatedAt,
    r.result ?? '',
    r.note ?? '',
  ];
}

async function getSheets() {
  const { google } = await import('googleapis');
  const r = config.report;
  const auth = new google.auth.OAuth2(r.clientId, r.clientSecret);
  auth.setCredentials({ refresh_token: r.refreshToken });
  return google.sheets({ version: 'v4', auth });
}

async function resolveTab(sheets) {
  if (config.report.sheetName) return config.report.sheetName;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.report.spreadsheetId });
  return meta.data.sheets?.[0]?.properties?.title || 'Avia';
}

// Upsert рядків по № заявки (стовпець A). Повертає { updated, appended }.
export async function upsertRows(rows) {
  if (!rows || !rows.length) return { updated: 0, appended: 0 };
  const r = config.report;
  const sheets = await getSheets();
  const tab = await resolveTab(sheets);
  const updatedAt = nowInTz();

  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: r.spreadsheetId,
    range: `${tab}!A1:A100000`,
  });
  const colA = (getRes.data.values || []).map((x) => (x[0] ?? '').toString().trim());

  const data = [];
  const headerPresent = colA.length > 0 && colA[0] === HEADER[0];
  if (!headerPresent) data.push({ range: `${tab}!A1`, values: [HEADER] });

  const idToRow = new Map();
  for (let i = 0; i < colA.length; i++) {
    if (i === 0 && headerPresent) continue;
    const id = colA[i];
    if (id) idToRow.set(id, i + 1);
  }

  const appends = [];
  const willAppend = new Set();
  let updated = 0;
  for (const row of rows) {
    const id = (row.bookingId ?? '').toString().trim();
    if (!id) continue;
    const values = rowToValues(row, updatedAt);
    const existing = idToRow.get(id);
    if (existing) {
      data.push({ range: `${tab}!A${existing}:${LAST_COL}${existing}`, values: [values] });
      updated += 1;
    } else if (!willAppend.has(id)) {
      appends.push(values);
      willAppend.add(id);
    }
  }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: r.spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  }
  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: r.spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }

  log.info(`[report] Google Sheet: ${updated} оновлено, ${appends.length} додано.`);
  return { updated, appended: appends.length };
}
