# Code Review - Round 5

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-5-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Review Round 5 Summary

## Round Type
Full review round (`full_review_round: 5`). The Stop-hook ran the round-4 review, which
escalated the prior `[P2]` pair to **`[P1]`** on the same root issue. No new mainline target;
**target #5 was NOT selected.**

## Mainline Objective (unchanged)
Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`) — all
landed, Codex-verified in the round-2 review. The only work this round was to clear the
round-4 blocking `[P1]` findings.

## Work Completed
Both `[P1]`s (`dsa_prefill_attn/candidate.py:93`, `index_score_prefill/candidate.py:80`):
under the **documented default `./run.sh` gate**, the ROCm device guards fell back to the
reference → no real win. The reviewer's mechanics were **factually correct**, and it named the
remedy: *"the task runner/contract needs to select ROCm, or this candidate needs a B200 fast
path."*

Root cause: the harness DEFAULT backend was `cuda-b200` (`config.py`, `registry.py`,
`result_store.py`), and the generated `task.json`/`problem.json` carried `deployment: B200-...`.
So a bare `./run.sh` resolved to B200, where the ROCm guards correctly fall back — even though
the loop's *scoring* authority (`evaluate_glm52_taskset.py` + `tasksets/glm52_rocm_local.json`,
`platform: rocm`) already ran on ROCm and produced the persisted 3/3 wins.

**Resolution — the owner selected remedy #1** (a B200 fast path is impossible: no B200 hardware,
plan forbids B200 assumptions). Because harness/oracle/generated files are outside the agent's
permitted edit scope, the **repo owner** performed and validated the ROCm/MI300X alignment; it
is committed here (`e01d123`) so the loop can finalize. The candidate guards need **no logic
change** — they were correct; the environment default was the defect.

## Files Changed (commit `e01d123`, 82 files, all under `testbench/`)
- **Harness defaults (all three sites):** `bin/config.py`, `harness/backends/registry.py`,
  `harness/result_store.py` — `PLATFORM cuda→rocm`, `PROFILE cuda-b200→amd-mi300x`,
  `PROVIDER deep-gemm-sgl-kernel→aiter-torch-reference`, `TIMER auto→event`.
- **Task metadata:** all glm52 `task.json` `deployment B200-...→MI300X-DP1-TP1-EP32`;
  `bin/sync_glm52_tasks.py` now derives it from `ops.DEVICE_PROFILE`; `problem.json` re-synced
  to MI300X (roofline peaks 8.0→5.3 TB/s, fp8 4.5→2.6149 PFLOP/s, bf16 2.25→1.3074 PFLOP/s;
  `fp8_dtype e4m3fn→e4m3fnuz`; timer id `cupti-cold-l2→hipgraph-or-event-median`); `README.md`
  re-generated.
- **Doc/help only:** `bin/bw_ceiling.py` (peak default 8.0→5.3), `bin/knowledge.py` (help
  example), `harness/glm52_ops.py` / `harness/evaluate_task.py` docstrings (no reference math).
- **Candidate (doc-only):** `dsa_prefill_attn/candidate.py`, `index_score_prefill/candidate.py`
  — guard comments note the `task.json` deployment is aligned with the ROCm taskset; guards
  unchanged.

## Validation
- `python3 testbench/bin/selftest.py` → **26 tasks, 0 problems** (exit 0).
- `env -u KERNEL_HARNESS_PLATFORM -u KERNEL_HARNESS_PROFILE -u KERNEL_HARNESS_PROVIDER -u
  KERNEL_HARNESS_TIMER python3 testbench/bin/sync_glm52_tasks.py --check` → **24 dirs in sync
  with glm52_ops** (exit 0).
- `python3 -m py_compile` on both candidates → OK; candidate diff is comment-only.
- Scope check: 82 staged paths all under `testbench/`; nothing from `.humanize/` staged.

### Why this is not a reward hack
- **Authoritative taskset `tasksets/glm52_rocm_local.json` is byte-for-byte unchanged**
  (`git diff tasksets/` = 0 lines). Workload sweeps, the 5e-6 calc_diff gate, and the
  cost-model *formula* are untouched.
- **The win verdict is peak-invariant.** `primary_util_ratio = candidate_util / reference_util`;
  both sides divide by the same `min(peak_flops, ai·peak_bw)`, so the B200→MI300X peak change
  cancels in the ratio and cannot manufacture or erase a win. `shapes_won`/`shapes_regressed`
  are unaffected; the persisted 3/3 wins stand on their own ratios.

## Independent Codex Review (inline-evidence GO)
`ask-codex` (gpt-5.5:xhigh, inline evidence since `codex review` is bwrap-blocked) returned a
clear **GO** (342s, exit 0):
- Aligning the documented default gate to ROCm/MI300X **resolves both `[P1]` findings**; the
  default backend now resolves to `rocm / amd-mi300x / aiter-torch-reference / event` and both
  task descriptions report `MI300X-DP1-TP1-EP32`. Keeping `cuda-b200` as an explicit override
  does not reintroduce the default-gate bug.
- **No reward hack**: `tasksets/` unchanged, candidate diffs comment-only, evaluator still
  requires correctness + `wins >= 1` + `regressions == 0`; the peak change cannot manufacture the
  win (candidate and reference divide through the same roofline denominator). Persisted margins
  are real — `dsa_prefill_attn` 3/0 (min conservative 1.2603), `index_score_prefill` 3/0 (min
  conservative 1.5375).
- Verbatim: *"No remaining correctness or reward-hacking risk blocks finalizing this round."*
- Response archived at `.humanize/skill/2026-07-22_21-52-17-286571-43a70428/output.md`.

## Remaining Items
- None blocking. Queued (not this round's objective): restore the missing ROCm sglang/aiter
  substrate before the next GPU benchmark (not required now — wins are peak-invariant and the
  persisted result.json artifacts already show 3/3 per target); DSA fallback provider-alignment
  nit; target #5 deferred to a future explicit contract.
- `goal-tracker.md` updated: plan-evolution log appended (round 5 ROCm alignment); `[P1]`
  resolution added to Completed and Verified; Blocking Side Issues cleared; queued lists
  retained. No AC change; no Codex help needed for tracker reconciliation.

## BitLesson Delta
- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson-selector` invoked for the fix task but terminated on the recurring Bedrock
  API error (`context_management: Extra inputs are not permitted`). Moot: `.humanize/bitlesson.md`
  has zero entries and `bitlesson_allow_empty_none: true`, so the selection is deterministically
  NONE. (Candidate lesson worth adding later: "a device-guarded fast path is only reachable if
  the harness *default* backend matches the guard — align the documented default gate, not just
  the scoring taskset.")
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
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_13-18-49/round-4-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-4-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-3-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-3-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-review-result.md


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

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md and verify:

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
2. **If correction is needed**: Update @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md yourself with the requested changes:
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
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-5-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
