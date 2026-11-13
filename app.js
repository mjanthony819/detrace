import { Simulation, SCENARIOS } from './engine.js';
import {
  validateSchedule, encodeConfig, decodeConfig,
  validateTraceFile, verifyRecording, compareRuns,
} from './experiments.js';

const $ = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';

const state = {
  cfg: null,
  live: null,          // the live simulation (always at the frontier)
  viewPos: null,       // null = live view; otherwise recorded-trace position being viewed
  viewSim: null,       // re-simulated view when scrubbed back
  playing: true,
  selectedNode: null,
  importedConfig: null, // config from the last successfully verified recording (compare source)
};

const CUSTOM_SCENARIO = '__custom';

// ---------- config ----------

function currentConfig() {
  return JSON.parse(JSON.stringify(state.cfg));
}

function ensureCustomOption() {
  if (!$('scenario').querySelector(`option[value="${CUSTOM_SCENARIO}"]`)) {
    const opt = document.createElement('option');
    opt.value = CUSTOM_SCENARIO;
    opt.textContent = 'Custom experiment';
    $('scenario').appendChild(opt);
  }
}

function markCustom(label) {
  ensureCustomOption();
  const opt = $('scenario').querySelector(`option[value="${CUSTOM_SCENARIO}"]`);
  if (label) opt.textContent = label;
  $('scenario').value = CUSTOM_SCENARIO;
}

function loadScenario(key) {
  if (key === CUSTOM_SCENARIO) {
    // keep the builder's schedule/bug mode; just re-run
    restart();
    return;
  }
  const s = SCENARIOS[key];
  state.cfg = {
    seed: $('seed').value || 'detrace-1',
    faults: { ...s.faults },
    // deep copy: the builder mutates cfg.schedule in place, and it must never
    // write back into the shared SCENARIOS table
    schedule: (s.schedule || []).map((i) => ({ at: i.at, action: i.action, args: JSON.parse(JSON.stringify(i.args || {})) })),
    bugMode: s.bugMode || null,
  };
  $('fault-drop').value = Math.round((s.faults.drop || 0) * 100);
  $('fault-dup').value = Math.round((s.faults.dup || 0) * 100);
  $('fault-spike').value = Math.round((s.faults.delaySpike || 0) * 100);
  $('bugmode').value = s.bugMode || '';
  syncSliderLabels();
  renderSchedRows();
  $('sched-out').textContent = '';
  $('sched-out').className = 'verify-out';
  restart();
}

function syncSliderLabels() {
  $('drop-v').textContent = $('fault-drop').value + '%';
  $('dup-v').textContent = $('fault-dup').value + '%';
  $('spike-v').textContent = $('fault-spike').value + '%';
}

function restart() {
  state.cfg.seed = $('seed').value || 'detrace-1';
  state.cfg.faults = {
    drop: $('fault-drop').value / 100,
    dup: $('fault-dup').value / 100,
    delaySpike: $('fault-spike').value / 100,
  };
  state.live = new Simulation(currentConfig());
  state.viewPos = null;
  state.viewSim = null;
  $('verify-out').textContent = '';
  $('verify-out').className = 'verify-out';
  render(true);
}

// ---------- experiment builder ----------

function parseNodeList(text) {
  return text.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    .map((s) => (Number.isInteger(Number(s)) ? Number(s) : NaN));
}

