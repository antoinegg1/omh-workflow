# FULL GOAL ALIGNMENT CHECK - Round 4

This is a **mandatory checkpoint** (at configurable intervals). You must conduct a comprehensive goal alignment audit.

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md

You MUST read this plan file first to understand the full scope of work before conducting your review.

---
## Claude's Work Summary
<!-- CLAUDE's WORK SUMMARY START -->
# Round 4 Summary

**Outcome: COMPLETE — the single Round-3-review blocker is resolved.** Codex's
Round-3 verdict was **ADVANCED**: the required append-only `testbench/knowledge`
entry (`glm52--moe_total_prefill--mi300x--20260723a`) was installed correctly and
`lint`/`query` passed, but clean closure was blocked by exactly one finding — the
Round-3 contract's own Definition of Done required `knowledge.py index --check` and
`distill --check` to be green, and Round 3 instead left them stale under an
"add-only" rationale. Those five outputs are git-tracked, so leaving them stale
was a real tree inconsistency and an unjustified deferral. **Round 4 regenerates
them.** No kernel code changed, no GPU gate was re-run, no frozen authority was
touched — this round refreshes generated files that are *derived from* the
already-committed entries.

---

## Work Completed — mainline objective (task10 + task16): RESOLVED

Regenerated the git-tracked generated knowledge-base bookkeeping so **all four**
`knowledge.py` validators pass:

```
python3 testbench/bin/knowledge.py index    → wrote queries/by-op.md, by-bottleneck.md, by-technique.md
python3 testbench/bin/knowledge.py distill   → wrote distilled.json + distilled.md (17 proven techniques)
```

### Why the diff is large but correct (fully entry-derived)

The generated files had last been built when the KB held only the **12** first-loop
B200 entries (`generated_from_entries: 12`). All **five** glm52 MI300X entries — the
four first-loop `20260722a` entries (`dsa_prefill_attn`, `index_score_prefill`,
`moe_total_decode`, `moe_total_prefill`) **plus** the Round-3 `20260723a` entry —
had never been folded into the query/distill views. Regeneration catches all five
up (`generated_from_entries: 12 → 17`). Every added line is derived from the
committed entries (technique names, `geo~1.0459`, bottleneck classes, etc.) — no
hand-editing, no new performance claim. The Round-3 `20260723a` entry now appears
**newest-first** under `moe_total` in `by-op.md`, and its three techniques
(`bit-exact-group-size-m-reshift`, `group-size-m-full-sweep-m4096`,
`decode-block-size-m-preservation-check`) appear in `by-technique.md`.

This is exactly the "pre-existing staleness" Round 3 flagged — but Codex correctly
ruled that regenerating (not deferring) is the required action: the files are
git-tracked, the round's own DoD required the checks green, and the diff is
**bounded to the generated files**, so nothing unrelated leaks.

## Files Changed (harness repo)

One commit, exactly the 5 generated files (`git status --porcelain` verified — no
`.humanize/`, no scratch, no more, no fewer):

- `7202073` — `knowledge: regenerate query/distill indexes to match committed
  entries`
  - `testbench/knowledge/queries/by-op.md` (+14)
  - `testbench/knowledge/queries/by-bottleneck.md` (+11)
  - `testbench/knowledge/queries/by-technique.md` (+52)
  - `testbench/knowledge/distilled.json` (+204/-2)
  - `testbench/knowledge/distilled.md` (+7/-2)
  - Total **5 files, +286/-2**. `knowledge:` scope; **no AI-authorship trailer**
    (verified); tree clean after commit.

No `candidate.py`, reference, taskset, `official_metrics`, correctness threshold,
cost model, device peak, timing, deployment metadata, task `run.sh`, or existing
`entries/*.json` change. The installed `20260723a` entry was left as-is.

## Validation

All four knowledge validators green at HEAD `7202073`:

```
knowledge.py lint                                              → 17 entries, 0 problems
knowledge.py query --task glm52/moe_total_prefill --gpu MI300X → glm52--moe_total_prefill--mi300x--20260723a [win geo=1.0459 minc=1.0038] (newest-first)
knowledge.py index --check                                     → 0 stale
knowledge.py distill --check                                   → up to date
```

AC-1 authority frozen (proof only generated KB docs changed):

```
python3 testbench/bin/selftest.py                              → 26 tasks, 0 problems
sync_glm52_tasks.py --check (env-unset)                        → 24 task dirs in sync  (benign "no CUDA" warning)
git status --porcelain                                         → clean
```

## Remaining Items

None blocking. Two infra follow-ups remain **queued** (owner/infra, out of scope
this round, non-blocking — no new GPU gate is run here):
- `AITER_TRITON_ONLY=0` remains manual provenance rather than result-schema state.
- Non-MoE task `run.sh` wrappers select the wrong Python when repo `.venv` is
  absent (frozen-authority generated wrappers).

## BitLesson Delta

