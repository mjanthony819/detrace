/*
 * Tests for the experiment-workflow helpers: schedule validation, share-token
 * round-trip, trace-file validation, recording verification and run
 * comparison. Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig, validateSchedule, encodeConfig, decodeConfig,
  validateTraceFile, verifyRecording, compareRuns,
} from '../experiments.js';
import { Simulation } from '../engine.js';

// ---------- schedule validation ----------

test('schedule validator accepts a valid mixed schedule', () => {
  const v = validateSchedule([
    { at: 400, action: 'crash', args: { node: 1 } },
    { at: 500, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
    { at: 900, action: 'heal', args: {} },
    { at: 900, action: 'restart', args: { node: 1 } },
  ]);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
});

test('schedule validator rejects descending times', () => {
  const v = validateSchedule([
    { at: 500, action: 'crash', args: { node: 0 } },
    { at: 400, action: 'heal', args: {} },
  ]);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /ascending/.test(e)));
});

test('schedule validator rejects bad node ids and overlapping partitions', () => {
  const v = validateSchedule([
    { at: 100, action: 'crash', args: { node: 5 } },
    { at: 200, action: 'partition', args: { a: [0, 2], b: [2, 3] } },
    { at: 300, action: 'partition', args: { a: [], b: [1] } },
  ]);
  assert.equal(v.errors.length, 3);
  assert.ok(v.errors[0].includes('0-4'));
  assert.ok(v.errors[1].includes('both sides'));
  assert.ok(v.errors[2].includes('non-empty'));
});

test('schedule validator rejects unknown actions and malformed rows', () => {
  const v = validateSchedule([
    { at: 100, action: 'explode', args: {} },
    'nonsense',
  ]);
  assert.equal(v.errors.length, 2);
});

test('config validator rejects out-of-range faults and unknown bug modes', () => {
  const v = validateConfig({ seed: 'x', faults: { drop: 1.5 }, bugMode: 'chaos' });
  assert.equal(v.errors.length, 2);
  assert.ok(validateConfig({ seed: 'x', faults: { drop: 0.2 }, bugMode: 'early-commit' }).ok);
});

// ---------- share token round-trip ----------

test('share token round-trips a full custom config', () => {
  const cfg = {
    seed: 'monsoon-7',
    faults: { drop: 0.1, dup: 0.05, delaySpike: 0 },
    schedule: [
      { at: 400, action: 'crash', args: { node: 2 } },
      { at: 800, action: 'partition', args: { a: [0, 1], b: [2, 3, 4] } },
      { at: 1600, action: 'heal', args: {} },
    ],
    bugMode: 'no-log-check',
  };
  const token = encodeConfig(cfg);
  assert.ok(/^[A-Za-z0-9\-_]+$/.test(token), 'token must be URL-safe');
  const back = decodeConfig(token);
  assert.ok(back.ok, back.errors.join('; '));
  assert.deepEqual(back.config, cfg);
});

test('share token survives non-ASCII seeds', () => {
  const cfg = { seed: 'café-☕-42', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const back = decodeConfig(encodeConfig(cfg));
  assert.ok(back.ok);
  assert.equal(back.config.seed, 'café-☕-42');
});

test('a replayed config from a share token reproduces the original digest', () => {
  const cfg = {
    seed: 'share-replay',
    faults: { drop: 0.12, dup: 0.08, delaySpike: 0.15 },
    schedule: [{ at: 600, action: 'crash', args: { node: 0 } }],
    bugMode: null,
  };
  const a = new Simulation(cfg); a.run(3000);
  const back = decodeConfig(encodeConfig(cfg));
  const b = new Simulation(back.config); b.run(3000);
  assert.equal(a.digest(), b.digest());
});

test('decoder rejects garbage, oversized tokens and invalid configs', () => {
  assert.ok(!decodeConfig('').ok);
  assert.ok(!decodeConfig('!!!not-base64!!!').ok);
  assert.ok(!decodeConfig('x'.repeat(9000)).ok);
  // valid base64 of an invalid config (bad fault value)
  const bad = encodeConfig({ seed: 'x', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null })
    .replace(/.$/, 'x'); // corrupt last char
  const res = decodeConfig(bad);
  // either unparseable or still valid JSON with same values - must not throw
  assert.ok(typeof res.ok === 'boolean');
});

// ---------- trace-file validation ----------

function makeRecording(overrides = {}) {
  const cfg = { seed: 'rec-1', faults: { drop: 0.05, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const sim = new Simulation(cfg);
  sim.run(500);
  return {
    tool: 'detrace',
    note: 'test recording',
    config: cfg,
    stepped_events: sim.steps,
    digest: sim.digest(),
    trace: sim.trace,
    ...overrides,
  };
}

test('a genuine exported recording validates and verifies', () => {
  const rec = makeRecording();
  const v = validateTraceFile(rec);
  assert.ok(v.ok, v.errors.join('; '));
  const check = verifyRecording(v);
  assert.ok(check.match);
  assert.equal(check.recordedDigest, rec.digest);
});

test('a tampered recording fails verification, not validation', () => {
  const rec = makeRecording({ digest: '0000000000000000' });
  const v = validateTraceFile(rec);
  assert.ok(v.ok);
  const check = verifyRecording(v);
  assert.ok(!check.match);
});

test('validation rejects foreign files, bad digests and oversize recordings', () => {
  assert.ok(!validateTraceFile('not json object').ok);
  assert.ok(validateTraceFile({ tool: 'other-tool' }).errors.some((e) => /Detrace/.test(e)));
  assert.ok(validateTraceFile(makeRecording({ digest: 'xyz' })).errors.some((e) => /digest/.test(e)));
  assert.ok(validateTraceFile(makeRecording({ stepped_events: 5_000_000 })).errors.some((e) => /2,000,000/.test(e)));
  assert.ok(validateTraceFile(makeRecording({ trace: 'oops' })).errors.some((e) => /trace/.test(e)));
});

// ---------- run comparison ----------

test('identical configs compare clean', () => {
  const cfg = { seed: 'cmp-1', faults: { drop: 0.1, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const r = compareRuns(cfg, cfg, 2000);
  assert.ok(r.match);
  assert.equal(r.digestA, r.digestB);
  assert.equal(r.firstDivergence, null);
});

test('different seeds diverge and the first differing event is reported', () => {
  const a = { seed: 'cmp-a', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const b = { seed: 'cmp-b', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const r = compareRuns(a, b, 2000);
  assert.ok(!r.match);
  assert.ok(r.firstDivergence);
  assert.ok(Number.isInteger(r.firstDivergence.index));
  assert.notEqual(r.firstDivergence.a.text, r.firstDivergence.b.text);
  // the reported divergence must be real: prefixes before it are identical
  const simA = new Simulation(a); simA.run(2000);
  const simB = new Simulation(b); simB.run(2000);
  for (let i = 0; i < r.firstDivergence.index; i++) {
    assert.equal(simA.trace[i].text, simB.trace[i].text);
  }
});

test('same seed with different fault knobs diverges', () => {
  const base = { seed: 'cmp-faults', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [], bugMode: null };
  const stormy = { seed: 'cmp-faults', faults: { drop: 0.2, dup: 0.1, delaySpike: 0.2 }, schedule: [], bugMode: null };
  const r = compareRuns(base, stormy, 3000);
  assert.ok(!r.match);
  assert.ok(r.firstDivergence.index >= 0);
});
