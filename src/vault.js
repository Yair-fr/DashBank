import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('DBV1', 'latin1');
const SALT = 16, IV = 12, TAG = 16;
const BAD = 'Wrong vault passphrase or corrupted file';

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptVault(obj, passphrase) {
  const salt = crypto.randomBytes(SALT);
  const iv = crypto.randomBytes(IV);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

export function decryptVault(buf, passphrase) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + SALT + IV + TAG || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error(BAD);
  }
  const salt = buf.subarray(4, 4 + SALT);
  const iv = buf.subarray(4 + SALT, 4 + SALT + IV);
  const tag = buf.subarray(4 + SALT + IV, 4 + SALT + IV + TAG);
  const ct = buf.subarray(4 + SALT + IV + TAG);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error(BAD);
  }
}

export function readVault(file, passphrase) {
  return decryptVault(fs.readFileSync(file), passphrase);
}

export function writeVault(file, obj, passphrase) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, encryptVault(obj, passphrase), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
