# Round 5 Contract (Review Phase)

Written BEFORE touching code, per the RLCR loop rule. This is a **review-phase**
round: `codex review --base kda-base/glm52-rocm-mfu-bw-20260722` found one
`[P3]` issue. A code-review finding does NOT replace the mainline objective.

## Mainline Objective (unchanged, already complete)

Maximize official ROCm/MI300X `roofline_mfu_bw` across the four official tasks
without regressing any accepted win or touching frozen authority — and record the
completed session in both knowledge bases. This was achieved in Rounds 0–4
(dsa win kept; MoE tail-shape wins restored bit-exact; `testbench/knowledge` entry
installed and its generated indices regenerated green). **This round does not
change the mainline or any kernel/candidate.**

## This round's job: resolve the single blocking review finding

- **[P3] `archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105`**
  — `final_result()` reads `runs/glm52/<task>/<run_id>/result.json`, but `runs/`
  is gitignored (`.gitignore:31`), so on a fresh archive checkout those files are
  absent. The matching `result.json` IS committed at
  `archive/0720-Best-GLM-52/lichangye/<task>/result.json` (verified: `run.run_id`
  matches all four hardcoded ids; all consumed fields present with the accepted
  baseline values). The documented rebuild command therefore depends on the
  author's local run cache instead of archive contents.

Classification: **blocking side issue** (it blocks clean review acceptance — the
loop does not close while a `[P0-9]` finding is open). It is NOT frozen authority
(an archive rebuild helper, not taskset/metrics/thresholds/references/cost-model/
peaks/timing/deploy/candidate), so fixing it is in-authority and reviewer-requested.

## Target Acceptance Criteria

- **AC-5 (reviewable / self-contained artifacts) — primary.** A committed rebuild
  script must depend only on committed inputs; the fix is bounded to the one
  flagged file and documented.
- **AC-1 (authority frozen) — guardrail.** No candidate, reference, taskset,
  `official_metrics`, threshold, cost model, peak, timing, deploy metadata, task
  `run.sh`, harness, or `testbench/knowledge` change.

## Fix (minimal, exactly what was flagged)

`final_result(task, run_id)` reads the committed archive copy
(`OUT.parent / task / "result.json"`) preferentially, falling back to the
gitignored `runs/glm52/<task>/<run_id>/result.json` cache only if the archive copy
is absent; `source` reports the archive-relative path. Nothing else in the script
changes. Do **not** regenerate the committed plots/CSV (they need the local
transcript + matplotlib; regenerating would churn binaries and is not what the
finding asks).

## Queued (documented, explicitly OUT of scope this round)

- The same script's Claude-transcript token source (hardcoded `~/.claude/...jsonl`
  at module import) is a SEPARATE non-archived dependency the review did not flag
  and the token_perf README already discloses. Not fixed here (avoid scope creep;
  it would need archiving a transcript / refactoring token loading).
- `AITER_TRITON_ONLY=0` provenance; non-MoE `run.sh` Python selection (prior
  owner/infra follow-ups).

## Task lanes

- `[blocking]` task21 — fix `build_token_perf.py` to read the committed archived
  `result.json`; `py_compile` + path/field check; commit with an `archive:`-scoped
  message (no `.humanize/`, no AI-authorship trailer, no authority change). (coding, claude)

## Definition of Done

1. `build_token_perf.py` reads the archived `result.json` (cache fallback);
   `python3 -m py_compile` clean; a functional check confirms the archived path
   resolves and parses for all 4 tasks.
2. `git status --porcelain` shows exactly that one file; no `.humanize/`, no
   binaries/plots/CSV churn.
3. Committed with an `archive:`-scoped message; no AI-authorship trailer.
4. Frozen-authority preflight still green (`selftest`, `sync --check`, knowledge
   `lint`/`index --check`/`distill --check` unaffected — none of those inputs
   changed).
5. `goal-tracker.md` records the P3 as a resolved blocking side issue + the queued
   transcript follow-up; `round-5-summary.md` written with a `## BitLesson Delta`.
