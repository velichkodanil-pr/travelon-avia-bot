# TravelON AVIA Message Bot

Бот, що цілодобово (24/7) стежить за **новими заявками АВІА** на
[travelon.to](https://travelon.to) і автоматично надсилає в чат заявки
повідомлення «Бронювання на регулярному рейсі», повторюючи ручний процес.

Працює як **headless-браузер (Playwright) у Docker**, розгортається на
**Railway**, код — на **GitHub** (ви комітите через GitHub Desktop).

Окремий додаток, не пов'язаний із `travelon-transfer-bot`, але використовує ті
самі (перевірені) селектори входу та чату.

---

## Що він робить (один цикл, кожні 5 хв)

1. Логіниться в TravelON (логін+пароль із змінних Railway).
2. Відкриває журнал заявок `/book/bundle/index`.
3. Для **кожного** постачальника зі списку (**DRCT, Tickets.ua, Fly One Avia,
   Skyup**) ставить фільтр за постачальником + статусами
   (**New reservation, In Work, Confirmed Print**) і чистить усі фільтри дат.
4. Зі списку залишає тільки заявки з **датою бронювання = сьогодні**.
5. Для кожної такої заявки:
   - відкриває чат;
   - обирає **Department = «Авіа»**;
   - обирає **Message subject = «Бронювання на регулярному рейсі
     (ТІКЕТСИ\ДРСТ\СКАЙ АП)»**;
   - **чекає**, поки в полі повідомлення з'явиться авто-текст, і **перевіряє**,
     що він містить фразу «…*заброньований на регулярному рейсі*…»;
   - перевіряє, що це повідомлення ще **не** було надіслано (скан історії чату);
   - натискає **Send**.
6. Надіслані заявки більше не чіпає.

> Бот **ніколи не перезаписує** авто-текст — лише перевіряє його й надсилає.

Захист від дублів подвійний: (1) скан історії чату на ключову фразу; (2)
локальний журнал уже опрацьованих заявок (`data/sent.json`).

---

## ⚠️ Важливо

- **DRY-RUN увімкнено за замовчуванням** (`DRY_RUN=true`): бот знаходить заявки,
  обирає відділ+тему, перевіряє авто-текст і **лише пише в лог**, кому БУ
  надіслав. Нічого не надсилає. Перемкніть на `false`, коли логи будуть
  правильні.
- Постачальники зіставляються з випадайкою **за назвою** — partner_id вписувати
  не треба. Якщо назва в системі трохи інша, виправте `AVIA_SUPPLIERS` або
  задайте `AVIA_SUPPLIER_IDS`.
- Пароль ніде в коді немає — лише як змінна Railway.

---

## Локальний запуск (перевірка)

Потрібен Node.js 20+.

```bash
cd travelon-avia-bot
npm install
npx playwright install chromium

cp .env.example .env        # впишіть TRAVELON_EMAIL / TRAVELON_PASSWORD
# Щоб бачити браузер:  HEADLESS=false   у .env

npm run once                # один цикл (DRY-RUN) і вихід
```

У логах видно: яких постачальників/статуси знайдено, скільки сьогоднішніх
заявок, і кому БУ надіслано. Скриншоти помилок — у `data/`.

---

## Розгортання на Railway (через GitHub Desktop)

1. **GitHub Desktop** → додайте папку `travelon-avia-bot` як репозиторій
   (File → Add local repository → … → Create a repository), зробіть перший
   коміт і **Publish** на GitHub. (`.env`, `data/`, `node_modules/` не
   потраплять — вони в `.gitignore`.)
2. **Railway** → New Project → Deploy from GitHub repo → виберіть цей репозиторій.
   Railway сам побачить `Dockerfile` (Playwright+Chromium уже всередині).
3. Сервіс → вкладка **Variables**, додайте щонайменше:

   | Змінна | Значення |
   |---|---|
   | `TRAVELON_EMAIL` | ваш email |
   | `TRAVELON_PASSWORD` | ваш пароль |
   | `DRY_RUN` | `true` (поки тестуєте) |
   | `CHECK_CRON` | `*/5 * * * *` |
   | `CRON_TZ` | `Europe/Kyiv` |

4. **Deploy** → вкладка **Logs** → перевірте, що бот знаходить правильні заявки.
5. Коли все ок — змініть `DRY_RUN` на `false` (Railway перезапустить сервіс).
   Тепер бот надсилає реально.

### (Опційно) Збереження стану між перезапусками
Service → Settings → **Volumes** → Add Volume, mount path `/app/data`. Не
обов'язково — скан історії чату й так не дасть надіслати двічі.

---

## Google Sheets — звіт

Окрема таблиця для AVIA. Один рядок на заявку (upsert по № заявки), стовпці:
№ заявки · Постачальник · Статус · Дата бронювання · Відправлено · Дата/час
обробки · Результат · Примітки.

Увімкнення — змінні Railway:

```
REPORT_ENABLED=true
GOOGLE_SHEETS_SPREADSHEET_ID=<ID з URL таблиці>
GOOGLE_SHEETS_TAB=Avia
GOOGLE_OAUTH_CLIENT_ID=<...>
GOOGLE_OAUTH_CLIENT_SECRET=<...>
GOOGLE_OAUTH_REFRESH_TOKEN=<...>   # scope: .../auth/spreadsheets
```

Refresh token має бути від Google-акаунта, що **володіє** таблицею (тоді
ділитися ні з ким не треба). Шапку таблиці бот створює сам при першому записі.

---

## Налаштування фраз/назв (без зміни коду)

Усе керується змінними (див. `.env.example`):
`AVIA_SUPPLIERS`, `AVIA_STATUSES`, `AVIA_BOOKING_DATE`, `AVIA_DEPARTMENT`,
`AVIA_SUBJECT`, `AVIA_SUBJECT_RE`, `AVIA_EXPECTED_CONTAINS`.

Якщо сайт колись змінить вёрстку — CSS-селектори зібрані в одному місці:
об'єкт `sel` у [`src/config.js`](./src/config.js). Знайти нові:
`npm run codegen`.

---

## Структура

```
travelon-avia-bot/
├─ src/
│  ├─ index.js      # запуск + планувальник (node-cron, кожні 5 хв)
│  ├─ runCycle.js   # один повний цикл
│  ├─ travelon.js   # Playwright-клієнт (логін, фільтр, чат, перевірка+Send)
│  ├─ config.js     # змінні + СЕЛЕКТОРИ + фрази
│  ├─ report.js     # Google-таблиця (звіт)
│  ├─ store.js      # локальний журнал опрацьованих заявок
│  ├─ notify.js     # опційні сповіщення в Telegram
│  └─ logger.js
├─ Dockerfile · railway.json · .env.example · README.md
```
