# Code Review - Round 2

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-2-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Round 2 Summary

**Outcome: COMPLETE — MoE accepted-win preservation is restored.** The single
mainline blocker from the Round-1 review (decode M=32 and prefill M=4096 had
softened from accepted wins to `neutral` under the runnable pinned-CK reference)
is resolved using only candidate-local, bit-exact scheduling levers. Both MoE
tasks return to their full accepted-win profiles (decode 2/2, prefill 3/3), every
official shape stays correct with `calc_diff == 0` and `shapes_regressed == 0`,
and the two headline tasks (dsa ~2.12, index_score ~2.84) are re-confirmed unlost.
The reference was **not** touched, degraded, or loosened; correctness gates are
unchanged; the only harness-repo change is one branch of one MoE candidate.

---

## Mainline Objective — MoE tail-shape win recovery: RESOLVED

Two softened tail shapes, two distinct root causes, both fixed within the
bit-exact scheduling-lever budget (leave `BLOCK_SIZE_K` untouched → numerics
identical → `calc_diff == 0`).

### prefill M=4096 — real config re-shift → `GROUP_SIZE_M = 4 → 16`

Under the faster restored reference, the previously-optimal `GROUP_SIZE_M = 4`
became reference-parity (`neutral`). A bit-exact `GROUP_SIZE_M` sweep at M=4096
(scratch candidate, `--repeat 3` probe, then `--repeat 10` gate) shows the optimum
shifted upward:

| GROUP_SIZE_M | verdict (r3) | ratio | cons | calc_diff |
|---|---|---|---|---|
| 1  | REGRESS | 0.9609 | 0.9582 | 0.0 |
| 2  | neutral | 1.0015 | 0.9799 | 0.0 |
| 4 (old pick) | neutral | 1.0021 | 0.9961 | 0.0 |
| 8  | REGRESS | 0.9863 | 0.9745 | 0.0 |
| **16 (new pick)** | **WIN** | **1.0265** | **1.0103** | **0.0** |
| 32 | WIN | 1.0155 | 1.0115 | 0.0 |

GM=16 gated at `--repeat 10` twice: `win` / cons **1.0108**, **1.0105**,
calc_diff 0.0. Fix = `_pick_group_size_m` returns 16 for `M >= 4096`; `M <= 1024`
(GM=1) and `M = 2048` (GM=4) are unchanged. Committed `017bfdc`.

### decode M=32 — run-to-run noise, not a real regression → NO code change

`BLOCK_SIZE_M` sweep at M=32 (`--repeat 3`) shows the current pick (BM=32) is
already the widest-margin config:

| BLOCK_SIZE_M | verdict | ratio | cons |
|---|---|---|---|
| 16 | neutral | 1.0029 | 0.9960 |
| **32 (current pick)** | **WIN** | **1.0495** | **1.0370** |
| 64 | WIN | 1.0491 | 1.0269 |
| 128 | WIN | 1.0456 | 1.0335 |

The candidate already selects BM=32 at M=32 (`_pick_block_size_m(32)=32`). The
Round-1 `neutral` (cons 0.9938) was timing noise on a thin margin. Re-gating the
**unchanged** candidate on the full official `[16, 32]` sweep at `--repeat 10`
**twice** returns 2/2 wins both times — no code change is warranted or made.

---

## Consolidated Four-Task Official Check (same session, `AITER_TRITON_ONLY=0`)

Gate-quality `--repeat 10 --iterations 30 --warmup 3`, pinned-CK reference
(aiter HEAD `2ca7878e2` + CK `b67594561` + `module_quant.so`).
Persisted: `/opt/devmachine/lichangye/tmp/kda_round2_*_official_r10*.json`.

