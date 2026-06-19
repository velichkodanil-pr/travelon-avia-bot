// Central configuration for the AVIA bot: reads environment variables (with
// sensible defaults) and keeps ALL CSS/text selectors in one place. The login
// and chat-composer selectors are copied verbatim from the proven
// travelon-transfer-bot, so they are known to work against the live DOM.
import 'dotenv/config';

const bool = (v, def = false) =>
  v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const list = (v, def = []) =>
  v === undefined || v === ''
    ? def
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

export const config = {
  // --- credentials & urls ---
  email: process.env.TRAVELON_EMAIL || '',
  password: process.env.TRAVELON_PASSWORD || '',
  baseUrl: (process.env.TRAVELON_BASE_URL || 'https://travelon.to').replace(/\/$/, ''),
  loginUrl: process.env.TRAVELON_LOGIN_URL || 'https://travelon.to/admin/users/sign_in',
  requestsUrl: process.env.TRAVELON_REQUESTS_URL || 'https://travelon.to/book/bundle/index',

  // --- behaviour ---
  dryRun: bool(process.env.DRY_RUN, true),
  // Every 5 minutes by default (per spec). Uses CRON_TZ below.
  checkCron: process.env.CHECK_CRON || '*/5 * * * *',
  runOnce: bool(process.env.RUN_ONCE, false),
  tz: process.env.CRON_TZ || 'Europe/Kyiv',
  maxSendsPerRun: num(process.env.MAX_SENDS_PER_RUN, 25),
  // How many list pages to page through per supplier when scanning (today's
  // requests are at the top, so a few pages is plenty).
  maxListPages: num(process.env.AVIA_MAX_LIST_PAGES, 5),

  // --- matching: suppliers -------------------------------------------------
  // Suppliers are matched to the "Постачальник" (filter[partner_id]) dropdown
  // BY NAME at runtime, so no hard-coded partner IDs are needed. You can
  // override the names via AVIA_SUPPLIERS, or pin exact partner IDs via
  // AVIA_SUPPLIER_IDS (comma-separated, same order) if matching ever fails.
  supplierNames: list(process.env.AVIA_SUPPLIERS, [
    'DRCT',
    'Tickets.ua',
    'Fly One Avia',
    'Skyup',
  ]),
  supplierIdsOverride: list(process.env.AVIA_SUPPLIER_IDS, []),

  // --- matching: statuses --------------------------------------------------
  // Status labels exactly as they appear in the Status filter / row text.
  targetStatuses: list(process.env.AVIA_STATUSES, [
    'New reservation',
    'In Work',
    'Confirmed Print',
  ]),

  // --- matching: booking date ----------------------------------------------
  // 'today'          -> only requests whose booking (request) date is today.
  // 'today_or_later' -> today and later (rarely needed).
  bookingDateMode: (process.env.AVIA_BOOKING_DATE || 'today').toLowerCase(),

  // --- the message ---------------------------------------------------------
  message: {
    // Department option label in the chat composer.
    department: process.env.AVIA_DEPARTMENT || 'Авіа',
    // Message-subject option label. Backslashes are literal in the live UI.
    subject:
      process.env.AVIA_SUBJECT ||
      'Бронювання на регулярному рейсі (ТІКЕТСИ\\ДРСТ\\СКАЙ АП)',
    // Loose regex used to find the subject <option> if the exact label differs
    // slightly. Uses \S (not \w) so it matches Cyrillic letters.
    subjectRe: new RegExp(process.env.AVIA_SUBJECT_RE || 'регулярн\\S*\\s*рейс', 'i'),
    // After choosing dept+subject the site AUTO-FILLS the textarea. The bot
    // verifies the filled text CONTAINS this phrase before sending. It never
    // overwrites the auto-filled text.
    expectedContains:
      process.env.AVIA_EXPECTED_CONTAINS || 'заброньований на регулярному рейсі',
    // Recipient: "everyone" (default) or "administrators".
    audience: (process.env.AVIA_AUDIENCE || 'everyone').toLowerCase(),
  },

  // --- browser ---
  headless: bool(process.env.HEADLESS, true),
  slowMo: num(process.env.SLOWMO_MS, 0),
  navTimeout: num(process.env.NAV_TIMEOUT_MS, 45000),

  // --- data / debug ---
  dataDir: process.env.DATA_DIR || './data',
  screenshotOnError: bool(process.env.SCREENSHOT_ON_ERROR, true),

  // --- telegram (optional) ---
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // --- google sheets report (separate spreadsheet for AVIA) ---
  report: {
    enabled: bool(process.env.REPORT_ENABLED, false),
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEETS_TAB || 'Avia',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// Phrases that mean "the AVIA regular-flight message was ALREADY sent" — used to
// scan the chat history so we never send twice (primary duplicate guard). These
// use \S (not \w) so they match Cyrillic word endings.
export const ALREADY_SENT_PATTERNS = [
  /заброньован\S*\s+на\s+регулярн\S*\s+рейс/i,
  /тур\s+заброньован\S*\s+на\s+регулярн\S*\s+рейс/i,
  /Інформуємо,?\s*що\s+ваш\s+тур\s+заброньован/i,
];

// ----------------------------------------------------------------------------
// SELECTORS — login + chat copied from the working transfer bot. Tune against
// the live DOM with: npm run codegen.
// ----------------------------------------------------------------------------
export const sel = {
  login: {
    email: [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[name*="user" i]',
      '#loginform-username',
    ],
    password: ['input[type="password"]', 'input[name*="pass" i]', '#loginform-password'],
    submit: [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Увійти")',
      'button:has-text("Вход")',
    ],
    loggedInMarker: ['text=REQUESTS', 'text=Partners and users', 'text=Транспортал'],
  },

  requests: {
    resultRows: 'table tbody tr, .grid-view tbody tr, .items tbody tr',
    chatIconInRow: 'a[onclick*="chatbox:open"]',
    partnerSelect: 'select[name="filter[partner_id]"]',
    statusSelect: 'select[name="filter[status_ids][]"]',
  },

  chat: {
    panel: [
      'div.fixed.top-0.right-0:has(textarea)',
      '.tailwind-scope:has(textarea[placeholder*="Compose" i])',
      '.fixed.right-0.shadow-2xl',
    ],
    messages: '.message, .chat-message, [class*="message" i]',
    departmentSelect: [
      'div.flex.flex-col:has(> label:has-text("Department")) select',
      'div.fixed.top-0.right-0 select >> nth=0',
    ],
    subjectSelect: [
      'div.flex.flex-col:has(> label:has-text("Message subject")) select',
      'div.fixed.top-0.right-0 select >> nth=1',
    ],
    textArea: ['textarea[placeholder*="Compose" i]', 'div.fixed.top-0.right-0 textarea'],
    toEveryoneButton: [
      'button:has-text("To everyone")',
      ':is(button,label):has-text("To everyone")',
    ],
    toAdministratorsButton: ['button:has-text("Send to administrators")'],
    sendButton: ['button:text-is("Send")', 'button:has-text("Send")'],
    closeButton: [
      'div.fixed.top-0.right-0 button[aria-label*="close" i]',
      'button[aria-label*="close" i]',
    ],
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.email) problems.push('TRAVELON_EMAIL is not set');
  if (!config.password) problems.push('TRAVELON_PASSWORD is not set');
  if (!config.supplierNames.length) problems.push('AVIA_SUPPLIERS is empty');
  if (!config.targetStatuses.length) problems.push('AVIA_STATUSES is empty');
  if (!config.message.department) problems.push('AVIA_DEPARTMENT is empty');
  if (!config.message.subject) problems.push('AVIA_SUBJECT is empty');
  return problems;
}
