import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptVault, decryptVault, readVault, writeVault } from '../src/vault.js';

const obj = { accounts: [{ id: 'ab12', companyId: 'hapoalim', label: 'פועלים', credentials: { userCode: 'u', password: 'p' } }] };

test('round trip', () => {
  const buf = encryptVault(obj, 'pass');
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'DBV1');
  assert.deepEqual(decryptVault(buf, 'pass'), obj);
});

test("wrong passphrase throws a clear error", () => {
  const buf = encryptVault(obj, 'pass');
  assert.throws(() => decryptVault(buf, 'nope'), { message: 'Wrong vault passphrase or corrupted file' });
});

test('tampered byte throws', () => {
  const buf = encryptVault(obj, 'pass');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decryptVault(buf, 'pass'), /passphrase/);
});

test('bad magic and short buffers throw', () => {
  const buf = encryptVault(obj, 'pass');
  buf[0] = 0x58;
  assert.throws(() => decryptVault(buf, 'pass'), /passphrase/);
  assert.throws(() => decryptVault(Buffer.alloc(10), 'pass'), /passphrase/);
});

test('writeVault/readVault file round trip with 0600 mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const file = path.join(dir, 'sub', 'vault.enc');
  writeVault(file, obj, 'pass');
  assert.deepEqual(readVault(file, 'pass'), obj);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['vault.enc']);
});
