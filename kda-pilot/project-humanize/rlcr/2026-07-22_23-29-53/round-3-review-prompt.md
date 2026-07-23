# Code Review - Round 3

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-3-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Round 3 Summary

**Outcome: COMPLETE — the one Round-2-review blocker is resolved.** Codex's
Round-2 review verdict was **ADVANCED**: the kernel work (MoE tail-shape win
recovery) was verified correct and complete, but clean session closure was blocked
by a single finding — the harness repo guide (`testbench/knowledge/README.md`)
requires one append-only structured JSON entry per completed optimization session,
and Round 2 had updated only `.humanize/bitlesson.md` (a separate KB, not a
substitute). Round 3 installs that entry. **No kernel code changed, no new GPU gate
was run, no frozen authority was touched** — this round records already-persisted,
already-verified facts into the harness knowledge base.

---

## Mainline Objective — required knowledge-base entry: RESOLVED

Installed one append-only entry:
`testbench/knowledge/entries/glm52--moe_total_prefill--mi300x--20260723a.json`.

### Provenance / integrity (AC-4: every number from a persisted `result.json`)

Source = the committed-candidate official prefill gate
`/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json`
(run `20260723T043507Z-daddf4`, `--repeat 10 --iterations 30 --warmup 3`,
`AITER_TRITON_ONLY=0`, pinned-CK reference).

Integrity check performed this round: the gate JSON's
`candidate.sha256 = 221718a3…b167c6` was verified **byte-identical** to the
committed `testbench/tasks/glm52/moe_total_prefill/candidate.py` (HEAD `017bfdc`
before this round). So the entry's numbers provably describe the committed code,
not a scratch variant.

| Field (entry `result`) | Value | Source (r10b aggregate) |
|---|---|---|
| status | `win` | shapes_won 3, shapes_regressed 0 |
| geomean_speedup | 1.0459 | `geomean_primary_util_ratio` |
| min_speedup_conservative | 1.0038 | `min_primary_util_ratio_conservative` |
| repeat | 10 | `run.repeat` |
| shapes_won / shapes_regressed | 3 / 0 | aggregate |
| worst calc_diff | 0.0 | aggregate |

Per-shape (all `shape_verdict == win`): cons 1.0792 / 1.0242 / 1.0038; candidate
MFU 0.12448 / 0.17218 / 0.21967 vs reference 0.11438 / 0.16619 / 0.21649.

### Entry contents (matches Codex's required 6-step plan)

- `approaches[0]` **win** `bit-exact-group-size-m-reshift` (geomean 1.0459): the
  committed `_pick_group_size_m`→16 at M≥4096 (commit `017bfdc`), override only
  `GROUP_SIZE_M` on the reference's resolved gemm1/down configs, `BLOCK_SIZE_K`
  untouched → calc_diff 0.
- `approaches[1]` **abandoned** `group-size-m-full-sweep-m4096`: the bit-exact
  `GROUP_SIZE_M ∈ {1,2,4,8,16,32}` sweep — GM∈{1,8} regress (cons 0.958/0.975),
  GM∈{2,4} neutral/parity incl. the previously-optimal GM=4 (cons 0.980/0.996),
  GM∈{16,32} win (cons 1.010/1.012); GM=16 chosen as widest-margin.
- `approaches[2]` **abandoned** `decode-block-size-m-preservation-check`
  (companion context, per plan step 4): decode `BLOCK_SIZE_M ∈ {16,32,64,128}` at
  M=32 → BM=32 already the widest-margin win (2/2 official wins at `--repeat 10`
  ×2, min_cons 1.0411/1.0454); no decode code change.
- `bottleneck` = compute (AI 1446/2234/3072 ≫ ridge 493, MFU-limited);
  `stack` pins `sglang_commit 20fc529`, `aiter_commit 2ca7878`, `ck_commit
  b67594561`, `hip 7.0.51831`; `lesson` = the reference-rebuild config-reshift rule.

### Validation

```
python3 testbench/bin/knowledge.py add  <draft>   → installed …/20260723a.json
python3 testbench/bin/knowledge.py lint           → knowledge lint: 17 entries, 0 problems
python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X
                                                  → returns it newest-first [win geo=1.0459 minc=1.0038]
```

## Files Changed (harness repo)

One commit, one file this round:

