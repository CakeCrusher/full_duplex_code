import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aliasValue, resolveCommand, words } from '../src/core/command.ts';

test("an alias is read as zsh and bash print it, and split into words as the shell would", () => {
  assert.equal(aliasValue('pi=/Users/me/pi/pi-test.sh\n', 'pi'), '/Users/me/pi/pi-test.sh');
  assert.equal(aliasValue("alias pi='node /x/cli.js --flag'\n", 'pi'), 'node /x/cli.js --flag', 'bash quotes the whole value');
  assert.equal(aliasValue(`pi='node "/a b/cli.js"'\n`, 'pi'), 'node "/a b/cli.js"', 'zsh too, keeping the quotes inside it');
  assert.equal(aliasValue(`pi='it'\\''s'\n`, 'pi'), "it's", 'a quote inside the value');
  assert.equal(aliasValue('pipe=other\n', 'pi'), undefined, 'another alias with the same start');
  assert.deepEqual(words('node "/a b/cli.js" --model \'x y\''), ['node', '/a b/cli.js', '--model', 'x y']);
  assert.deepEqual(words('~/bin/pi'), [path.join(os.homedir(), 'bin/pi')]);
});

test("a command is found on the PATH first, then as an alias in the operator's shell", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'agent-checkout.sh'); fs.writeFileSync(script, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  // A stand-in shell that prints aliases as zsh does, for any -ic it is given.
  const shell = path.join(dir, 'shell'); fs.writeFileSync(shell, `#!/bin/sh\ncase "$2" in\n  "alias fake-agent") echo "fake-agent='${script} --checkout'";;\n  "alias broken") echo "broken=/nowhere/agent";;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
  assert.deepEqual(resolveCommand('fake-agent', shell), { command: script, args: ['--checkout'], via: 'alias' });
  assert.equal(resolveCommand('broken', shell), undefined, 'an alias to nothing that runs');
  assert.equal(resolveCommand('missing-agent', shell), undefined);
  assert.deepEqual(resolveCommand('node', shell), { command: 'node', args: [], via: 'path' }, 'the PATH wins without asking the shell');
});
