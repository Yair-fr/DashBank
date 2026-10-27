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
