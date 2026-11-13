/*
 * Detrace experiment workflow - pure helpers shared by the browser UI and the
 * node test suite. No DOM access here.
 *
 * Covers four things:
 *  1. validating user-built experiment configs (schedule editor)
 *  2. encoding/decoding a full config into a shareable URL token
 *  3. validating an exported trace file before it is replayed
 *  4. comparing two runs event by event (first-divergence report)
 *
 * HONESTY NOTES
 * - A share token is a convenience encoding, not a security boundary; decoded
 *   configs are validated before use.
 * - Import verification replays the recorded config with THIS engine build and
 *   compares digests. A match means the recording is consistent with this
 *   engine version - it is not a proof about any other engine.
 */

import { Simulation } from './engine.js';

export const ACTIONS = ['crash', 'restart', 'partition', 'heal'];

// ---------- 1. config / schedule validation ----------

// Returns { ok: boolean, errors: string[] }.
export function validateConfig(cfg, nodeCount = 5) {
  const errors = [];
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, errors: ['config must be an object'] };
  }
  if (cfg.seed !== undefined && typeof cfg.seed !== 'string') {
    errors.push('seed must be a string');
  }
  const f = cfg.faults || {};
  for (const k of ['drop', 'dup', 'delaySpike']) {
    if (f[k] !== undefined) {
      if (typeof f[k] !== 'number' || !(f[k] >= 0) || f[k] > 1) {
        errors.push(`fault ${k} must be a number between 0 and 1`);
      }
    }
  }
  if (cfg.bugMode !== undefined && cfg.bugMode !== null &&
      cfg.bugMode !== 'early-commit' && cfg.bugMode !== 'no-log-check') {
    errors.push(`unknown bug mode "${cfg.bugMode}"`);
  }
  if (cfg.schedule !== undefined) {
    errors.push(...validateSchedule(cfg.schedule, nodeCount).errors);
  }
  return { ok: errors.length === 0, errors };
}

