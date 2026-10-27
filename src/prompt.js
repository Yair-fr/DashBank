// Uses the callback readline Interface on purpose: only it routes echo through the
// overridable `_writeToOutput` hook. The readline/promises Interface has no such hook,
// so muting it silently does nothing and typed secrets are echoed.
import readline from 'node:readline';

/**
 * Line prompter with a hidden-input mode for passphrases and passwords.
 * returns { ask(q), askHidden(q), close() }
 */
export function createPrompt({ input = process.stdin, output = process.stdout, terminal = Boolean(input.isTTY) } = {}) {
  let muted = false;
  const rl = readline.createInterface({ input, output, terminal });
  const origWrite = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted) origWrite(s); };

  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  return {
    async ask(q) {
      return (await question(q)).trim();
    },
    async askHidden(q) {
      output.write(q);
      muted = true;
      try {
        return (await question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    close: () => rl.close(),
  };
}
