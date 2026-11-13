/*
 * Detrace engine - deterministic simulation of a simplified Raft-like
 * replicated key-value cluster, with fault injection and time-travel replay.
 *
 * SCOPE / HONESTY NOTES
 * - This is an EDUCATIONAL MODEL of Raft, not a production implementation
 *   and not formally verified. It omits snapshotting, membership change,
 *   pre-vote, and several real-world details.
 * - "Bug mode" injects DELIBERATE MUTATIONS so the invariant monitors have
 *   something to catch. These are planted bugs in this toy model, not
 *   vulnerabilities in Raft itself.
 * - Determinism claim is narrow and testable: within this engine, the same
 *   config (seed + faults + schedule + bug mode) replays to the identical
 *   event trace and rolling hash. See tests/engine.test.mjs.
 *
 * Runs in the browser (as an ES module) and in Node (for tests).
 */

// ---------- deterministic primitives ----------

export function fnv1a32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 64-bit FNV-1a over a string, kept as two 32-bit halves, returned as hex.
export class Fnv64 {
  constructor() { this.hi = 0xcbf29ce4; this.lo = 0x84222325; }
  add(str) {
    for (let i = 0; i < str.length; i++) {
      this.lo ^= str.charCodeAt(i);
      const a = this.lo >>> 0, b = this.hi >>> 0;
      this.lo = Math.imul(a, 0x000001b3) >>> 0;
      this.hi = (Math.imul(a, 0x00000100) + Math.imul(b, 0x000001b3)) >>> 0;
    }
  }
  hex() {
    return (this.hi >>> 0).toString(16).padStart(8, '0') +
           (this.lo >>> 0).toString(16).padStart(8, '0');
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- event queue ----------

class Heap {
  constructor() { this.a = []; }
  size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop() {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0], last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  less(x, y) { return x.t < y.t || (x.t === y.t && x.seq < y.seq); }
}

// ---------- simulation ----------

export const DEFAULTS = {
  seed: 'detrace-1',
  nodeCount: 5,
  heartbeatMs: 40,
  electionMinMs: 120,
  electionMaxMs: 240,
  baseDelayMinMs: 8,
  baseDelayMaxMs: 25,
  workloadEveryMs: 60,
  keyPool: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'],
  faults: { drop: 0, dup: 0, delaySpike: 0 },
  schedule: [],      // [{at, action, args}] partition/heal/crash/restart
  bugMode: null,     // null | 'early-commit' | 'no-log-check'  (deliberate injected mutations)
};

function entryId(e) { return `${e.term}:${e.op.key}=${e.op.value}#${e.op.seq}`; }

export class Simulation {
  constructor(config = {}) {
    this.cfg = Object.assign({}, DEFAULTS, config);
    this.cfg.faults = Object.assign({}, DEFAULTS.faults, config.faults || {});
    const c = this.cfg;
    this.rng = mulberry32(fnv1a32(String(c.seed)));
    this.pq = new Heap();
    this.seq = 0;
    this.now = 0;
    this.steps = 0;
    this.trace = [];
    this.hash = new Fnv64();
    this.violations = [];
    this.inflight = [];         // messages currently in the network
    this.partitions = [];       // currently active cuts
    this.committedByIndex = new Map(); // global monitor: log index -> first committed entry id
    this.clientPending = null;
    this.clientCompleted = 0;

    this.nodes = [];
    for (let i = 0; i < c.nodeCount; i++) this.nodes.push(this.#freshNode(i));

    // boot: stagger the first election timers
    for (const n of this.nodes) this.#resetElectionTimer(n);
    // scheduled external actions (fault schedule)
    for (const item of c.schedule) this.#schedule(item.at, item.action, item.args || {});
    // first client write
    this.#schedule(c.workloadEveryMs, 'client-write', {});
  }

  #freshNode(id) {
    return {
      id,
      down: false,
      // persistent (survives crash, unless the 'amnesia' mutation is injected)
      currentTerm: 0, votedFor: null, log: [],
      // volatile
      state: 'follower', commitIndex: -1, lastApplied: -1, kv: {},
      votes: new Set(), nextIndex: {}, matchIndex: {},
      electionDeadline: 0,
    };
  }

  #drawElectionTimeout() {
    const c = this.cfg;
    return c.electionMinMs + this.rng() * (c.electionMaxMs - c.electionMinMs);
  }

  #schedule(t, kind, payload) {
    this.pq.push({ t, seq: this.seq++, kind, payload });
  }