- `1a315c6` — `knowledge: record Round-2 moe_total_prefill GROUP_SIZE_M reshift
  session` — `testbench/knowledge/entries/glm52--moe_total_prefill--mi300x--20260723a.json`
  (new, +79). `knowledge:` scope; no `.humanize/` staged; **no AI-authorship
  trailer** (verified). Tree clean after commit.

No `candidate.py`, reference, taskset, metric, cost-model, peak, timing, deploy,
or `run.sh` change. The two accepted wins (MoE prefill/decode, dsa, index_score)
are untouched.

### add-only decision (generated indices deliberately left as-is)

`knowledge.py add` installs the entry but does not regenerate the KB's generated
bookkeeping. Measured this round: `index --check` reports 3 stale and `distill
--check` reports 2 stale **before** my add — i.e. `queries/*.md` and
`distilled.{json,md}` were already stale (the first-loop entries were committed via
`add` without regenerating them), and **no gate** (`selftest.py`,
`sync_glm52_tasks.py --check`, or CI) enforces their freshness. The documented
workflow (README) is `add` → `lint`. Regenerating would fold pre-existing,
unrelated backlog churn from the other 16 entries into this diff, hurting AC-5
reviewability, so they were left untouched. The pre-existing staleness is recorded
here, not introduced by this round.

## Diff-base / review boundary

Candidate + KB delta over the accepted first-loop baseline is `3ddb2ea..HEAD`
(HEAD now `1a315c6`): the two Round-0/Round-2 candidate files
(`dsa_prefill_attn/candidate.py` `26bdb84`, `moe_total_prefill/candidate.py`
`017bfdc`) plus this round's single knowledge entry (`1a315c6`). Code-review base
branch: `kda-base/glm52-rocm-mfu-bw-20260722`.

## Note on `round-2-summary.md`

Codex's plan step 6 said to cite the installed entry in `round-2-summary.md`. The
harness `loop-edit-validator` hook (correctly) blocks editing a prior round's
frozen summary during Round 3 and directs the citation to the current round's file.
The full citation therefore lives in **this** `round-3-summary.md`; the tracker's
task10 row and Completed-and-Verified table (AC-5 row, Round 3) also cite the entry.

## BitLesson Delta

- Action: add
- Lesson ID(s): BL-20260723-dual-knowledge-base-requirement
- Notes: Added `BL-20260723-dual-knowledge-base-requirement` to
  `.humanize/bitlesson.md` because Codex's Round-2 review surfaced a gap the loop's
  BitLesson workflow alone did not catch — a completed optimization session must
  ALSO write a `testbench/knowledge` JSON entry (a separate harness recipe KB with
  its own validator), and nothing in preflight (`selftest.py`, `sync --check`, CI)
  enforces it, so the gap only appears in session review. The lesson records the
  exact `knowledge.py` schema gotchas (integer `schema_version` 1; glm52 win =
  `shapes_won>=1` & `shapes_regressed==0` + ≥1 win approach; `add` is append-only;
  add-only for the generated indices) and the `bitlesson-selector` Bedrock outage
  plus inline-selection fallback, so the next session updates BOTH KBs without
  re-discovering the requirement. This is a new entry (not an edit); no prior
  bitlesson was modified.
