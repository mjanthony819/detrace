# Detrace

**Break a distributed system. Rewind. Replay it exactly.**

Detrace is a deterministic fault-injection simulator and flight recorder for a
simulated distributed key-value cluster. Five nodes run a simplified,
Raft-inspired consensus protocol (leader election + log replication). You can
crash nodes, cut network partitions, corrupt the message stream with drops,
duplicates and delay spikes - and then scrub a timeline backwards to inspect
the exact cluster state at any recorded event. Because the whole run is driven
by a single seed, replaying the seed reproduces the identical event trace and
run digest.

Everything runs in the browser as a static site. No build step, no backend,
no dependencies.

## Why it exists

Deterministic simulation testing is how teams like FoundationDB and TigerBeetle
hunt distributed-systems bugs: make the whole system deterministic from a seed,
inject faults in simulation, and any failure can be replayed exactly. Detrace
is a small, honest, self-contained demonstration of that technique, paired with
runtime invariant monitors that catch safety violations the moment they happen.

## What you can do

- **Run scenarios**: clean run, leader crash + failover, network partition
  (3|2 split), message storm (loss + duplication + delay spikes), and two
  scenarios with deliberately injected bugs (below).
- **Inject faults live**: message drop / duplicate / delay-spike probabilities.
- **Build custom experiments**: the experiment builder edits the fault schedule
  directly - crash, restart, partition and heal actions at chosen virtual
  times, plus the injected-bug mode. Schedules are validated before they run
  (ascending times, valid nodes, disjoint partition sides) and invalid ones
  are rejected with specific errors.
- **Time travel**: drag the timeline to any recorded event. The state is
  rebuilt by re-simulating from the seed, so what you see is exactly what
  happened.
- **Watch invariant monitors**:
  - *election safety* - at most one leader per term
  - *commit safety* - a committed log index never changes its value
  - *committed overwrite* - an entry a node has already applied is never overwritten
- **Verify replay**: one click re-runs the entire config from scratch and
  compares the rolling FNV-1a digest of the trace.
- **Export the trace** as JSON (`config + stepped events + digest + trace`),
  which is everything needed to reproduce the run.
- **Import a recording back**: an exported file is shape-validated (it is
  untrusted data: bounded sizes, strict field checks, its text never rendered
  as HTML), then its recorded config is replayed under this engine build and
  the digests compared - "recording verified" means *replay agreement*, no
  more. A verified recording loads as a scrubbable run.
- **Share an experiment as a link**: the full config (seed + faults +
  schedule + bug mode) is encoded into the URL, so anyone opening the link
  replays the identical run.
- **Compare two runs**: run the current config against any built-in scenario
  (same seed) or an imported recording, and get the digest match or the
  *first trace event* where the two runs diverge - the "did this change
  alter the behavior?" check.

## Honest scope

- The consensus protocol is an **educational model inspired by Raft**, not
  production Raft and not formally verified. It omits snapshots, membership
  changes, pre-vote and other real-world details.
- Scenarios labeled **INJECTED BUG** deliberately mutate the model
  (`early-commit`: the leader applies writes without majority replication;
  `no-log-check`: votes are granted without the log-freshness check). These
  are planted bugs in this toy model so the monitors have something to catch -
  they are **not** claims about vulnerabilities in Raft itself.
- The reproducibility claim is narrow and tested: within this engine version,
  one full configuration (seed + faults + schedule + bug mode) reproduces the
  identical trace and digest. That is a consistency check verified for the
  tested scenarios, not a general proof. See `tests/engine.test.mjs`.
- Recording verification is replay agreement: an imported file's recorded
  digest is compared to this engine build's replay of its config. A mismatch
  means the file was altered or produced by a different engine build; the app
  then shows its own replay, not the file's claims.
- Run comparison reports the first trace event where two configs diverge
  under this engine. Two runs comparing equal over N stepped events is
  evidence for those N steps, not a proof of equivalence.

## Architecture

| file | role |
| --- | --- |
| `engine.js` | deterministic simulation kernel: seeded PRNG (mulberry32 over an FNV-hashed seed), virtual-time event heap, network model with fault injection, Raft-like node logic, invariant monitors, rolling FNV-1a trace digest. Runs unchanged in the browser and in Node. |
| `app.js` | UI driver: play/pause/step loop, SVG cluster view with animated in-flight messages, timeline scrubber (time travel by re-simulation), event log, node inspector, export/verify, experiment builder, import/share/compare panels. |
| `experiments.js` | experiment-workflow helpers, pure and shared between browser and tests: schedule/config validation, share-token encode/decode, trace-file validation, recording verification, run comparison with first-divergence. |
| `index.html`, `style.css` | handcrafted single-screen layout; no frameworks, no external assets. |
| `tests/engine.test.mjs` | `node --test` suite: determinism across seeds/scenarios, time-travel prefix equality, trace export round-trip, invariant checks under fault storms/partitions/rolling crashes, injected-bug detection, performance sanity. |
| `tests/experiments.test.mjs` | `node --test` suite for the workflow helpers: schedule validation (bad times, bad nodes, overlapping partitions), share-token round-trip including replay-digest equality, trace-file validation and tamper detection, run comparison first-divergence. |
| `tests/browser-check.mjs` | Playwright end-to-end checks against the real page: scenario/monitors, builder apply+reject, share-link boot reproducing a digest, export/import verification, invalid-import rejection, comparison output, mobile layout. |

Key design decisions:

1. **All randomness flows from one seed.** Election timeouts, message delays,
   fault coin-flips and the client workload all draw from a single mulberry32
   stream, consumed in deterministic event order. Same seed, same history.
2. **Time travel is re-simulation, not snapshotting.** Determinism makes the
   seed the only snapshot you need; scrubbing to event *k* re-runs the config
   until the recorded trace reaches length *k*.
3. **Monitors are external to the protocol.** The commit-safety monitor keeps
   a global map of committed index -> entry id and flags any divergence, the
   same way an independent test oracle would.
4. **Virtual time.** The simulation runs on a logical clock in milliseconds,
   decoupled from wall-clock speed, so a 30-second run can be simulated in a
   blink and replayed at any speed.

## Run it

Open `index.html` in a browser, or serve the folder statically:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Deep links: `?scenario=storm&seed=my-seed&speed=60`
(scenarios: `clean`, `leaderCrash`, `partition`, `storm`, `bugEarlyCommit`,
`bugNoLogCheck`).

## Tests

```bash
npm test        # node --test tests/*.test.mjs
```

30 node tests covering determinism, replay, export round-trip, invariant
checks under fault injection, detection of both injected bugs, and the
experiment-workflow helpers (validation, share links, import verification,
run comparison). `tests/browser-check.mjs` adds 19 end-to-end browser checks
(needs Playwright and a local Chrome).

## Disclosure

Requested by M J Anthony; an AI assistant selected the technical approach and produced the implementation, tests,
demo and documentation, for the Arbiter Hacks V1 hackathon. The AI contribution is disclosed here in line with the
competition's expectation of honest authorship; the design decisions are documented in this
README and the project manual.
