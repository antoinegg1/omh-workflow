# Round 4 Contract

Written BEFORE implementation, per the RLCR loop rule. One mainline objective.

## Context (why this round exists)

Codex's Round-3 review verdict was **ADVANCED**: the required append-only
`testbench/knowledge` entry (`glm52--moe_total_prefill--mi300x--20260723a`) is
installed correctly, `lint` passes, `query` returns it, and every result number
traces to the persisted gate whose `candidate.sha256` matches the committed
`candidate.py`. Clean closure is blocked by exactly **one** finding: the Round-3
contract's own Definition of Done required `knowledge.py index --check` and
`distill --check` to be green (regenerated if needed), and Round 3 instead left
them stale under an "add-only" rationale. Those five outputs are **git-tracked**,
so leaving them stale is a real tree inconsistency and an unjustified deferral of
a requirement I wrote into my own contract. The reviewer has ruled; Round 4
executes the fix.

Reproduced this round at HEAD `1a315c6` (tree clean):
- `knowledge.py lint` → `17 entries, 0 problems` (already green).
- `knowledge.py index --check` → 3 stale: `queries/by-op.md`,
  `queries/by-bottleneck.md`, `queries/by-technique.md`.
- `knowledge.py distill --check` → stale: `distilled.json`, `distilled.md`.

## Mainline Objective (single, blocking)

Regenerate the git-tracked generated knowledge-base bookkeeping so that **all four**
`knowledge.py` validators pass, satisfying the Round-3 Definition of Done that
Round 3 deferred. This is a **data-only** round: no kernel code, no gate re-run,
no frozen authority touched. It only refreshes generated files that are *derived
from* the already-committed entries.

## Target Acceptance Criteria

- **AC-5 (finalize / reviewable) — primary.** The generated KB outputs match the
  committed entry set; the diff is limited to exactly the 5 generated files and
  excludes `.humanize/`, scratch, caches, binaries; the change is documented.
- **AC-4 (evidence honesty) — secondary.** The regenerated index/distill content
  is derived only from the persisted, already-installed entries (no new perf
  claim, no hand-editing of generated content).

Guardrail (unchanged, must hold): **AC-1** — this round changes ONLY generated
files under `testbench/knowledge/`; no `candidate.py`, reference, taskset,
`official_metrics`, correctness threshold, cost model, device peak, timing,
deploy metadata, task `run.sh`, or existing `entries/*.json` may change.

## Blocking issues for the mainline

The stale generated KB outputs ARE the mainline objective; there is no separate
blocker. No kernel or correctness issue is in play (no gate is re-run this round).

## Queued (explicitly OUT of scope this round)

- `AITER_TRITON_ONLY=0` remaining manual provenance rather than result-schema
  state (owner/infra follow-up; non-blocking — no new GPU gate is run here).
- Non-MoE task `run.sh` wrappers selecting the wrong Python when repo `.venv` is
  absent (frozen-authority generated wrappers; owner/infra follow-up).
- Any re-optimization of the four accepted wins (no kernel change this round).

## Scope (what this round touches)

In scope (generated data only):
- `testbench/knowledge/queries/by-op.md`
- `testbench/knowledge/queries/by-bottleneck.md`
- `testbench/knowledge/queries/by-technique.md`
- `testbench/knowledge/distilled.json`
- `testbench/knowledge/distilled.md`
  (regenerated via `python3 testbench/bin/knowledge.py index` and `... distill`)
- `.humanize/` loop state (contract, tracker, summary, bitlesson) — NOT committed.

Out of scope (must NOT change): everything under AC-1 guardrail above, plus the
installed `entries/glm52--moe_total_prefill--mi300x--20260723a.json` (leave as-is).

## Task lanes

- `[mainline]` task17 — run `knowledge.py index` + `distill`; verify the working
  diff is exactly the 5 generated files; verify all four validators
  (`lint`, `query`, `index --check`, `distill --check`) green; commit with a
  `knowledge:`-scoped message (no `.humanize/`, no authority change). (coding, claude)
- `[queued]` (documented, not executed): the two infra follow-ups above.

## Definition of Done (concrete success criteria)

1. `knowledge.py index` and `knowledge.py distill` run from HEAD.
2. `git status --porcelain` shows **exactly** the 5 generated files above — no
   more, no fewer, no `.humanize/`, no scratch/caches/binaries.
3. All four validators pass:
   - `knowledge.py lint` → `0 problems`,
   - `knowledge.py query --task glm52/moe_total_prefill --gpu MI300X` → returns
     `glm52--moe_total_prefill--mi300x--20260723a` newest-first,
   - `knowledge.py index --check` → `0 stale`,
   - `knowledge.py distill --check` → clean.
4. Committed with a `knowledge:`-scoped message; no AI-authorship trailer; no
   `.humanize/` staged; no authority/kernel change in the commit.
5. `goal-tracker.md` updated (task10 + task16 → completed, blocking side issue
   resolved); `round-4-summary.md` written with a `## BitLesson Delta` whose
   action corrects the now-wrong "add-only" guidance in
   `BL-20260723-dual-knowledge-base-requirement`.