  #record(kind, node, text, extra = '') {
    const entry = { i: this.trace.length, t: Math.round(this.now * 1000) / 1000, kind, node, text };
    this.trace.push(entry);
    this.hash.add(`${entry.i}|${entry.t}|${kind}|${node}|${text}|${extra}`);
    return entry;
  }

  #violation(rule, text) {
    const v = { i: this.trace.length, t: Math.round(this.now * 1000) / 1000, rule, text };
    this.violations.push(v);
    this.#record('violation', -1, `${rule}: ${text}`);
  }

  // ---------- network ----------

  #isCut(from, to) {
    for (const p of this.partitions) {
      const inA = p.a.includes(from) && p.b.includes(to);
      const inB = p.b.includes(from) && p.a.includes(to);
      if (inA || inB) return true;
    }
    return false;
  }

  #send(from, to, mtype, data) {
    if (this.#isCut(from, to)) {
      this.#record('net-drop', from, `N${from}->N${to} ${mtype} blocked by partition`);
      return;
    }
    const f = this.cfg.faults;
    if (f.drop > 0 && this.rng() < f.drop) {
      this.#record('net-drop', from, `N${from}->N${to} ${mtype} dropped (fault)`);
      return;
    }
    const c = this.cfg;
    let delay = c.baseDelayMinMs + this.rng() * (c.baseDelayMaxMs - c.baseDelayMinMs);
    if (f.delaySpike > 0 && this.rng() < f.delaySpike) delay *= 10;
    const copies = (f.dup > 0 && this.rng() < f.dup) ? 2 : 1;
    for (let k = 0; k < copies; k++) {
      const sentT = this.now;
      const deliverT = this.now + delay * (k === 0 ? 1 : 1.5);
      const msg = { from, to, mtype, data, sentT, deliverT, id: this.seq };
      this.inflight.push(msg);
      this.#schedule(deliverT, 'deliver', msg);
      if (copies > 1 && k === 1) this.#record('net-dup', from, `N${from}->N${to} ${mtype} duplicated (fault)`);
    }
  }

  // ---------- raft-ish node logic ----------

  #resetElectionTimer(n) {
    n.electionDeadline = this.now + this.#drawElectionTimeout();
    this.#schedule(n.electionDeadline, 'election-timeout', { node: n.id, deadline: n.electionDeadline });
  }

  #becomeFollower(n, term) {
    n.state = 'follower';
    if (term > n.currentTerm) { n.currentTerm = term; n.votedFor = null; }
    n.votes = new Set();
  }

  #startElection(n) {
    n.state = 'candidate';
    n.currentTerm += 1;
    n.votedFor = n.id;
    n.votes = new Set([n.id]);
    this.#resetElectionTimer(n);
    this.#record('election', n.id, `N${n.id} timeout -> candidate, term ${n.currentTerm}`);
    for (const m of this.nodes) {
      if (m.id === n.id) continue;
      const lastIdx = n.log.length - 1;
      this.#send(n.id, m.id, 'RequestVote', {
        term: n.currentTerm, candidateId: n.id,
        lastLogIndex: lastIdx, lastLogTerm: lastIdx >= 0 ? n.log[lastIdx].term : 0,
      });
    }
    this.#checkElectionWin(n);
  }

  #checkElectionWin(n) {
    if (n.state !== 'candidate') return;
    const majority = Math.floor(this.cfg.nodeCount / 2) + 1;
    if (n.votes.size >= majority) {
      n.state = 'leader';
      this.#record('leader', n.id, `N${n.id} elected leader, term ${n.currentTerm} (${n.votes.size} votes)`);
      for (const m of this.nodes) {
        n.nextIndex[m.id] = n.log.length;
        n.matchIndex[m.id] = -1;
      }
      n.matchIndex[n.id] = n.log.length - 1;
      this.#broadcastAppend(n);
      this.#schedule(this.now + this.cfg.heartbeatMs, 'heartbeat', { node: n.id, term: n.currentTerm });
    }
  }

  #handleRequestVote(n, msg) {
    const { term, candidateId, lastLogIndex, lastLogTerm } = msg.data;
    if (term < n.currentTerm) {
      this.#send(n.id, msg.from, 'RequestVoteReply', { term: n.currentTerm, granted: false });
      return;
    }
    if (term > n.currentTerm) this.#becomeFollower(n, term);
    const myLastIdx = n.log.length - 1;
    const myLastTerm = myLastIdx >= 0 ? n.log[myLastIdx].term : 0;
    const upToDate = lastLogTerm > myLastTerm ||
      (lastLogTerm === myLastTerm && lastLogIndex >= myLastIdx);
    const canVote = (n.votedFor === null || n.votedFor === candidateId);
    // INJECTED MUTATION 'no-log-check': grant the vote without verifying the
    // candidate's log is up to date - the check Raft uses to keep stale nodes
    // from being elected and overwriting committed entries.
    const granted = canVote && (this.cfg.bugMode === 'no-log-check' ? true : upToDate);
    if (granted) {
      n.votedFor = candidateId;
      this.#resetElectionTimer(n);
    }
    this.#send(n.id, msg.from, 'RequestVoteReply', { term: n.currentTerm, granted });
  }

  #handleRequestVoteReply(n, msg) {
    const { term, granted } = msg.data;
    if (n.state !== 'candidate' || term !== n.currentTerm) return;
    if (granted) {
      n.votes.add(msg.from);
      this.#checkElectionWin(n);
    }
  }

  #broadcastAppend(n) {
    for (const m of this.nodes) {
      if (m.id === n.id) continue;
      this.#sendAppend(n, m.id);
    }
  }

  #sendAppend(leader, toId) {
    const nextIdx = leader.nextIndex[toId] ?? leader.log.length;
    const prevLogIndex = nextIdx - 1;
    const prevLogTerm = prevLogIndex >= 0 ? leader.log[prevLogIndex].term : 0;
    const entries = leader.log.slice(nextIdx);
    this.#send(leader.id, toId, 'AppendEntries', {
      term: leader.currentTerm, leaderId: leader.id,
      prevLogIndex, prevLogTerm, entries,
      leaderCommit: leader.commitIndex,
    });
  }

  #applyCommitted(n) {
    while (n.lastApplied < n.commitIndex && n.lastApplied + 1 < n.log.length) {
      n.lastApplied += 1;
      const e = n.log[n.lastApplied];
      n.kv[e.op.key] = e.op.value;
      const id = entryId(e);
      // commit-safety monitor: the first entry ever committed at an index pins it
      if (this.committedByIndex.has(n.lastApplied)) {
        const prev = this.committedByIndex.get(n.lastApplied);
        if (prev !== id) {
          this.#violation('commit-safety',
            `index ${n.lastApplied} committed as ${prev} but N${n.id} applied ${id}`);
        }
      } else {
        this.committedByIndex.set(n.lastApplied, id);
        this.#record('commit', n.id, `commit #${n.lastApplied} ${e.op.key}=${e.op.value} (term ${e.term})`, id);
      }
    }
  }

  #handleAppendEntries(n, msg) {
    const { term, prevLogIndex, prevLogTerm, entries, leaderCommit } = msg.data;
    if (term < n.currentTerm) {
      this.#send(n.id, msg.from, 'AppendEntriesReply', { term: n.currentTerm, ok: false, matchIndex: n.log.length - 1 });
      return;
    }
    this.#becomeFollower(n, term);
    this.#resetElectionTimer(n);
    // consistency check
    if (prevLogIndex >= 0) {
      if (prevLogIndex >= n.log.length || n.log[prevLogIndex].term !== prevLogTerm) {
        this.#send(n.id, msg.from, 'AppendEntriesReply', { term: n.currentTerm, ok: false, matchIndex: n.log.length - 1 });
        return;
      }
    }
    // append/overwrite
    let idx = prevLogIndex + 1;
    for (const e of entries) {
      if (idx < n.log.length) {
        if (n.log[idx].term !== e.term) {
          // monitor: an entry this node already APPLIED must never be overwritten
          if (idx <= n.lastApplied) {
            this.#violation('committed-overwrite',
              `N${n.id} log[${idx}] already applied as ${entryId(n.log[idx])}, overwritten by ${entryId(e)}`);
          }
          n.log = n.log.slice(0, idx);
          n.log.push(e);
        }
      } else {
        n.log.push(e);
      }
      idx++;
    }
    if (leaderCommit > n.commitIndex) {
      n.commitIndex = Math.min(leaderCommit, n.log.length - 1);
      this.#applyCommitted(n);
    }
    // matchIndex must describe the REQUEST (prevLogIndex + entries sent), not the
    // follower's whole log - the follower may hold extra entries the leader lacks.
    this.#send(n.id, msg.from, 'AppendEntriesReply', { term: n.currentTerm, ok: true, matchIndex: prevLogIndex + entries.length });
  }

  #handleAppendEntriesReply(n, msg) {
    const { term, ok, matchIndex } = msg.data;
    if (n.state !== 'leader' || term !== n.currentTerm) return;
    if (ok) {
      n.matchIndex[msg.from] = Math.max(n.matchIndex[msg.from] ?? -1, matchIndex);
      n.nextIndex[msg.from] = (n.matchIndex[msg.from]) + 1;
      // advance commitIndex: an entry from the leader's own term replicated on a majority
      const majority = Math.floor(this.cfg.nodeCount / 2) + 1;
      for (let i = n.log.length - 1; i > n.commitIndex; i--) {
        if (n.log[i].term !== n.currentTerm) continue;
        let count = 1;
        for (const m of this.nodes) {
          if (m.id !== n.id && (n.matchIndex[m.id] ?? -1) >= i) count++;
        }
        if (count >= majority) {
          n.commitIndex = i;
          this.#applyCommitted(n);
          break;
        }
      }
    } else {
      n.nextIndex[msg.from] = Math.max(0, (n.nextIndex[msg.from] ?? n.log.length) - 1);
      this.#sendAppend(n, msg.from);
    }
  }

  // ---------- event processing ----------

  step() {
    const ev = this.pq.pop();
    if (!ev) return null;
    this.steps++;
    this.now = ev.t;
    const p = ev.payload;
    switch (ev.kind) {
      case 'election-timeout': {
        const n = this.nodes[p.node];
        if (!n.down && n.state !== 'leader' && p.deadline === n.electionDeadline) {
          this.#startElection(n);
        }
        break;
      }
      case 'heartbeat': {
        const n = this.nodes[p.node];
        if (!n.down && n.state === 'leader' && n.currentTerm === p.term) {
          this.#broadcastAppend(n);
          this.#schedule(this.now + this.cfg.heartbeatMs, 'heartbeat', { node: n.id, term: p.term });
        }
        break;
      }
      case 'deliver': {
        const n = this.nodes[p.to];
        this.inflight = this.inflight.filter(m => m !== p);
        if (n.down) { this.#record('net-drop', p.from, `N${p.from}->N${p.to} ${p.mtype} lost (node down)`); break; }
        if (p.mtype === 'RequestVote') this.#handleRequestVote(n, p);
        else if (p.mtype === 'RequestVoteReply') this.#handleRequestVoteReply(n, p);
        else if (p.mtype === 'AppendEntries') this.#handleAppendEntries(n, p);
        else if (p.mtype === 'AppendEntriesReply') this.#handleAppendEntriesReply(n, p);
        break;
      }
      case 'client-write': {
        const key = this.cfg.keyPool[Math.floor(this.rng() * this.cfg.keyPool.length)];
        const value = 1000 + Math.floor(this.rng() * 9000);
        const seq = this.clientCompleted + (this.clientPending ? 1 : 0);
        const leader = this.nodes.find(n => !n.down && n.state === 'leader');
        if (leader && !this.clientPending) {
          const entry = { term: leader.currentTerm, op: { key, value, seq } };
          leader.log.push(entry);
          this.#record('client', leader.id, `client write ${key}=${value} -> N${leader.id} log[${leader.log.length - 1}]`);
          if (this.cfg.bugMode === 'early-commit') {
            // INJECTED MUTATION: leader applies locally without majority replication.
            leader.commitIndex = leader.log.length - 1;
            this.#applyCommitted(leader);
          } else {
            this.#broadcastAppend(leader);
          }
          this.clientPending = { key, value };
          this.#schedule(this.now + 5, 'client-ack-check', { key, value, tries: 0 });
        } else {
          this.#record('client', -1, `client write ${key}=${value} queued (no known leader)`);
        }
        this.#schedule(this.now + this.cfg.workloadEveryMs, 'client-write', {});
        break;
      }
      case 'client-ack-check': {
        const applied = this.nodes.find(n => !n.down && n.kv[p.key] === p.value);
        if (applied) {
          this.#record('client', applied.id, `client write ${p.key}=${p.value} acknowledged via N${applied.id}`);
          this.clientPending = null;
          this.clientCompleted++;
        } else if (p.tries < 40) {
          this.#schedule(this.now + 25, 'client-ack-check', { key: p.key, value: p.value, tries: p.tries + 1 });
        } else {
          this.#record('client', -1, `client write ${p.key}=${p.value} timed out (no ack)`);
          this.clientPending = null;
        }
        break;
      }
      case 'crash': {
        const n = this.nodes[p.node];
        if (!n.down) {
          const wasLeader = n.state === 'leader';
          // volatile state lost; persistent (currentTerm, votedFor, log) survives
          const keep = { currentTerm: n.currentTerm, votedFor: n.votedFor, log: n.log };
          Object.assign(n, this.#freshNode(n.id), keep);
          n.down = true; // set AFTER the reset, or the fresh node state would clear it
          this.#record('fault', n.id, `N${n.id} CRASHED${wasLeader ? ' (was leader)' : ''}`);
        }
        break;
      }
      case 'restart': {
        const n = this.nodes[p.node];
        if (n.down) {
          n.down = false;
          this.#record('fault', n.id, `N${n.id} restarted (log=${n.log.length} entries survived)`);
          this.#resetElectionTimer(n);
        }
        break;
      }
      case 'partition': {
        this.partitions.push({ a: p.a, b: p.b });
        this.#record('fault', -1, `PARTITION cut between [${p.a.map(i => 'N' + i)}] and [${p.b.map(i => 'N' + i)}]`);
        break;
      }
      case 'heal': {
        this.partitions = [];
        this.#record('fault', -1, 'partition healed');
        break;
      }
    }
    this.#checkElectionSafety();
    return { kind: ev.kind, t: this.now };
  }

  #checkElectionSafety() {
    const byTerm = new Map();
    for (const n of this.nodes) {
      if (!n.down && n.state === 'leader') {
        if (!byTerm.has(n.currentTerm)) byTerm.set(n.currentTerm, []);
        byTerm.get(n.currentTerm).push(n.id);
      }
    }
    for (const [term, ids] of byTerm) {
      if (ids.length > 1) {
        this.#violation('election-safety', `term ${term} has ${ids.length} leaders: ${ids.map(i => 'N' + i).join(', ')}`);
      }
    }
  }

  run(eventCount) {
    let done = 0;
    while (done < eventCount && this.pq.size() > 0) {
      this.step();
      done++;
    }
    return done;
  }

  runUntil(t) {
    let done = 0;
    while (this.pq.size() > 0 && this.pq.peek().t <= t) {
      this.step();
      done++;
    }
    return done;
  }

  // deterministic run fingerprint
  digest() { return this.hash.hex(); }

  getSnapshot() {
    return {
      now: Math.round(this.now * 1000) / 1000,
      events: this.trace.length,
      digest: this.digest(),
      violations: this.violations.slice(),
      partitions: this.partitions.map(p => ({ a: p.a.slice(), b: p.b.slice() })),
      nodes: this.nodes.map(n => ({
        id: n.id, down: n.down, state: n.state, term: n.currentTerm,
        votedFor: n.votedFor, logLen: n.log.length, commitIndex: n.commitIndex,
        lastApplied: n.lastApplied, kv: Object.assign({}, n.kv),
        log: n.log.map(e => ({ term: e.term, key: e.op.key, value: e.op.value, seq: e.op.seq })),
      })),
      inflight: this.inflight.map(m => ({
        from: m.from, to: m.to, mtype: m.mtype, sentT: m.sentT, deliverT: m.deliverT,
      })),
    };
  }
}

