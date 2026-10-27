// Interactive setup of the dashboard login: password + TOTP (authenticator app) + recovery codes.
// Usage: npm run auth-setup
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPrompt } from '../src/prompt.js';
import { MIN_PASSWORD_LENGTH } from '../src/auth/password.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../src/auth/totp.js';
import { loadAuthStore, saveAuthStore, buildUser, generateRecoveryCodes, normalizeUsername } from '../src/auth/store.js';

const GEN_SECRET = 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

export async function runAuthSetup({ config, prompt, print = console.log, now = () => Date.now() }) {
  const secret = config.auth.secret;
  if (!secret || secret.length < 32) {
    throw new Error(`חסר AUTH_SECRET (לפחות 32 תווים) בקובץ .env. צור אחד עם:\n  ${GEN_SECRET}`);
  }
  print('DashBank - הגדרת התחברות ללוח הבקרה (סיסמה + אימות דו-שלבי)\n');

  const store = loadAuthStore(config.auth.filePath) ?? { users: [] };
  if (store.users.length) print(`משתמשים קיימים: ${store.users.map((u) => u.username).join(', ')}`);
  const fallback = store.users[0]?.username || 'admin';
  const username = normalizeUsername((await prompt.ask(`שם משתמש [${fallback}]: `)) || fallback);
  if (!/^[a-z0-9._@-]{1,64}$/.test(username)) throw new Error('שם משתמש לא תקין (אותיות לטיניות, ספרות, . _ - @)');

  const password = await prompt.askHidden(`סיסמה (לפחות ${MIN_PASSWORD_LENGTH} תווים): `);
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`הסיסמה קצרה מ-${MIN_PASSWORD_LENGTH} תווים`);
  const again = await prompt.askHidden('הקלד שוב לאימות: ');
  if (again !== password) throw new Error('הסיסמאות אינן תואמות');

  const totpSecret = generateSecret();
  print('\nהוסף את DashBank לאפליקציית אימות (Google Authenticator / Microsoft Authenticator / Aegis):');
  print('  "הוספת חשבון" ← "הזנת מפתח הגדרה", סוג: מבוסס זמן');
  print(`  מפתח: ${totpSecret.match(/.{1,4}/g).join(' ')}`);
  print(`  או קישור: ${otpauthUrl({ secret: totpSecret, account: username })}\n`);

  let confirmed = false;
  for (let i = 0; i < 3 && !confirmed; i++) {
    const code = await prompt.ask('הזן את הקוד בן 6 הספרות שמופיע באפליקציה: ');
    confirmed = verifyTotp(totpSecret, code, { time: Math.floor(now() / 1000), window: 1 });
    if (!confirmed) print('קוד שגוי. ודא שהשעון בטלפון מכוון אוטומטית.');
  }
  if (!confirmed) throw new Error('האימות נכשל - לא נשמר דבר. הרץ שוב.');

  const recoveryCodes = generateRecoveryCodes(8);
  const user = await buildUser({ username, password, totpSecret, recoveryCodes }, secret);
  store.users = [...store.users.filter((u) => u.username !== username), user];
  saveAuthStore(config.auth.filePath, store);

  print('\nקודי שחזור (חד-פעמיים) - שמור אותם במקום בטוח, הם לא יוצגו שוב:');
  for (const c of recoveryCodes) print(`  ${c}`);
  print(`\nנשמר: ${config.auth.filePath}`);
  print('חיבורים קיימים של המשתמש נותקו. שינוי AUTH_SECRET בעתיד יחייב הרצה חוזרת של npm run auth-setup.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  const prompt = createPrompt();
  try {
    await runAuthSetup({ config: loadConfig(), prompt });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}
