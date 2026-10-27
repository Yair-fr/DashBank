import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompt } from '../src/prompt.js';

function io() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c) => { written += c; });
  return { input, output, written: () => written };
}

test('ask returns the trimmed answer', async () => {
  const s = io();
  const p = createPrompt({ input: s.input, output: s.output });
  const answer = p.ask('name: ');
  s.input.write('  dana \n');
  assert.equal(await answer, 'dana');
  p.close();
});

test('askHidden returns the answer without echoing it', async () => {
  const s = io();
  const p = createPrompt({ input: s.input, output: s.output, terminal: true });
  const answer = p.askHidden('pass: ');
  s.input.write('hunter22\n');
  assert.equal(await answer, 'hunter22');
  p.close();
  assert.ok(s.written().includes('pass: '));
  assert.ok(!s.written().includes('hunter22'));
});

test('piped input: lines arriving before the question are not lost', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const p = createPrompt({ input, output, terminal: false });
  input.end('first\nsecret\nthird\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(await p.ask('a? '), 'first');
  assert.equal(await p.askHidden('b? '), 'secret');
  assert.equal(await p.ask('c? '), 'third');
  await assert.rejects(p.ask('d? '), /input closed/);
  p.close();
});
