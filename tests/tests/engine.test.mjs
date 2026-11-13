/*
 * Detrace engine test suite (node:test).
 * Run: node --test tests/
 *
 * These tests back the only reproducibility claim the project makes:
 * within this engine, one config (seed + faults + schedule + bug mode)
 * replays to the identical trace and digest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, runScenario, SCENARIOS, fnv1a32, Fnv64, mulberry32 } from '../engine.js';

const SEEDS = ['detrace-1', 'alpha-7', 'monsoon-99', 'x', 'another-seed-42'];

test('PRNG is deterministic and seed-sensitive', () => {
  const a = mulberry32(fnv1a32('s'));
  const b = mulberry32(fnv1a32('s'));
  const c = mulberry32(fnv1a32('t'));
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
  void c;
});

test('FNV-64 hash is deterministic', () => {
  const h1 = new Fnv64(); h1.add('hello world');
  const h2 = new Fnv64(); h2.add('hello world');
  const h3 = new Fnv64(); h3.add('hello worle');
  assert.equal(h1.hex(), h2.hex());
  assert.notEqual(h1.hex(), h3.hex());
});

test('determinism: same config replays to identical digest and event count', () => {
  for (const seed of SEEDS) {
    for (const scenario of Object.values(SCENARIOS)) {
      const cfg = { seed, faults: scenario.faults, schedule: scenario.schedule, bugMode: scenario.bugMode || null };
      const r1 = runScenario(cfg, 2000);
      const r2 = runScenario(cfg, 2000);
      assert.equal(r1.digest, r2.digest, `digest mismatch for seed=${seed}`);
      assert.equal(r1.events, r2.events);
    }
  }
});

test('different seeds produce different traces', () => {
  const digests = new Set(SEEDS.map(s => runScenario({ seed: s }, 1500).digest));
  assert.ok(digests.size >= SEEDS.length - 1, 'seeds should produce distinct digests');
});

test('time travel: re-running to event k reproduces the same prefix digest', () => {
  const cfg = { seed: 'time-travel', faults: { drop: 0.1, dup: 0.05, delaySpike: 0.1 } };
  const full = new Simulation(cfg);
  full.run(1200);
  // run a fresh sim for fewer stepped events; its recorded trace must be an
  // exact prefix of the full run's recorded trace
  const prefix = new Simulation(cfg);
  prefix.run(700);
  const k = prefix.trace.length;
  assert.ok(k > 50 && k < full.trace.length, `prefix trace length ${k} not a useful prefix`);
  for (let i = 0; i < k; i++) {
    assert.deepEqual(
      { t: prefix.trace[i].t, kind: prefix.trace[i].kind, node: prefix.trace[i].node, text: prefix.trace[i].text },
      { t: full.trace[i].t, kind: full.trace[i].kind, node: full.trace[i].node, text: full.trace[i].text },
      `event ${i} diverged`,
    );
  }
});

test('canonical trace export: JSON round-trip preserves every event', () => {
  const sim = new Simulation({ seed: 'export-check', faults: { drop: 0.05, dup: 0.05, delaySpike: 0 } });
  sim.run(800);
  const exported = JSON.stringify({ config: { seed: 'export-check' }, digest: sim.digest(), trace: sim.trace });
  const parsed = JSON.parse(exported);
  assert.equal(parsed.trace.length, sim.trace.length);
  assert.equal(parsed.digest, sim.digest());
  assert.deepEqual(parsed.trace[123], sim.trace[123]);
});

test('clean run: cluster elects one leader and commits client writes', () => {
  const r = runScenario({ seed: 'clean-check' }, 2500);
  assert.equal(r.violations.length, 0, `unexpected violations: ${JSON.stringify(r.violations.slice(0, 3))}`);
  assert.ok(r.commits >= 5, `expected committed writes, got ${r.commits}`);
});

test('fault storm: safety invariants hold despite loss, duplication and delay spikes', () => {
  for (const seed of SEEDS) {
    const r = runScenario({ seed, faults: { drop: 0.15, dup: 0.1, delaySpike: 0.2 } }, 3000);
    assert.equal(r.violations.length, 0,
      `seed=${seed} violations: ${JSON.stringify(r.violations.slice(0, 3))}`);
  }
});

test('partition: no safety violation during or after a 3|2 split', () => {
  for (const seed of SEEDS) {
    const r = runScenario({
      seed,
      schedule: [
        { at: 500, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
        { at: 1500, action: 'heal', args: {} },
      ],
    }, 4000);
    assert.equal(r.violations.length, 0,
      `seed=${seed} violations: ${JSON.stringify(r.violations.slice(0, 3))}`);
  }
});

test('leader crash: a new leader is elected and writes resume', () => {
  // crash ALL nodes one at a time (the initial leader is whichever times out first,
  // so we crash every node to guarantee the leader is among them)
  const schedule = [];
  for (let k = 0; k < 5; k++) {
    schedule.push({ at: 400 + k * 200, action: 'crash', args: { node: k } });
    schedule.push({ at: 490 + k * 200, action: 'restart', args: { node: k } });
  }
  const sim = new Simulation({ seed: 'crash-check', schedule });
  sim.run(6000);
  const leaders = sim.trace.filter(e => e.kind === 'leader');
  assert.ok(leaders.length >= 2, 'expected at least two elections across rolling crashes');
  const commitsAfter = sim.trace.filter(e => e.kind === 'commit' && e.t > 1400);
  assert.ok(commitsAfter.length > 0, 'expected commits after the rolling crashes');
  assert.equal(sim.violations.length, 0, JSON.stringify(sim.violations.slice(0, 3)));
});

test('crash/restart: persistent log survives a crash', () => {
  const sim = new Simulation({
    seed: 'persist-check',
    schedule: [
      { at: 1500, action: 'crash', args: { node: 2 } },
      { at: 1600, action: 'restart', args: { node: 2 } },
    ],
  });
  // run up to just before the crash
  sim.runUntil(1499);
  const before = sim.getSnapshot().nodes[2].logLen;
  assert.ok(before > 0, 'node should have log entries before crash');
  sim.run(500); // crash + restart
  const after = sim.getSnapshot().nodes[2].logLen;
  assert.ok(after >= before, `log entries lost across crash: ${before} -> ${after}`);
});

test('INJECTED MUTATION early-commit: commit-safety monitor catches divergence', () => {
  const r = runScenario({
    seed: 'bug-check-1',
    bugMode: 'early-commit',
    schedule: [
      { at: 600, action: 'partition', args: { a: [0, 1], b: [2, 3, 4] } },
      { at: 1600, action: 'heal', args: {} },
    ],
  }, 5000);
  const commitViolations = r.violations.filter(v => v.rule === 'commit-safety');
  assert.ok(commitViolations.length > 0, 'injected early-commit bug should be caught by the monitor');
});

test('INJECTED MUTATION no-log-check: stale node elected, committed entries overwritten', () => {
  let caught = 0;
  for (const seed of SEEDS) {
    const r = runScenario({
      seed,
      bugMode: 'no-log-check',
      schedule: [
        { at: 600, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
        { at: 2000, action: 'heal', args: {} },
      ],
    }, 6000);
    if (r.violations.some(v => v.rule === 'committed-overwrite')) caught++;
  }
  assert.ok(caught >= 3, `injected no-log-check bug should be caught for most seeds, caught ${caught}/${SEEDS.length}`);
});

test('same scenario WITHOUT the mutation stays safe', () => {
  for (const seed of SEEDS) {
    const r = runScenario({
      seed,
      schedule: [
        { at: 600, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
        { at: 2000, action: 'heal', args: {} },
      ],
    }, 6000);
    assert.equal(r.violations.length, 0,
      `seed=${seed}: ${JSON.stringify(r.violations.slice(0, 3))}`);
  }
});

test('performance sanity: 10k events complete quickly', () => {
  const start = Date.now();
  runScenario({ seed: 'perf', faults: { drop: 0.1, dup: 0.05, delaySpike: 0.1 } }, 10000);
  const ms = Date.now() - start;
  assert.ok(ms < 5000, `10k events took ${ms}ms`);
});