- Action: update
- Lesson ID(s): BL-20260723-dual-knowledge-base-requirement
- Notes: Corrected the now-wrong `add-ONLY: do NOT regenerate queries/*.md or
  distilled.{json,md}` clause. Codex's Round-3 review ruled that leaving those
  git-tracked generated files stale was an unjustified deferral of a requirement I
  had written into my own Round-3 contract's definition-of-done (which required
  `index --check` and `distill --check` green). The updated lesson now instructs:
  after `knowledge.py add`, run `knowledge.py index` + `distill` and confirm ALL
  FOUR validators (`lint`, `query`, `index --check`, `distill --check`) green, then
  commit the regenerated `queries/*.md` + `distilled.{json,md}` alongside the entry;
  the regenerated diff is bounded to exactly the generated files and is fully
  entry-derived, so it does NOT violate AC-5 (verify with `git status --porcelain`
  before committing). Solution / Validation Evidence / Source Rounds fields were
  also extended with the Round-4 resolution. This is an in-place correction of an
  existing lesson (no new id) whose prior guidance would otherwise cause a repeat
  of the exact Round-3 mistake.
- Selector note: the `bitlesson-selector` subagent failed again this round (3rd
  time this session) with the same Bedrock `context_management: Extra inputs are
  not permitted` ValidationException — a confirmed environment/API outage in the
  subagent path, not a task issue. BitLesson selection was performed **inline**
  against `.humanize/bitlesson.md` (selected `BL-20260723-dual-knowledge-base-requirement`
  as the governing lesson; the three kernel/env lessons and two decode memories are
  N/A since no kernel/env/gate work occurred).

## Goal Tracker Update

- **task10 (Finalize report): needs revision → completed** — generated KB
  bookkeeping regenerated; all four validators green; committed `7202073`.
- **task16 (Install + refresh harness knowledge entry): needs revision →
  completed** — entry installed Round 3, generated indices refreshed Round 4.
- **Blocking Side Issue "Generated knowledge cross-reference/distill files are
  stale": RESOLVED** (Round 4, data-only).
- Plan Evolution Log: added Round-4 row; Plan Version → 6.
- Completed-and-Verified: added AC-5 Round-4 row (generated KB regenerated,
  verified Round 4).
- **AC-5: satisfied** (Round-3 DoD met; diff reviewable, bounded to 5 generated
  files, `.humanize/` excluded). **AC-1: held** (selftest 26/0, sync 24-in-sync;
  only generated KB docs changed). **AC-4: honored** (regenerated content is
  entry-derived, no new perf claim).

## Four-task state (unchanged this round)

No kernel change and no gate re-run, so all four official tasks remain at their
Round-2-verified state: decode 2/2, prefill 3/3, dsa 3/3, index_score 3/3;
`shapes_regressed == 0` on every official shape; calc_diff bit-exact/unchanged.
<!-- CLAUDE's WORK SUMMARY  END  -->
---

## Development History (Integral Context)

