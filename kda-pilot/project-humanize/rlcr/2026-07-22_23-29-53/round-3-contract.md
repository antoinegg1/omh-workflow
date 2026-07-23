# Round 3 Contract

Written BEFORE implementation, per the RLCR loop rule. One mainline objective.

## Mainline Objective (single, blocking)

Add the required append-only `testbench/knowledge` entry for the **Round-2
`moe_total_prefill` tail-shape recovery** optimization session, so the session
closes cleanly. This is the ONE blocking finding from Codex's Round-2 review
(verdict: ADVANCED — kernel work verified correct and complete; closure blocked
only by the missing knowledge-base entry).

The repo guide (`testbench/knowledge/README.md`) requires **one structured JSON
entry per completed optimization session**. Round 2 completed the MoE tail-shape
recovery but appended only a `.humanize/bitlesson.md` lesson, which is a separate,
project-local KB and is **not** a substitute for `testbench/knowledge`.

This round changes **no kernel code** and runs **no new GPU gate**. It records
already-persisted, already-verified facts into the harness knowledge base.

## Scope (what this round touches)

In scope (data-only, knowledge subsystem):
- `testbench/knowledge/entries/glm52--moe_total_prefill--mi300x--20260723a.json`
  (new, append-only) — installed via `python3 testbench/bin/knowledge.py add`.
- The generated cross-reference bookkeeping (`testbench/knowledge/queries/*.md`,
  `distilled.{json,md}`) is deliberately **left as-is**: measured this round, it
  is ALREADY stale (`index --check` 3 stale, `distill --check` 2 stale) BEFORE
  adding my entry — the first-loop entries were committed via `add` without
  regenerating it, and no gate (selftest/sync/CI) enforces its freshness. The
  documented workflow (`README.md`) is `add` → `lint`. Regenerating would fold
  pre-existing, unrelated backlog churn from the other 16 entries into this diff,
  violating AC-5's "documented per task/shape" reviewability. So: **add-only**,
  matching precedent; the pre-existing staleness is recorded, not introduced.
- `.humanize/rlcr/2026-07-22_23-29-53/round-2-summary.md`,
  `round-3-summary.md`, and `goal-tracker.md` — cite the installed entry; mark
  task10 complete. (`.humanize/` is excluded from the reviewable diff and is not
  committed.)

Explicitly OUT of scope (frozen authority — must NOT change):
- Any `candidate.py`, reference function, taskset, `official_metrics`,
  correctness thresholds, cost model, device peaks, timing semantics, deployment
  metadata, or task `run.sh`.
- The two accepted-and-verified MoE/dsa/index wins (no re-optimization).

## Source-of-truth facts (only persisted `result.json` numbers, no estimates)

Committed-candidate official prefill gate
`/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json`
(run_id `20260723T043507Z-daddf4`, `--repeat 10`, `AITER_TRITON_ONLY=0`):
- candidate sha256 `221718a3…b167c6` == committed `moe_total_prefill/candidate.py`
  (verified this round) → the JSON provably describes commit `017bfdc`.
- aggregate: `geomean_primary_util_ratio` 1.0459, `…_conservative` 1.0352,
  `min_primary_util_ratio_conservative` 1.0038, `shapes_won` 3,
  `shapes_regressed` 0, `worst_calc_diff` 0.0, repeat 10.
- per-shape verdict all `win`; cons 1.0792 / 1.0242 / 1.0038; candidate MFU
  0.12448 / 0.17218 / 0.21967 vs ref 0.11438 / 0.16619 / 0.21649.

`approaches` records the bit-exact `GROUP_SIZE_M` sweep at M=4096 (round-2 probe):
GM∈{1,8} regress (cons 0.958 / 0.975), GM∈{2,4} neutral/parity (cons 0.980 /
0.996 — incl. the previously-optimal GM=4), GM∈{16,32} win (cons 1.010 / 1.012);
committed winner **GM=16 for M≥4096** because it restored the full official sweep
with `BLOCK_SIZE_K` untouched (calc_diff 0). Companion decode `BLOCK_SIZE_M`
sweep {16,32,64,128} at M=32 recorded as preservation context: BM=32 already the
widest-margin win → no decode code change.

## Target Acceptance Criteria

- **AC-5 (finalize/reviewable):** the completed session is recorded in the
  harness knowledge base per the repo guide; `knowledge.py lint` passes; diff is
  reviewable and excludes `.humanize/`.
- **AC-4 (evidence):** every number in the entry traces to a persisted
  `result.json` (no `profile.py`/estimate numbers), matching the README honesty
  rule.

## Task lanes

- `[blocking]` task16 — draft, install (`knowledge.py add`), and lint the
  `glm52--moe_total_prefill--mi300x--20260723a` entry; regenerate KB indices if a
  `--check` gate would otherwise flag them stale. (coding, claude)
- `[mainline]` task10 (reopened) — cite the installed entry in the round-2
  summary + tracker and mark finalize complete. (coding, claude)

## Definition of done

1. `knowledge.py add` installs the entry; `knowledge.py lint` → 0 problems.
2. `knowledge.py index --check` and `distill --check` are green (regenerated if
   needed).
3. Entry committed with a `knowledge:`-scoped message (no `.humanize/` staged, no
   AI authorship trailer).
4. round-2-summary.md + goal-tracker cite the entry id; task10 marked complete;
   round-3-summary.md written.