function renderSchedRows() {
  const box = $('sched-rows');
  box.textContent = '';
  const rows = state.cfg ? state.cfg.schedule : [];
  rows.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'sched-row';

    const at = document.createElement('input');
    at.type = 'number'; at.min = '0'; at.step = '100'; at.value = item.at;
    at.className = 'sched-at'; at.title = 'virtual time (ms)';

    const action = document.createElement('select');
    for (const a of ['crash', 'restart', 'partition', 'heal']) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      if (a === item.action) o.selected = true;
      action.appendChild(o);
    }

    const args = document.createElement('span');
    args.className = 'sched-args';
    const renderArgs = () => {
      args.textContent = '';
      if (action.value === 'crash' || action.value === 'restart') {
        const n = document.createElement('input');
        n.type = 'number'; n.min = '0'; n.max = '4'; n.className = 'sched-node';
        n.value = item.args && Number.isInteger(item.args.node) ? item.args.node : 0;
        n.title = 'node id (0-4)';
        args.appendChild(document.createTextNode('N'));
        args.appendChild(n);
      } else if (action.value === 'partition') {
        const a = document.createElement('input');
        a.type = 'text'; a.className = 'sched-side'; a.spellcheck = false;
        a.placeholder = '0,1,2';
        a.value = item.args && Array.isArray(item.args.a) ? item.args.a.join(',') : '';
        const b = document.createElement('input');
        b.type = 'text'; b.className = 'sched-side'; b.spellcheck = false;
        b.placeholder = '3,4';
        b.value = item.args && Array.isArray(item.args.b) ? item.args.b.join(',') : '';
        args.appendChild(a);
        args.appendChild(document.createTextNode('|'));
        args.appendChild(b);
      } else {
        args.appendChild(document.createTextNode('(no arguments)'));
      }
    };
    renderArgs();
    action.addEventListener('change', () => { item.action = action.value; item.args = {}; renderArgs(); });

    const del = document.createElement('button');
    del.textContent = '\u00d7'; del.title = 'remove action'; del.className = 'sched-del';
    del.addEventListener('click', () => { state.cfg.schedule.splice(i, 1); renderSchedRows(); });

    row.appendChild(at); row.appendChild(action); row.appendChild(args); row.appendChild(del);
    box.appendChild(row);
  });
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint sched-empty';
    empty.textContent = 'no scheduled faults - the run proceeds without intervention';
    box.appendChild(empty);
  }
}

function readSchedRows() {
  const rows = [];
  for (const row of document.querySelectorAll('#sched-rows .sched-row')) {
    const at = Number(row.querySelector('.sched-at').value);
    const action = row.querySelector('select').value;
    let args = {};
    if (action === 'crash' || action === 'restart') {
      args = { node: Number(row.querySelector('.sched-node').value) };
    } else if (action === 'partition') {
      const sides = row.querySelectorAll('.sched-side');
      args = { a: parseNodeList(sides[0].value), b: parseNodeList(sides[1].value) };
    }
    rows.push({ at, action, args });
  }
  return rows;
}

$('sched-add').addEventListener('click', () => {
  const last = state.cfg.schedule[state.cfg.schedule.length - 1];
  state.cfg.schedule.push({ at: last ? last.at + 500 : 500, action: 'crash', args: { node: 0 } });
  renderSchedRows();
});

$('sched-apply').addEventListener('click', () => {
  const out = $('sched-out');
  const schedule = readSchedRows();
  const v = validateSchedule(schedule);
  if (!v.ok) {
    out.textContent = 'not applied: ' + v.errors.join(' | ');
    out.className = 'verify-out bad';
    return;
  }
  state.cfg.schedule = schedule;
  state.cfg.bugMode = $('bugmode').value || null;
  markCustom();
  out.textContent = `applied: ${schedule.length} scheduled action(s), bug mode ${state.cfg.bugMode || 'none'}`;
  out.className = 'verify-out ok';
  restart();
});

// ---------- simulation driving ----------

function eventsPerTick() {
  const s = Number($('speed').value);
  return Math.max(1, Math.round(Math.pow(s, 1.6)));
}

setInterval(() => {
  if (!state.playing || state.viewPos !== null) return;
  state.live.run(eventsPerTick());
  render(false);
}, 100);

// time travel: rebuild a sim at recorded-trace position k
function simAt(k) {
  const sim = new Simulation(currentConfig());
  let guard = 0;
  while (sim.trace.length < k && sim.steps < 2_000_000) {
    if (!sim.step()) break;
    if (++guard > 2_000_000) break;
  }
  return sim;
}

