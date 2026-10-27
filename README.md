# DashBank 💳📊

**מעקב אחרי כל שקל: חשבון בנק, כרטיסי אשראי והוראות קבע, בדאשבורד אחד, עם התראה לנייד על כל חיוב.**
*Track every shekel across your Israeli bank account and credit cards, with a live dashboard and a phone notification for every charge. English summary at the bottom.*

---

## איך זה עובד

```
המחשב שלך (דלוק)                                     הנייד שלך
┌───────────────────────────────────────────┐      ┌──────────────────────┐
│ כל 30 דק': כניסה אוטומטית לאתרי            │      │ 🔔 Telegram / ntfy    │
│ הפועלים · ישראכרט · כאל · מקס              │─────▶│ "💳 ₪84.90 · שופרסל"   │
│   ↓                                       │      ├──────────────────────┤
│ זיהוי עסקאות חדשות → קטגוריה → הוראות קבע  │◀────▶│ 📱 אפליקציית DashBank │
│   ↓                                       │ VPN  │   (PWA דרך Tailscale) │
│ SQLite מקומי + דאשבורד (127.0.0.1 בלבד)     │      └──────────────────────┘
└───────────────────────────────────────────┘
```

- **אין API ציבורי לבנקים בישראל.** DashBank משתמש בספריית הקוד הפתוח [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers), שנכנסת לאתר הבנק עם שם המשתמש והסיסמה שלך, בדיוק כמו שאתה נכנס בעצמך.
- **ההתראות לא מיידיות.** המערכת בודקת כל 30 דקות (אפשר לשנות), ועסקאות אשראי מופיעות באתרי החברות לפעמים רק אחרי כמה שעות.
- **הכל נשאר אצלך.** הסיסמאות נשמרות מוצפנות (AES-256-GCM), הנתונים נשמרים בקובץ מקומי, והשרת פתוח רק למחשב עצמו.

## מה יש בפנים

| תכונה | פירוט |
|---|---|
| 🏦 מקורות | בנק הפועלים, ישראכרט, כאל, מקס. נתמכים גם לאומי, דיסקונט, מזרחי, אמקס ועוד |
| 📊 דאשבורד | יתרה, הכנסות, הוצאות, תזרים נטו, גרף 12 חודשים, פילוח קטגוריות, הוצאה מצטברת יומית |
| 🔁 הוראות קבע ומנויים | זיהוי אוטומטי (אותו בית עסק, סכום ±15%, מחזור חודשי/שבועי/שנתי) ותאריך החיוב הבא |
| 🧮 בלי ספירה כפולה | החיוב החודשי של כרטיס האשראי בעו"ש לא נספר שוב כהוצאה |
| 🔔 התראות | Telegram ו-ntfy על כל חיוב חדש. בסנכרון הראשון נשלח סיכום אחד, לא מאות הודעות |
| 🔐 אבטחה | כספת סיסמאות מוצפנת, השרת מאזין רק ל-127.0.0.1, כותרות אבטחה ו-CSP |
| 📱 אנדרואיד | PWA שמותקנת למסך הבית ונפתחת גם בלי חיבור |
| 🧪 בדיקות | `npm test` (node:test). אין קריאות רשת אמיתיות בבדיקות |

---

## התקנה (10 דקות)

### 1. דרישות
- **Node.js 22.13 ומעלה**: https://nodejs.org (גרסת LTS)
- Git, או הורדה של ה-ZIP מ-GitHub

### 2. הורדה והתקנה
```bash
git clone https://github.com/Yair-fr/DashBank.git
cd DashBank
npm install
```

### 3. קודם לראות איך זה נראה (מצב דמו, בלי סיסמאות)
```bash
npm run demo
```
פתח את http://127.0.0.1:3456 ותראה דאשבורד עם 6 חודשים של נתונים מדומים.

### 4. הגדרת התראות לנייד

**Telegram (מומלץ):**
1. ב-Telegram, פתח שיחה עם **@BotFather** ושלח `/newbot`. שמור את ה-token שתקבל.
2. שלח הודעה כלשהי לבוט החדש שלך.
3. פתח שיחה עם **@userinfobot** כדי לקבל את ה-chat id שלך.