// Convenience: run a whole scenario and return a compact result (used by tests).
export function runScenario(config, eventCount) {
  const sim = new Simulation(config);
  sim.run(eventCount);
  return {
    digest: sim.digest(),
    events: sim.trace.length,
    violations: sim.violations.slice(),
    commits: sim.trace.filter(e => e.kind === 'commit').length,
  };
}

export const SCENARIOS = {
  clean: { label: 'Clean run', faults: { drop: 0, dup: 0, delaySpike: 0 }, schedule: [] },
  leaderCrash: {
    label: 'Rolling crashes + failover',
    faults: { drop: 0, dup: 0, delaySpike: 0 },
    schedule: [
      { at: 400, action: 'crash', args: { node: 0 } },
      { at: 500, action: 'crash', args: { node: 1 } },
      { at: 600, action: 'crash', args: { node: 2 } },
      { at: 1100, action: 'restart', args: { node: 0 } },
      { at: 1300, action: 'restart', args: { node: 1 } },
      { at: 1500, action: 'restart', args: { node: 2 } },
    ],
  },
  partition: {
    label: 'Network partition (3|2 split)',
    faults: { drop: 0, dup: 0, delaySpike: 0 },
    schedule: [
      { at: 500, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
      { at: 1500, action: 'heal', args: {} },
    ],
  },
  storm: {
    label: 'Message storm (loss + dup + spikes)',
    faults: { drop: 0.12, dup: 0.08, delaySpike: 0.15 },
    schedule: [],
  },
  bugEarlyCommit: {
    label: 'INJECTED BUG: leader commits without majority',
    faults: { drop: 0, dup: 0, delaySpike: 0 },
    bugMode: 'early-commit',
    schedule: [
      { at: 600, action: 'partition', args: { a: [0, 1], b: [2, 3, 4] } },
      { at: 1600, action: 'heal', args: {} },
    ],
  },
  bugNoLogCheck: {
    label: 'INJECTED BUG: votes granted without log freshness check',
    faults: { drop: 0, dup: 0, delaySpike: 0 },
    bugMode: 'no-log-check',
    schedule: [
      { at: 600, action: 'partition', args: { a: [0, 1, 2], b: [3, 4] } },
      { at: 2000, action: 'heal', args: {} },
    ],
  },
};