function activeSnapshot() {
  return (state.viewPos === null ? state.live : state.viewSim).getSnapshot();
}

// ---------- rendering ----------

const NODE_R = 34;
const CX = 320, CY = 235, RADIUS = 165;

function nodePos(i, count) {
  const ang = -Math.PI / 2 + (2 * Math.PI * i) / count;
  return { x: CX + RADIUS * Math.cos(ang), y: CY + RADIUS * Math.sin(ang) };
}

function el(tag, attrs) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function render(rebuildLog) {
  const snap = activeSnapshot();
  $('stat-clock').textContent = `${snap.now.toFixed(0)} ms`;
  $('stat-events').textContent = snap.events;
  $('stat-digest').textContent = snap.digest.slice(0, 12) + '…';
  $('stat-view').textContent = state.viewPos === null ? 'LIVE' : `event ${state.viewPos} (rewound)`;

  renderCluster(snap);
  renderInvariants(snap);
  renderInspector(snap);
  renderLog(rebuildLog);
  const sc = $('scrubber');
  sc.max = Math.max(0, state.live.trace.length);
  if (state.viewPos === null) sc.value = state.live.trace.length;
}

function renderCluster(snap) {
  const svg = $('cluster');
  svg.textContent = '';
  const n = snap.nodes.length;
  const pos = snap.nodes.map((_, i) => nodePos(i, n));

  // edges
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cut = snap.partitions.some(p =>
        (p.a.includes(i) && p.b.includes(j)) || (p.b.includes(i) && p.a.includes(j)));
      svg.appendChild(el('line', {
        x1: pos[i].x, y1: pos[i].y, x2: pos[j].x, y2: pos[j].y,
        class: cut ? 'edge cut' : 'edge',
      }));
    }
  }

  // in-flight packets
  for (const m of snap.inflight) {
    const span = Math.max(1, m.deliverT - m.sentT);
    const prog = Math.min(1, Math.max(0, (snap.now - m.sentT) / span));
    const x = pos[m.from].x + (pos[m.to].x - pos[m.from].x) * prog;
    const y = pos[m.from].y + (pos[m.to].y - pos[m.from].y) * prog;
    const isVote = m.mtype.startsWith('RequestVote');
    svg.appendChild(el('rect', {
      x: x - 4, y: y - 4, width: 8, height: 8,
      class: isVote ? 'packet vote' : 'packet',
      transform: `rotate(45 ${x} ${y})`,
    }));
  }

  // nodes
  snap.nodes.forEach((node, i) => {
    const g = el('g', { class: 'node-circle', 'data-id': i });
    const fill = node.down ? 'url(#hatch)' :
      node.state === 'leader' ? 'var(--accent)' :
      node.state === 'candidate' ? 'var(--accent-soft)' : 'var(--paper)';
    g.appendChild(el('circle', {
      cx: pos[i].x, cy: pos[i].y, r: NODE_R,
      fill, stroke: 'var(--ink)', 'stroke-width': 2.5,
    }));
    const label = el('text', {
      x: pos[i].x, y: pos[i].y - 4, 'text-anchor': 'middle',
      'font-size': 15, 'font-weight': 700, 'font-family': 'var(--mono)',
      fill: node.state === 'leader' && !node.down ? 'var(--paper)' : 'var(--ink)',
    });
    label.textContent = `N${node.id}`;
    g.appendChild(label);
    const sub = el('text', {
      x: pos[i].x, y: pos[i].y + 13, 'text-anchor': 'middle',
      'font-size': 9.5, 'font-family': 'var(--mono)',
      fill: node.state === 'leader' && !node.down ? 'var(--paper)' : 'var(--ink-soft)',
    });
    sub.textContent = node.down ? 'DOWN' : `${node.state} t${node.term}`;
    g.appendChild(sub);
    g.addEventListener('click', () => {
      state.selectedNode = state.selectedNode === i ? null : i;
      render(false);
    });
    svg.appendChild(g);
  });

  // hatch pattern for crashed nodes
  const defs = el('defs', {});
  const pat = el('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.appendChild(el('rect', { width: 6, height: 6, fill: 'var(--paper-2)' }));
  pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--ink-soft)', 'stroke-width': 2 }));
  defs.appendChild(pat);
  svg.insertBefore(defs, svg.firstChild);
}