| Task | wins | shapes_regressed | geomean ratio | min_cons | worst calc_diff | vs accepted baseline |
|------|------|------------------|---------------|----------|-----------------|----------------------|
| `moe_total_decode`    | **2/2** | 0 | ~1.056 | ~1.045 | 0.0 | wins RESTORED (R1 was 1/2) |
| `moe_total_prefill`   | **3/3** | 0 | ~1.05  | ~1.005 | 0.0 | wins RESTORED (R1 was 2/3) |
| `dsa_prefill_attn`    | **3/3** | 0 | 2.1213 | 2.0691 | 2.884e-6 | HELD (baseline 1.3044→~2.12) |
| `index_score_prefill` | **3/3** | 0 | 2.8416 | 1.5321 | 0.0 | HELD (baseline 2.8371/1.5375) |

Every official task: 0 incorrect, 0 regressions, calc_diff within gate on every
shape, no accepted win lost.

### Per-shape detail (gate runs)

`moe_total_decode` (unchanged candidate, `--repeat 10` ×2, official `[16,32]`):
- run1: 2/2 win, min_cons 1.0411 — per-shape cons 1.0411 / 1.0480, calc_diff 0.0
- run2: 2/2 win, min_cons 1.0454 — per-shape cons 1.0475 / 1.0454, calc_diff 0.0

`moe_total_prefill` (edited candidate, `--repeat 10` ×2, official `[1024,2048,4096]`):
- run1: 3/3 win, min_cons 1.0058 — per-shape cons 1.0807 / 1.0420 / 1.0058, calc_diff 0.0
- run2: 3/3 win, min_cons 1.0038 — per-shape cons 1.0792 / 1.0242 / 1.0038, calc_diff 0.0

`dsa_prefill_attn` (unchanged, `--repeat 10`): 3/3 win, per-shape cons 2.0691 /
2.1111 / 2.1184, MFU ~0.0555, calc_diff 2.884e-6 (unchanged from baseline).

`index_score_prefill` (unchanged, `--repeat 10`): 3/3 win, per-shape cons 1.5321 /
3.8987 / 3.7411, calc_diff 0.0.

### Honest margin note (why this is a genuine win, not a hack)

The recovered MoE margins are thinner than the *stale* baseline JSON numbers
(decode min_cons ~1.045 vs 1.0518; prefill ~1.005 vs 1.0263). That gap is
reference-attributable — the freshly-built pinned-CK reference is faster on the
tail shapes than whatever produced the stale baseline — and is the ceiling of the
bit-exact config space (the full `GROUP_SIZE_M` / `BLOCK_SIZE_M` sweeps were run;
`BLOCK_SIZE_K` is off-limits for correctness). The AC-2 requirement is that
**accepted wins are not lost** — i.e. every official shape's `shape_verdict == win`
— and that now holds on all four tasks (2/2, 3/3, 3/3, 3/3), robust across
duplicate `--repeat 10` gates, with `calc_diff == 0` (MoE) / unchanged (dsa).

---

## Files Changed (harness repo)

One file, one commit this round:

- `017bfdc` — `moe_total_prefill: raise M=4096 GROUP_SIZE_M to 16 to restore
  accepted win` — `testbench/tasks/glm52/moe_total_prefill/candidate.py`
  (`_pick_group_size_m` M≥4096 branch + docstring; +17 / -8).

Repo is git-clean after commit. `moe_total_decode` candidate is untouched (its
2/2 wins were confirmed robust, no change needed). `.humanize/`, traces, caches,
and scratch logs are excluded from the reviewable diff (AC-5). Scratch sweep
candidates were kept outside the task dirs (`/opt/devmachine/lichangye/tmp/
kda_scratch/{decode,prefill}_sweep.py`) and are not committed.

## Review-Boundary / Diff-Base (Codex queued correction — APPLIED)