Accumulated commits since loop start (oldest first):
```
7dc4959 moe_total_decode: shrink Triton BLOCK_SIZE_M for dense decode (bit-exact ~1.06-1.08x)
3c8aa34 moe_total_prefill: tune Triton GROUP_SIZE_M for dense prefill (bit-exact ~1.05-1.15x)
3531593 dsa_prefill_attn: fp32-QK torch sparse-MLA beats slow TileLang baseline
37132ff Optimize index_score_prefill via bit-exact BLOCK_KV override
46903b1 knowledge: record 4 GLM-5.2 MI300X optimization sessions + AC-4 fix
4597e91 dsa_prefill_attn: guard fp32-QK fast path to ROCm only (fix P1)
a7428ef dsa/index_score: anchor ROCm device guards to authoritative taskset
e01d123 glm52: align task metadata + harness defaults to ROCm/MI300X
baea0bc index_score_prefill: route ROCm fallback through harness reference (fix P1)
5efb3cf moe_total_{decode,prefill}: drop unused N from w1.shape unpack (finalize cleanup)
ebfadea archive lichangye GLM52 ROCm best candidates
3ddb2ea archive lichangye token perf plots
26bdb84 dsa_prefill_attn: route QK scores through aiter bf16 GEMM with fp32 output
017bfdc moe_total_prefill: raise M=4096 GROUP_SIZE_M to 16 to restore accepted win
1a315c6 knowledge: record Round-2 moe_total_prefill GROUP_SIZE_M reshift session
7202073 knowledge: regenerate query/distill indexes to match committed entries
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_23-29-53/round-3-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-3-review-result.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-2-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-2-review-result.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-1-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-1-review-result.md


Use this history to identify patterns across rounds: recurring issues, stalled progress, or drift from the mainline objective. Weight recent rounds more heavily but watch for systemic trends in the full commit log.

## Part 1: Goal Tracker Audit (MANDATORY)

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md and verify:

### 1.1 Acceptance Criteria Status
For EACH Acceptance Criterion in the IMMUTABLE SECTION:
| AC | Status | Evidence (if MET) | Blocker (if NOT MET) | Justification (if DEFERRED) |
|----|--------|-------------------|---------------------|----------------------------|
| AC-1 | MET / PARTIAL / NOT MET / DEFERRED | ... | ... | ... |
| ... | ... | ... | ... | ... |

### 1.2 Forgotten Items Detection
Compare the original plan (@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md) with the current goal-tracker:
- Are there tasks that are neither in "Active", "Completed", nor "Deferred"?
- Are there tasks marked "complete" in summaries but not verified?
- List any forgotten items found.

### 1.3 Deferred Items Audit
For each item in "Explicitly Deferred":
- Is the deferral justification still valid?
- Should it be un-deferred based on current progress?
- Does it contradict the Ultimate Goal?

### 1.4 Goal Completion Summary
```
Acceptance Criteria: X/Y met (Z deferred)
Active Tasks: N remaining
Estimated remaining rounds: ?
Critical blockers: [list if any]
```

## Part 2: Mainline Drift Audit (MANDATORY)

Determine whether the recent rounds are still serving the original plan:
- Is the current round's mainline objective clear and singular?
- Has Claude been advancing mainline ACs, or mostly clearing side issues?
- Which findings are true **blocking side issues** versus merely **queued side issues**?

Include a short drift summary:
```
Mainline Progress Verdict: ADVANCED / STALLED / REGRESSED
Blocking Side Issues: N
Queued Side Issues: N
```

The `Mainline Progress Verdict` line is mandatory. If you omit it, the Humanize stop hook will block the round and require the review to be rerun.

## Part 3: Implementation Review

- Conduct a deep critical review of the implementation
- Verify Claude's claims match reality
- Identify any gaps, bugs, or incomplete work
- Reference @docs for design documents

## Part 4: ## Goal Tracker Update Requests (YOUR RESPONSIBILITY)

Claude should normally keep the **mutable section** of `goal-tracker.md` up to date directly. If Claude's summary contains a "Goal Tracker Update Request" section, or if you detect tracker drift during review, YOU must:

1. **Evaluate the tracker state**: Is the mutable section still aligned with the Ultimate Goal and current AC progress?
2. **If correction is needed**: Update @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md yourself with the requested changes:
   - Move tasks between Active/Completed/Deferred sections as appropriate
   - Add entries to "Plan Evolution Log" with round number and justification
   - Add new issues to "Blocking Side Issues" or "Queued Side Issues" as appropriate
   - **NEVER modify the IMMUTABLE SECTION** (Ultimate Goal and Acceptance Criteria)
3. **If you reject a requested tracker change**: Include in your review why it was rejected

Common update requests you should handle:
- Task completion: Move from "Active Tasks" to "Completed and Verified"
- New blocking issues: Add to "Blocking Side Issues"
- New queued issues: Add to "Queued Side Issues"
- Plan changes: Add to "Plan Evolution Log" with your assessment
- Deferrals: Only allow with strong justification; add to "Explicitly Deferred"

## Part 5: Progress Stagnation Check (MANDATORY for Full Alignment Rounds)

To implement the original plan at @.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md, we have completed **5 iterations** (Round 0 to Round 4).

The project's `.humanize/rlcr/2026-07-22_23-29-53/` directory contains the history of each round's iteration:
- Round input prompts: `round-N-prompt.md`
- Round output summaries: `round-N-summary.md`
- Round review prompts: `round-N-review-prompt.md`
- Round review results: `round-N-review-result.md`

**How to Access Historical Files**: Read the historical review results and summaries using file paths like:
- `@.humanize/rlcr/2026-07-22_23-29-53/round-3-review-result.md` (previous round)
- `@.humanize/rlcr/2026-07-22_23-29-53/round-2-review-result.md` (2 rounds ago)
- `@.humanize/rlcr/2026-07-22_23-29-53/round-3-summary.md` (previous summary)

**Your Task**: Review the historical review results, especially the **recent rounds** of development progress and review outcomes, to determine if the development has stalled.

**Signs of Stagnation** (circuit breaker triggers):
- Same issues appearing repeatedly across multiple rounds
- No meaningful progress on Acceptance Criteria over several rounds
- Claude making the same mistakes repeatedly
- Circular discussions without resolution
- No new code changes despite continued iterations
- Codex giving similar feedback repeatedly without Claude addressing it

**If development is stagnating**, write **STOP** (as a single word on its own line) as the last line of your review output @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-4-review-result.md instead of COMPLETE.

## Part 6: Output Requirements

- If issues found OR any AC is NOT MET (including deferred ACs), write your findings to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-4-review-result.md
- Include specific action items for Claude to address, classified into:
  - Mainline Gaps
  - Blocking Side Issues
  - Queued Side Issues
- **If development is stagnating** (see Part 4), write "STOP" as the last line
- **CRITICAL**: Only write "COMPLETE" as the last line if ALL ACs from the original plan are FULLY MET with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any AC is deferred
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals allowed