function renderInvariants(snap) {
  const rules = ['election-safety', 'commit-safety', 'committed-overwrite'];
  for (const li of document.querySelectorAll('#invariants li')) {
    const rule = li.dataset.rule;
    const count = snap.violations.filter(v => v.rule === rule).length;
    const badge = li.querySelector('.badge');
    if (count > 0) {
      badge.textContent = `VIOLATED x${count}`;
      badge.className = 'badge bad';
    } else {
      badge.textContent = 'holding';
      badge.className = 'badge ok';
    }
    void rules;
  }
  const box = $('violations');
  box.textContent = '';
  for (const v of snap.violations.slice(0, 20)) {
    const div = document.createElement('div');
    div.textContent = `[${v.t.toFixed(0)}ms] ${v.rule}: ${v.text}`;
    div.addEventListener('click', () => jumpTo(v.i));
    box.appendChild(div);
  }
}

function renderInspector(snap) {
  const box = $('inspector');
  if (state.selectedNode === null) {
    box.textContent = 'select a node in the cluster view';
    return;
  }
  const n = snap.nodes[state.selectedNode];
  const kv = Object.entries(n.kv).map(([k, v]) => `    ${k} = ${v}`).join('\n') || '    (empty)';
  const logTail = n.log.slice(-6).map((e, idx) => {
    const gi = n.log.length - Math.min(6, n.log.length) + idx;
    const mark = gi <= n.commitIndex ? 'C' : ' ';
    return `  ${mark}[${gi}] t${e.term} ${e.key}=${e.value}`;
  }).join('\n') || '    (empty)';
  box.innerHTML =
    `<span class="hdr">N${n.id} - ${n.down ? 'CRASHED' : n.state.toUpperCase()} - term ${n.term}</span>\n` +
    `  votedFor: ${n.votedFor === null ? '-' : 'N' + n.votedFor}\n` +
    `  log entries: ${n.logLen}   commitIndex: ${n.commitIndex}   applied: ${n.lastApplied}\n` +
    `  kv store:\n${kv}\n` +
    `  log tail (C = committed):\n${logTail}`;
}

