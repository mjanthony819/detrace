import { Simulation, SCENARIOS } from './engine.js';

const $ = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';

const state = {
  cfg: null,
  live: null,          // the live simulation (always at the frontier)
  viewPos: null,       // null = live view; otherwise recorded-trace position being viewed
  viewSim: null,       // re-simulated view when scrubbed back
  playing: true,
  selectedNode: null,
};

// ---------- config ----------

function currentConfig() {
  return JSON.parse(JSON.stringify(state.cfg));
}

function loadScenario(key) {
  const s = SCENARIOS[key];
  state.cfg = {
    seed: $('seed').value || 'detrace-1',
    faults: { ...s.faults },
    schedule: s.schedule || [],
    bugMode: s.bugMode || null,
  };
  $('fault-drop').value = Math.round((s.faults.drop || 0) * 100);
  $('fault-dup').value = Math.round((s.faults.dup || 0) * 100);
  $('fault-spike').value = Math.round((s.faults.delaySpike || 0) * 100);
  syncSliderLabels();
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

// ---------- boot ----------
// URL params for deep links / scripted demos: ?scenario=storm&seed=xyz&speed=60
const params = new URLSearchParams(location.search);
if (params.get('seed')) $('seed').value = params.get('seed');
if (params.get('speed')) $('speed').value = params.get('speed');
const startScenario = params.get('scenario');
loadScenario(startScenario && SCENARIOS[startScenario] ? startScenario : 'clean');
if (startScenario && SCENARIOS[startScenario]) $('scenario').value = startScenario;

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