The candidate-local Round-2 boundary is **`3ddb2ea..HEAD`** (equivalently
`fork/codex/amd-glm52-rocm-evalbench-v2..HEAD`; `fork/codex/...` resolves to
`3ddb2ea`). Verified contents = exactly **two candidate files**:
`dsa_prefill_attn/candidate.py` (commit `26bdb84`, Round 0) and
`moe_total_prefill/candidate.py` (commit `017bfdc`, Round 2). The earlier
`5efb3cf..HEAD` framing was wrong (it pulled in `archive/**` snapshots); it is
superseded here. Code-review base branch: `kda-base/glm52-rocm-mfu-bw-20260722`
(present locally; merge-base `f60a6976`).

## AITER_TRITON_ONLY provenance + run.sh python-selection note

Every gate run this round used **`AITER_TRITON_ONLY=0`** (required, or the sglang
TileLang / fp8 MoE references silently degrade), aiter HEAD `2ca7878e2`, CK
`b67594561`, `module_quant.so` present. The result-JSON schema does not record
`AITER_TRITON_ONLY`; documented here rather than by changing the harness output
(out of authority).

Operational finding (recorded, not "fixed" — task `run.sh` is frozen authority):
only the **MoE** `run.sh` prefers `${ROCM_TORCH_VENV}/bin/python`; the
**dsa/index_score** `run.sh` still fall back to `/opt/conda/bin/python3`
(CPU-only, no ROCm torch) because their python-selection predates
`ROCM_TORCH_VENV` support → they return `rc3` ("GPU runtime required"). Their
authoritative gate was therefore run as
`$ROCM_TORCH_VENV/bin/python testbench/harness/evaluate_task.py <task_dir>
--repeat 10 --iterations 30 --warmup 3` — byte-identical to what the MoE `run.sh`
execs internally, same driver/args/python.

## BitLesson Delta

- Action: add
- Lesson ID(s): BL-20260723-moe-tail-shape-config-reshift
- Applied this round: BL-20260723-aiter-ck-submodule-module-quant-restore (its
  "Constraints" note predicted the softened-margin outcome this round resolves)
  and memory `glm52-moe-decode-blocksizem-win` (BLOCK_SIZE_M is the decode lever).
- Notes: New reusable lesson — after a reference is rebuilt/restored, a bit-exact
  "faster launch config" MoE candidate can lose a tail-shape win because the
  optimal config **shifts** (prefill M=4096 `GROUP_SIZE_M` 4→16) OR because the
  thin margin **flickers** win↔neutral under timing noise (decode M=32, already
  optimal at BM=32). Fix = re-sweep the bit-exact lever for the softened shape via
  a scratch candidate, gate at `--repeat 10` twice, commit only the candidate-local
  mapping; never touch `BLOCK_SIZE_K`. Includes the dsa/index_score `run.sh`
  ROCm-python gotcha.

## Goal Tracker Update Request

- **task9 (Final official-task check): blocked → completed.** Four-task check runs
  end-to-end; all four CORRECT, `shapes_regressed == 0`, and every accepted win
  preserved (decode 2/2, prefill 3/3, dsa 3/3, index_score 3/3).
- **task10 (Finalize report): needs revision → completed** via this file (diff-base
  corrected to `3ddb2ea..HEAD`; AITER_TRITON_ONLY provenance recorded).
- **task14 (decode M32 recovery): completed** — confirmed no code change needed;
  BM=32 already optimal, 2/2 robust at `--repeat 10` ×2 (R1 neutral was noise).
- **task15 (prefill M4096 recovery): completed** — `GROUP_SIZE_M = 16` at M≥4096,
  3/3 wins restored, commit `017bfdc`.
- **Blocking Side Issue "MoE accepted-win preservation not yet restored": RESOLVED.**
- **AC-2: satisfied** (no accepted win lost; all official shapes correct,
  `shapes_regressed == 0`, calc_diff 0 on MoE / unchanged on dsa).
  **AC-3: advanced** (both MoE tails moved neutral→win; margins are at the bit-exact
  ceiling under the restored reference, thinner than the stale baseline JSON —
  reference-attributable, disclosed above).
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
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
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
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-2-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