**ntfy (אופציונלי):**
1. התקן את האפליקציה [ntfy](https://play.google.com/store/apps/details?id=io.heckel.ntfy) מ-Google Play.
2. בחר שם topic ארוך ואקראי, למשל `dashbank-8f3k2m9x7q1w4z6b`, והירשם אליו באפליקציה.
3. ⚠️ ב-ntfy.sh הציבורי כל מי שיודע את שם ה-topic יכול לקרוא את ההודעות. לכן שם ארוך ואקראי הוא חובה.

עכשיו:
```bash
cp .env.example .env        # ב-Windows:  copy .env.example .env
```
ערוך את `.env` ומלא את `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` ו/או `NTFY_TOPIC`. אחר כך הרץ:
```bash
npm run test-notify         # אמורה להגיע לנייד הודעת בדיקה
```

### 5. הכנסת חשבונות הבנק והאשראי (מוצפן)
```bash
npm run setup
```
- בפעם הראשונה תבחר **סיסמת כספת** (master passphrase). בלעדיה אי אפשר לפתוח את הסיסמאות לבנק, אז אל תשכח אותה.
- הוסף חשבון לכל מוסד:

| מוסד | מה צריך |
|---|---|
| הפועלים | קוד משתמש + סיסמה |
| ישראכרט | ת"ז + 6 ספרות אחרונות של הכרטיס + סיסמה |
| כאל | שם משתמש + סיסמה |
| מקס | שם משתמש + סיסמה |

### 6. הפעלה
```bash
npm start
```
- המערכת שואלת את סיסמת הכספת, מריצה סנכרון ראשון (טעינת היסטוריה של 6 חודשים, יכול לקחת כמה דקות) ושולחת לנייד סיכום אחד.
- מעכשיו היא בודקת כל 30 דקות, וכל חיוב חדש מגיע לנייד.
- הדאשבורד זמין ב-http://127.0.0.1:3456.

סנכרון חד-פעמי בלי להשאיר שרת פתוח: `npm run sync`

### 7. הפעלה אוטומטית כשהמחשב נדלק
```bash
npm run autostart              # Windows / macOS / Linux
npm run autostart -- --remove  # ביטול
```
> הפעלה אוטומטית דורשת `DASHBANK_PASSPHRASE` בתוך `.env`, כי אף אחד לא יהיה שם כדי להקליד אותה. עשה את זה **רק** במחשב שהוא שלך בלבד, ועם הצפנת דיסק פעילה (BitLocker ב-Windows, FileVault ב-Mac).

---

## 📱 התקנה על אנדרואיד (PWA + Tailscale)

השרת פתוח רק למחשב עצמו, וזה בכוונה. כדי שהנייד יגיע אליו בצורה מאובטחת, משתמשים ב-**Tailscale**: VPN פרטי וחינמי בין המכשירים שלך, בלי לפתוח פורטים לאינטרנט.

1. התקן Tailscale [על המחשב](https://tailscale.com/download) ועל הנייד ([Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn)), והתחבר באותו חשבון בשני המכשירים.
2. בלוח הניהול של Tailscale, בלשונית **DNS**, הפעל **MagicDNS** ו-**HTTPS Certificates**.
3. במחשב:
   ```bash
   tailscale serve --bg 3456
   ```
   תקבל כתובת בסגנון `https://my-pc.tail1234.ts.net`.
4. בנייד, פתח את הכתובת ב-Chrome, לחץ על ⋮ ובחר **"התקנת אפליקציה"** (או "הוספה למסך הבית").
5. יופיע אייקון DashBank במסך הבית. האפליקציה נפתחת במסך מלא, ובלי חיבור היא מציגה את הנתונים האחרונים.

---

## 🐳 שרת ביתי / Raspberry Pi (Docker)
```bash
cp .env.example .env    # מלא כולל DASHBANK_PASSPHRASE
docker compose run --rm dashbank node scripts/setup.js   # הוספת חשבונות
docker compose up -d
tailscale serve --bg 3456
```

---

## ⚙️ הגדרות (`.env`)

| משתנה | ברירת מחדל | משמעות |
|---|---|---|
| `PORT` | 3456 | פורט הדאשבורד |
| `SYNC_INTERVAL_MINUTES` | 30 | כל כמה דקות לבדוק (מינימום 10) |
| `MONTHS_BACK` | 6 | כמה חודשי היסטוריה לטעון בפעם הראשונה (עד 12) |
| `NOTIFY_MIN_AMOUNT` | 0 | להתריע רק על חיובים מעל סכום מסוים |
| `DASHBANK_PASSPHRASE` | (ריק) | סיסמת הכספת. אם ריק, המערכת שואלת בכל הפעלה |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | (ריק) | ערוץ Telegram |
| `NTFY_SERVER`, `NTFY_TOPIC`, `NTFY_TOKEN` | ntfy.sh | ערוץ ntfy |
| `NOTIFY_LANG` | he | שפת ההתראות: `he` או `en` |
| `NOTIFY_PRIVACY` | 0 | `1` = כותרת ההתראה (מסך הנעילה) מציגה רק סכום וקטגוריה, בלי שם בית העסק |
| `ACCESSIBILITY_CONTACT` | (ריק) | איש קשר לפניות נגישות בהצהרת הנגישות. אם ריק: "בעל המערכת" |

## 🛠️ פקודות

| פקודה | מה היא עושה |
|---|---|
| `npm run demo` | דאשבורד עם נתונים מדומים |
| `npm run setup` | ניהול חשבונות בכספת המוצפנת |
| `npm start` | שרת + סנכרון כל X דקות + התראות |
| `npm run sync` | סנכרון חד-פעמי ויציאה |
| `npm run test-notify` | הודעת בדיקה לנייד |
| `npm run autostart` | הפעלה אוטומטית כשמתחברים למחשב |
| `npm test` | כל הבדיקות |

## 🧯 פתרון תקלות

| בעיה | פתרון |
|---|---|
| "סיסמת כספת שגויה" | הסיסמה לא נכונה. אם שכחת אותה, מחק את `data/vault.enc` והרץ שוב `npm run setup` |
| סנכרון נכשל עם `INVALID_PASSWORD` | הסיסמה לבנק השתנתה. עדכן אותה ב-`npm run setup` |
| `CHANGE_PASSWORD` / `ACCOUNT_BLOCKED` | היכנס פעם אחת ידנית לאתר המוסד וטפל בבקשה שמופיעה שם |
| `TIMEOUT` | האתר איטי או שהמבנה שלו השתנה. נסה `npm update israeli-bank-scrapers`. צילום מסך של הכשל נשמר ב-`data/failures/` |
| אין התראות | הרץ `npm run test-notify` ובדוק את ה-token, את ה-chat id ואת שם ה-topic |

## ⚖️ משפטי ופרטיות — חשוב לקרוא
- **תנאי השימוש של הבנק:** כניסה אוטומטית עם הסיסמה שלך עלולה להפר את תנאי השימוש של הבנק או של חברת האשראי. **בשימוש אישי זו החלטה שלך.** אל תפיץ את המערכת לאחרים ואל תמכור אותה כשירות בלי ייעוץ משפטי ובלי ספק Open Banking מורשה (חוק שירות מידע פיננסי, התשפ"ב-2021).
- **פרטיות:** תוכן ההתראות עובר דרך Telegram ו-ntfy, שהם צדדים שלישיים.
- **הפרויקט אינו ייעוץ פיננסי או משפטי, ומסופק כמות שהוא (AS-IS).**
- בדיקת התאימות המלאה: [`docs/legal/compliance-check.md`](docs/legal/compliance-check.md)

## 🗂️ מבנה הפרויקט
```
src/
  index.js        נקודת כניסה: שרת + cron + סנכרון
  sync.js         תזמור הסנכרון: scraper → db → קטגוריות → התראות
  scraper.js      עטיפה של israeli-bank-scrapers (כשל של חשבון אחד לא מפיל את האחרים)
  db.js           SQLite (node:sqlite), dedupe עם hash
  normalize.js    נרמול עסקאות
  categorize.js   כללי קטגוריות בעברית
  recurring.js    זיהוי הוראות קבע ומנויים
  vault.js        כספת מוצפנת AES-256-GCM + scrypt
  notify/         Telegram, ntfy, פורמט ההודעות
  server.js       Express API + קבצים סטטיים
  demo.js         נתוני דמו דטרמיניסטיים
public/           הדאשבורד (RTL, מצב כהה, PWA)
scripts/          setup, test-notify, autostart
tests/            בדיקות node:test
docs/             spec, תוכנית מימוש, בדיקת תאימות
```

## 🚧 בפיתוח
- [ ] כניסה עם סיסמה + אימות דו-שלבי (TOTP) / Google
- [x] ממשק בעברית ובאנגלית (כפתור עב / EN בכותרת)
- [x] התאמה ל-WCAG 2.1 AA + הצהרת נגישות, מדיניות פרטיות ותנאי שימוש בתוך האפליקציה (קישורים בתחתית הדף)
- [x] ייצוא CSV (כפתור במסך התנועות, נפתח בעברית באקסל)

---

## English summary

DashBank is a **self-hosted** personal finance tracker for Israeli accounts (Bank Hapoalim, Isracard, Cal, Max and others).

- **How it works:** every 30 minutes it logs in to each institution's website with your own credentials, using [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers). New transactions are stored in a local SQLite file, categorised, and checked for standing orders and subscriptions. Each new charge triggers a Telegram and/or ntfy notification.
- **Dashboard:** runs on `127.0.0.1` and installs on Android as a PWA through `tailscale serve`.
- **Credentials:** encrypted at rest with AES-256-GCM and a scrypt-derived key.

```bash
npm install
npm run demo          # try it with fake data
npm run setup         # add bank/card credentials to the encrypted vault
npm start             # dashboard + scheduled sync + notifications
npm test
```

**Caveats:** this is polling, not real time. Automated login may breach your bank's online terms. Not financial or legal advice; provided as-is. See `docs/legal/compliance-check.md`.
