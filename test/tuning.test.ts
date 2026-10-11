import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TUNING, KNOBS, tuning } from '../src/core/tuning.ts';
import { Floor } from '../src/core/floor.ts';

test('settings take valid overrides and refuse unknown names and values out of range', () => {
  assert.deepEqual(tuning({}), DEFAULT_TUNING);
  assert.equal(tuning({ compactTokens: 1000000 }).compactTokens, 1000000);
  assert.throws(() => tuning({ holdMs: 5 }), /Unknown tuning setting/);
  assert.throws(() => tuning({ thinkMs: -1 }), /from 0 to 5000/);
  assert.throws(() => tuning({ thinkMs: '2000' }), /must be a number/);
  for (const [name, knob] of Object.entries(KNOBS)) {
    const value = DEFAULT_TUNING[name as keyof typeof DEFAULT_TUNING];
    assert.ok(value >= knob.min && value <= knob.max && knob.describe.length > 40, name);
  }
});

test('with a pause time, updates may land while the operator talks and wait once they pause', () => {
  const floor = new Floor({ thinkMs: 2000, pauseMs: 700 }), quiet = new Floor({ thinkMs: 2000 });
  floor.hear(10000); quiet.hear(10000);
  assert.equal(floor.held(10300), false, 'mid-speech: words keep arriving');
  assert.equal(quiet.held(10300), true);
  assert.equal(floor.held(10800), true, 'a pause that could end the turn');
  assert.equal(floor.held(12100), false);
});