function renderLog(rebuild) {
  const ol = $('eventlog');
  const sim = state.viewPos === null ? state.live : state.viewSim;
  const trace = sim.trace;
  const start = Math.max(0, trace.length - 300);
  if (rebuild || ol.childElementCount === 0 || true) {
    ol.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < trace.length; i++) {
      const e = trace[i];
      const li = document.createElement('li');
      li.className = 'k-' + e.kind;
      li.dataset.i = e.i;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = e.t.toFixed(0) + 'ms';
      const tx = document.createElement('span');
      tx.textContent = e.text;
      li.appendChild(t); li.appendChild(tx);
      li.addEventListener('click', () => jumpTo(e.i + 1));
      frag.appendChild(li);
    }
    ol.appendChild(frag);
  }
  // mark current
  for (const li of ol.children) li.classList.remove('current');
  if (trace.length > 0) {
    const cur = ol.querySelector(`li[data-i="${trace[trace.length - 1].i}"]`);
    if (cur) cur.classList.add('current');
  }
  if (state.viewPos === null) {
    const wrap = document.querySelector('.logwrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function jumpTo(pos) {
  state.viewPos = pos;
  state.playing = false;
  $('btn-play').textContent = 'play';
  state.viewSim = simAt(pos);
  $('scrubber').value = pos;
  render(true);
}

// ---------- controls ----------

$('scenario').textContent = '';
for (const [key, s] of Object.entries(SCENARIOS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = s.label;
  $('scenario').appendChild(opt);
}
$('scenario').addEventListener('change', (e) => loadScenario(e.target.value));
$('bugmode').addEventListener('change', () => {
  // applying a bug mode from the builder marks the run as a custom experiment
  state.cfg.bugMode = $('bugmode').value || null;
  markCustom();
  restart();
});

$('seed').addEventListener('change', restart);
$('reroll').addEventListener('click', () => {
  $('seed').value = 'seed-' + Math.floor(Math.random() * 1e6).toString(36);
  restart();
});

for (const id of ['fault-drop', 'fault-dup', 'fault-spike']) {
  $(id).addEventListener('change', () => { syncSliderLabels(); restart(); });
  $(id).addEventListener('input', syncSliderLabels);
}

$('btn-play').addEventListener('click', () => {
  if (state.viewPos !== null) {
    // jump back to live frontier and resume
    state.viewPos = null;
    state.viewSim = null;
    state.playing = true;
    $('btn-play').textContent = 'pause';
    render(true);
    return;
  }
  state.playing = !state.playing;
  $('btn-play').textContent = state.playing ? 'pause' : 'play';
});

$('btn-step').addEventListener('click', () => {
  state.playing = false;
  $('btn-play').textContent = 'play';
  if (state.viewPos !== null) {
    state.viewPos = null;
    state.viewSim = null;
  }
  state.live.run(100);
  render(true);
});

$('btn-restart').addEventListener('click', restart);

$('scrubber').addEventListener('input', (e) => {
  const pos = Number(e.target.value);
  if (pos >= state.live.trace.length) {
    state.viewPos = null;
    state.viewSim = null;
    render(true);
    return;
  }
  state.viewPos = pos;
  state.playing = false;
  $('btn-play').textContent = 'play';
  state.viewSim = simAt(pos);
  render(true);
});

$('btn-export').addEventListener('click', () => {
  const payload = {
    tool: 'detrace',
    note: 'Re-run this exact config with engine.js to reproduce this trace and digest.',
    config: currentConfig(),
    stepped_events: state.live.steps,
    digest: state.live.digest(),
    trace: state.live.trace,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `detrace-trace-${state.cfg.seed}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-verify').addEventListener('click', () => {
  const out = $('verify-out');
  out.textContent = 're-running from seed...';
  setTimeout(() => {
    const fresh = new Simulation(currentConfig());
    fresh.run(state.live.steps);
    const match = fresh.digest() === state.live.digest();
    out.textContent = match
      ? `REPLAY MATCH: ${state.live.steps} stepped events reproduce digest ${fresh.digest().slice(0, 16)}…`
      : `MISMATCH: live ${state.live.digest().slice(0, 16)}… vs replay ${fresh.digest().slice(0, 16)}…`;
    out.className = 'verify-out ' + (match ? 'ok' : 'bad');
  }, 30);
});

// ---------- share link ----------

$('btn-share').addEventListener('click', async () => {
  const out = $('import-out');
  const token = encodeConfig(currentConfig());
  const url = `${location.origin}${location.pathname}?cfg=${token}`;
  try {
    await navigator.clipboard.writeText(url);
    out.textContent = 'share link copied - it encodes this exact seed, faults, schedule and bug mode';
    out.className = 'verify-out ok';
  } catch {
    out.textContent = `clipboard blocked; copy the link from the address bar after this navigation: ${url}`;
    out.className = 'verify-out';
  }
});

// ---------- import + recording verification ----------
// Imported files are untrusted data: they are shape-validated and bounded
// before use, imported text is never injected as HTML, and the loaded run is
// OUR re-simulation of the recorded config - not the file's trace array.

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const out = $('import-out');
  out.className = 'verify-out';
  let parsed;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('file over 20 MB');
    parsed = JSON.parse(await file.text());
  } catch (err) {
    out.textContent = `not a readable JSON recording: ${err.message}`;
    out.className = 'verify-out bad';
    return;
  }
  const v = validateTraceFile(parsed);
  if (!v.ok) {
    out.textContent = 'invalid recording: ' + v.errors.slice(0, 3).join(' | ');
    out.className = 'verify-out bad';
    return;
  }
  out.textContent = `replaying ${v.steppedEvents} stepped events from the recorded seed...`;
  await new Promise((r) => setTimeout(r, 30));
  // load the recorded config into the controls, then replay with THIS engine
  const cfg = v.config;
  $('seed').value = cfg.seed || 'detrace-1';
  $('fault-drop').value = Math.round(((cfg.faults || {}).drop || 0) * 100);
  $('fault-dup').value = Math.round(((cfg.faults || {}).dup || 0) * 100);
  $('fault-spike').value = Math.round(((cfg.faults || {}).delaySpike || 0) * 100);
  $('bugmode').value = cfg.bugMode || '';
  syncSliderLabels();
  state.cfg = {
    seed: cfg.seed || 'detrace-1',
    faults: { drop: (cfg.faults || {}).drop || 0, dup: (cfg.faults || {}).dup || 0, delaySpike: (cfg.faults || {}).delaySpike || 0 },
    schedule: cfg.schedule || [],
    bugMode: cfg.bugMode || null,
  };
  renderSchedRows();
  const check = verifyRecording(v);
  // the displayed run is our own replay, scrubbed like any live run
  state.live = new Simulation(currentConfig());
  state.live.run(v.steppedEvents);
  state.viewPos = null;
  state.viewSim = null;
  if (check.match) {
    state.importedConfig = currentConfig();
    markCustom('Custom experiment (imported recording)');
    out.textContent = `RECORDING VERIFIED: replaying the recorded config under this engine build reproduces its digest ${check.recordedDigest.slice(0, 16)}\u2026 (${v.events} trace events, ${v.steppedEvents} steps). Timeline is scrubbable.`;
    out.className = 'verify-out ok';
  } else {
    out.textContent = `DIGEST MISMATCH: the recording's digest ${check.recordedDigest.slice(0, 16)}\u2026 does not match this engine's replay ${check.replayDigest.slice(0, 16)}\u2026 - the file was altered or made with a different engine build. Showing our replay, not the file's claims.`;
    out.className = 'verify-out bad';
  }
  populateCompareSources();
  render(true);
});

// ---------- run comparison ----------

function populateCompareSources() {
  const sel = $('compare-src');
  sel.textContent = '';
  for (const [key, s] of Object.entries(SCENARIOS)) {
    const o = document.createElement('option');
    o.value = 'scenario:' + key;
    o.textContent = 'scenario: ' + s.label;
    sel.appendChild(o);
  }
  if (state.importedConfig) {
    const o = document.createElement('option');
    o.value = 'imported';
    o.textContent = 'imported recording config';
    sel.appendChild(o);
  }
}

$('btn-compare').addEventListener('click', () => {
  const out = $('compare-out');
  const div = $('divergence');
  div.textContent = '';
  const sel = $('compare-src').value;
  let cfgB;
  if (sel === 'imported' && state.importedConfig) {
    cfgB = state.importedConfig;
  } else {
    const key = sel.replace(/^scenario:/, '');
    const s = SCENARIOS[key];
    // run B keeps the CURRENT seed: the comparison isolates the condition change
    cfgB = { seed: $('seed').value || 'detrace-1', faults: { ...s.faults }, schedule: s.schedule || [], bugMode: s.bugMode || null };
  }
  const steps = Math.max(100, Math.min(100000, Number($('compare-steps').value) || 2000));
  out.textContent = `running both configs for ${steps} stepped events...`;
  out.className = 'verify-out';
  setTimeout(() => {
    const r = compareRuns(currentConfig(), cfgB, steps);
    if (r.match) {
      out.textContent = `IDENTICAL: both runs replay to digest ${r.digestA.slice(0, 16)}\u2026 (${r.eventsA} trace events). No behavioral difference under this engine build.`;
      out.className = 'verify-out ok';
    } else {
      out.textContent = `DIVERGENT: runs first differ at trace event ${r.firstDivergence.index} (A: ${r.eventsA} events, digest ${r.digestA.slice(0, 12)}\u2026; B: ${r.eventsB} events, digest ${r.digestB.slice(0, 12)}\u2026).`;
      out.className = 'verify-out bad';
      const renderSide = (label, side) => {
        const d = document.createElement('div');
        d.className = 'div-side';
        const h = document.createElement('b');
        h.textContent = label;
        const p = document.createElement('p');
        p.textContent = side ? `[${side.t.toFixed(0)}ms] ${side.kind} N${side.node}: ${side.text}` : '(run ended before this event)';
        d.appendChild(h); d.appendChild(p);
        return d;
      };
      div.appendChild(renderSide('run A (current)', r.firstDivergence.a));
      div.appendChild(renderSide('run B', r.firstDivergence.b));
    }
  }, 30);
});

// ---------- boot ----------
// URL params for deep links / scripted demos:
//   ?scenario=storm&seed=xyz&speed=60  (original)
//   ?cfg=<token>                        (full shareable experiment config)
const params = new URLSearchParams(location.search);
if (params.get('seed')) $('seed').value = params.get('seed');
if (params.get('speed')) $('speed').value = params.get('speed');
const shareToken = params.get('cfg');
if (shareToken) {
  const dec = decodeConfig(shareToken);
  if (dec.ok) {
    const cfg = dec.config;
    $('seed').value = cfg.seed;
    $('fault-drop').value = Math.round((cfg.faults.drop || 0) * 100);
    $('fault-dup').value = Math.round((cfg.faults.dup || 0) * 100);
    $('fault-spike').value = Math.round((cfg.faults.delaySpike || 0) * 100);
    $('bugmode').value = cfg.bugMode || '';
    syncSliderLabels();
    state.cfg = { seed: cfg.seed, faults: { ...cfg.faults }, schedule: cfg.schedule, bugMode: cfg.bugMode };
    markCustom('Custom experiment (shared link)');
    renderSchedRows();
    restart();
    $('import-out').textContent = 'loaded a shared experiment link - the same seed, faults, schedule and bug mode the sender ran';
    $('import-out').className = 'verify-out ok';
  } else {
    loadScenario('clean');
    $('import-out').textContent = 'share link ignored: ' + dec.errors[0];
    $('import-out').className = 'verify-out bad';
  }
} else {
  const startScenario = params.get('scenario');
  loadScenario(startScenario && SCENARIOS[startScenario] ? startScenario : 'clean');
  if (startScenario && SCENARIOS[startScenario]) $('scenario').value = startScenario;
}
populateCompareSources();

// debug + scripted-demo handle: read-only view of state plus config getter
window.detrace = { state, currentConfig };

// ---------- scripted demo mode (?demo=1): timed storyboard for the video ----------
function setScenario(key) {
  $('scenario').value = key;
  loadScenario(key);
}
function backToLive() {
  state.viewPos = null;
  state.viewSim = null;
  state.playing = true;
  $('btn-play').textContent = 'pause';
  render(true);
}
// per-scene helpers for the demo video: ?scene=rewind|verify with ?scenario=...
if (params.get('scene') === 'rewind') {
  const iv = setInterval(() => {
    const v = state.live.violations[0];
    if (v) { clearInterval(iv); jumpTo(v.i + 1); }
  }, 100);
}
if (params.get('scene') === 'verify') {
  const iv = setInterval(() => {
    const v = state.live.violations[0];
    if (v) { clearInterval(iv); setTimeout(() => $('btn-verify').click(), 800); }
  }, 100);
}