export function validateSchedule(schedule, nodeCount = 5) {
  const errors = [];
  if (!Array.isArray(schedule)) {
    return { ok: false, errors: ['schedule must be a list of actions'] };
  }
  if (schedule.length > 50) {
    errors.push('schedule is limited to 50 actions');
  }
  let prevAt = -Infinity;
  schedule.forEach((item, i) => {
    const where = `action ${i + 1}`;
    if (item === null || typeof item !== 'object') {
      errors.push(`${where}: must be an object {at, action, args}`);
      return;
    }
    if (typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at < 0) {
      errors.push(`${where}: time must be a non-negative number of ms`);
    } else if (item.at < prevAt) {
      errors.push(`${where}: times must be in ascending order`);
    } else {
      prevAt = item.at;
    }
    if (!ACTIONS.includes(item.action)) {
      errors.push(`${where}: unknown action "${item.action}" (expected ${ACTIONS.join(', ')})`);
      return;
    }
    const args = item.args || {};
    if (item.action === 'crash' || item.action === 'restart') {
      if (!Number.isInteger(args.node) || args.node < 0 || args.node >= nodeCount) {
        errors.push(`${where}: node must be an integer 0-${nodeCount - 1}`);
      }
    }
    if (item.action === 'partition') {
      const a = args.a, b = args.b;
      const validSide = (s) => Array.isArray(s) && s.length > 0 &&
        s.every((x) => Number.isInteger(x) && x >= 0 && x < nodeCount);
      if (!validSide(a) || !validSide(b)) {
        errors.push(`${where}: partition sides must be non-empty lists of nodes 0-${nodeCount - 1}`);
      } else {
        const overlap = a.filter((x) => b.includes(x));
        if (overlap.length > 0) {
          errors.push(`${where}: node(s) ${overlap.map((x) => 'N' + x).join(', ')} appear on both sides of the cut`);
        }
        const dupes = (s) => s.filter((x, j) => s.indexOf(x) !== j);
        if (dupes(a).length || dupes(b).length) {
          errors.push(`${where}: a side lists the same node twice`);
        }
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------- 2. share token ----------

// Compact wire shape: {s, f:[drop,dup,spike], sc:[[at,action,args],...], b}
export function encodeConfig(cfg) {
  const wire = {
    s: cfg.seed ?? 'detrace-1',
    f: [cfg.faults?.drop || 0, cfg.faults?.dup || 0, cfg.faults?.delaySpike || 0],
    sc: (cfg.schedule || []).map((i) => [i.at, i.action, i.args || {}]),
    b: cfg.bugMode || null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Returns { ok, config?, errors }
export function decodeConfig(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, errors: ['empty share token'] };
  }
  if (token.length > 8000) {
    return { ok: false, errors: ['share token too long'] };
  }
  let wire;
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    wire = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, errors: ['share token is not a valid Detrace config'] };
  }
  if (wire === null || typeof wire !== 'object') {
    return { ok: false, errors: ['share token did not contain a config'] };
  }
  const config = {
    seed: wire.s,
    faults: { drop: wire.f?.[0], dup: wire.f?.[1], delaySpike: wire.f?.[2] },
    schedule: Array.isArray(wire.sc)
      ? wire.sc.map((row) => (Array.isArray(row) ? { at: row[0], action: row[1], args: row[2] } : row))
      : [],
    bugMode: wire.b ?? null,
  };
  const v = validateConfig(config);
  if (!v.ok) return { ok: false, errors: v.errors };
  // normalize: drop undefined fault fields
  for (const k of Object.keys(config.faults)) {
    if (config.faults[k] === undefined) config.faults[k] = 0;
  }
  if (typeof config.seed !== 'string' || config.seed.length === 0) config.seed = 'detrace-1';
  if (config.seed.length > 200) config.seed = config.seed.slice(0, 200);
  return { ok: true, config, errors: [] };
}

// ---------- 3. trace-file validation ----------

// Shape-checks an exported recording WITHOUT trusting it. Returns
// { ok, errors, config?, steppedEvents?, digest?, events? }.
export function validateTraceFile(parsed) {
  const errors = [];
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['file is not a JSON object'] };
  }
  if (parsed.tool !== 'detrace') {
    errors.push('file does not identify itself as a Detrace recording (missing "tool": "detrace")');
  }
  const cfg = parsed.config;
  if (!cfg || typeof cfg !== 'object') {
    errors.push('recording has no config object');
  } else {
    const v = validateConfig(cfg);
    errors.push(...v.errors.map((e) => `config: ${e}`));
  }
  if (!Number.isInteger(parsed.stepped_events) || parsed.stepped_events < 0) {
    errors.push('stepped_events must be a non-negative integer');
  }
  if (parsed.stepped_events > 2_000_000) {
    errors.push('recordings over 2,000,000 stepped events are not replayed in the browser');
  }
  if (typeof parsed.digest !== 'string' || !/^[0-9a-f]{16}$/.test(parsed.digest)) {
    errors.push('digest must be a 16-character hex string');
  }
  if (!Array.isArray(parsed.trace)) {
    errors.push('trace must be a list of events');
  } else {
    if (parsed.trace.length > 500_000) {
      errors.push('trace lists over 500,000 events are not loaded in the browser');
    }
    for (let i = 0; i < Math.min(parsed.trace.length, 1000); i++) {
      const e = parsed.trace[i];
      if (!e || typeof e !== 'object' || typeof e.i !== 'number' ||
          typeof e.t !== 'number' || typeof e.kind !== 'string' || typeof e.text !== 'string') {
        errors.push(`trace event ${i} is malformed`);
        break;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    config: parsed.config,
    steppedEvents: parsed.stepped_events,
    digest: parsed.digest,
    events: parsed.trace.length,
  };
}

// Replays a validated recording's config and compares digests.
// Returns { match, replayDigest, recordedDigest, steppedEvents }.
export function verifyRecording(valid) {
  const sim = new Simulation(valid.config);
  sim.run(valid.steppedEvents);
  const replayDigest = sim.digest();
  return {
    match: replayDigest === valid.digest,
    replayDigest,
    recordedDigest: valid.digest,
    steppedEvents: valid.steppedEvents,
  };
}

// ---------- 4. run comparison ----------

// Runs both configs for `steps` stepped events and finds the first recorded
// trace event where they diverge. Returns
// { match, digestA, digestB, eventsA, eventsB, firstDivergence: null | {index, a, b} }
export function compareRuns(cfgA, cfgB, steps = 2000) {
  const simA = new Simulation(cfgA);
  const simB = new Simulation(cfgB);
  simA.run(steps);
  simB.run(steps);
  const n = Math.min(simA.trace.length, simB.trace.length);
  let firstDivergence = null;
  for (let i = 0; i < n; i++) {
    const a = simA.trace[i], b = simB.trace[i];
    if (a.kind !== b.kind || a.node !== b.node || a.text !== b.text) {
      firstDivergence = {
        index: i,
        a: { t: a.t, kind: a.kind, node: a.node, text: a.text },
        b: { t: b.t, kind: b.kind, node: b.node, text: b.text },
      };
      break;
    }
  }
  if (!firstDivergence && simA.trace.length !== simB.trace.length) {
    firstDivergence = {
      index: n,
      a: simA.trace[n] ? { t: simA.trace[n].t, kind: simA.trace[n].kind, node: simA.trace[n].node, text: simA.trace[n].text } : null,
      b: simB.trace[n] ? { t: simB.trace[n].t, kind: simB.trace[n].kind, node: simB.trace[n].node, text: simB.trace[n].text } : null,
    };
  }
  return {
    match: firstDivergence === null,
    digestA: simA.digest(),
    digestB: simB.digest(),
    eventsA: simA.trace.length,
    eventsB: simB.trace.length,
    firstDivergence,
  };
}