- Applied this round: `BL-20260723-moe-tail-shape-config-reshift` (this session's
  own lesson — the entry transcribes it into the harness KB),
  `BL-20260723-aiter-ck-submodule-module-quant-restore` (its honest-reporting rule
  shapes the entry's thin-margin caveats; supplies `ck_commit b67594561`), and
  memory `glm52-moe-decode-blocksizem-win` (the companion decode approach).
- New lesson: the repo has **two separate knowledge bases** — `.humanize/bitlesson.md`
  (loop KB) and `testbench/knowledge` (harness recipe KB) — and a completed session
  must update **both**; a bitlesson entry does not satisfy the harness KB, and
  nothing in preflight enforces it, so the gap only surfaces in session review.
  The lesson records the exact `knowledge.py` schema gotchas (integer
  `schema_version` 1; glm52 win = `shapes_won≥1` & `shapes_regressed==0` + ≥1 win
  approach; append-only; add-only for the generated indices) and the
  `bitlesson-selector` infra outage below.
- Selector note: the `bitlesson-selector` subagent failed **twice** with a Bedrock
  `context_management: Extra inputs are not permitted` ValidationException (an
  environment/API error in the subagent path, not the task). BitLesson selection
  was performed **inline** against `.humanize/bitlesson.md` and is recorded above.

## Goal Tracker Update

- **task10 (Finalize report): needs revision → completed** — the required
  `testbench/knowledge` entry is installed and lint-clean; report finalized.
- **Blocking Side Issue "Missing required Round-2 `testbench/knowledge` entry":
  RESOLVED** (Round 3).
- Plan Evolution Log: added Round-3 row; Plan Version → 4.
- Completed-and-Verified: added AC-5/AC-4 row (entry recorded, verified Round 3).
- **AC-5: satisfied** (session recorded in the harness KB per the repo guide; diff
  reviewable, one file, `.humanize/` excluded). **AC-4: honored** (every entry
  number traces to a persisted `result.json` with a candidate-hash match).

All four official tasks remain at their Round-2-verified state (decode 2/2, prefill
3/3, dsa 3/3, index_score 3/3; `shapes_regressed == 0`; calc_diff bit-exact/unchanged);
this round added no code and re-ran no gate, so none of those results changed.
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
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_23-29-53/round-2-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-2-review-result.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-1-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-1-review-result.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-0-summary.md
- @.humanize/rlcr/2026-07-22_23-29-53/round-0-review-result.md


Use this history to identify patterns across rounds: recurring issues, stalled progress, or drift from the mainline objective. Weight recent rounds more heavily but watch for systemic trends in the full commit log.

## Part 1: Implementation Review

- Your task is to conduct a deep critical review, focusing on finding implementation issues and identifying gaps between "plan-design" and actual implementation.
- Relevant top-level guidance documents, phased implementation plans, and other important documentation and implementation references are located under @docs.
- If Claude planned to defer any tasks to future phases in its summary, DO NOT follow its lead. Instead, you should force Claude to complete ALL tasks as planned.
  - Such deferred tasks are considered incomplete work and should be flagged in your review comments, requiring Claude to address them.
  - If Claude planned to defer any tasks, please explore the codebase in-depth and draft a detailed implementation plan. This plan should be included in your review comments for Claude to follow.
  - Your review should be meticulous and skeptical. Look for any discrepancies, missing features, incomplete implementations.
- If Claude does not plan to defer any tasks, but honestly admits that some tasks are still pending (not yet completed), you should also include those pending tasks in your review.
  - Your review should elaborate on those unfinished tasks, explore the codebase, and draft an implementation plan.
  - A good engineering implementation plan should be **singular, directive, and definitive**, rather than discussing multiple possible implementation options.
  - The implementation plan should be **unambiguous**, internally consistent, and coherent from beginning to end, so that **Claude can execute the work accurately and without error**.

## Part 2: Goal Alignment Check (MANDATORY)

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md and verify:

1. **Acceptance Criteria Progress**: For each AC, is progress being made? Are any ACs being ignored?
2. **Forgotten Items**: Are there tasks from the original plan that are not tracked in Active/Completed/Deferred?
3. **Deferred Items**: Are deferrals justified? Do they block any ACs?
4. **Plan Evolution**: If Claude modified the plan, is the justification valid?

Include a brief Goal Alignment Summary in your review:
```
ACs: X/Y addressed | Forgotten items: N | Unjustified deferrals: N
```

## Part 3: Required Finding Classification

You MUST classify your findings into these lanes:
- **Mainline Gaps**: plan-derived work or AC progress that is missing, incomplete, or regressing
- **Blocking Side Issues**: bugs or implementation issues that block the current mainline objective from succeeding safely
- **Queued Side Issues**: valid non-blocking follow-up issues that should be documented but must NOT take over the next round

Also include a one-line verdict:
```
Mainline Progress Verdict: ADVANCED / STALLED / REGRESSED
```

This verdict line is mandatory. If you omit it, the Humanize stop hook will block the round and require the review to be rerun.

If Claude mostly worked on queued side issues and failed to advance the mainline, say so explicitly.

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

## Part 5: Output Requirements

- In short, your review comments can include: problems/findings/blockers; claims that don't match reality; implementation plans for deferred work (to be implemented now); implementation plans for unfinished work; goal alignment issues.
- Your output should be structured so Claude can tell which items are mainline gaps, blocking side issues, and queued side issues.
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-3-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
