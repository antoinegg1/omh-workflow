# Code Review - Round 0

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-0-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Round 0 Summary

## What Was Implemented

Target: `moe_total_decode` (GLM-5.2 fused MoE, decode phase, AMD MI300X / ROCm gfx942,
fp8_e4m3 w8a8). Metric: `roofline_mfu_bw` (primary_util = HBM bandwidth utilization).

A **correctness-preserving Triton launch-config optimization**. The reference is sglang's
Triton `fused_moe(..., use_fp8_w8a8=True)`. I first proved (by monkeypatch-capturing the
reference's own internal tensors) that no *reimplementation* of the fp8 MoE can pass the
gate: the intermediate activation saturates hard in fp8 (act amax ~76288 vs FP8_MAX 224,
~45% of values clamp at ±224), so even feeding the reference's EXACT `intermediate_cache2`
into an independent a2-quant+gemm2 yields calc_diff 3.15e-2 — ~3000× over the 5e-6 gate.
Bit-exact reproduction of the reference Triton kernels is mandatory.

The dense-degenerate decode routing (top_k==num_experts==8, topk_ids==arange(8): every
token → every expert) lets us keep the reference's *own* kernels but cut wasted work:
the reference uses BLOCK_SIZE_M=128 (or 64), yet at decode M≤64 each expert owns only M
rows, so `moe_align_block_size` pads each expert block up to BLOCK_SIZE_M (up to ~8×
padded-row work in both fp8 GEMMs). The candidate reuses the reference's resolved config
(`try_get_optimal_moe_config`), overrides **only** BLOCK_SIZE_M (both gemm1 and down
configs) to `clamp(next_pow2(M),16,128)`, recomputes `moe_align_block_size`, and calls
sglang's own `_fused_moe_kernel_sequence`. BLOCK_SIZE_M changes only the tile grid, not
the per-output-element fp32 K-accumulation order (BLOCK_SIZE_K untouched) → bit-exact
(measured calc_diff == 0.0 for M in {1,4,8,16,32,64}). `run()` falls back to the untouched
reference on any surprise, and deliberately for M>32 (shrinking there measured a 0.7% loss).

## Files Changed

- `testbench/tasks/glm52/moe_total_decode/candidate.py` (modified) — the sanctioned
  candidate file, only file changed. No oracle / harness / reference / taskset files touched.

## Validation

Official evaluator `evaluate_glm52_taskset.py --task moe_total_decode` (metric
`roofline_mfu_bw`); ratio = candidate/reference primary_util (BW utilization):

| M  | status              | ratio  | conservative | correct | bw_util |
|----|---------------------|--------|--------------|---------|---------|
| 1  | passed              | 1.0683 | 1.0581       | True    | 0.4928  |
| 4  | passed              | 1.0700 | 1.0544       | True    | 0.4877  |
| 8  | passed              | 1.0757 | 1.0659       | True    | 0.4845  |
| 16 | passed              | 1.0757 | 1.0568       | True    | 0.3462  |
| 32 | passed              | 1.0566 | 1.0428       | True    | 0.3308  |
| 64 | correct_not_faster  | ~1.0   | (ref fallback)| True   | 0.2895  |

Summary: **passed=5, correct_not_faster=1, incorrect=0, infra_failed=0** — all 6 shapes
correct, 5 wins, 0 regressions. Satisfies "≥1 win, 0 regress, 0 incorrect".

Codex review (gpt-5.5:xhigh): **GO**, no required changes. Confirmed legitimate optimization
(not a reward hack — reuses reference kernels, no input rebuild/re-quant, no tolerance
change, no oracle edits), correctness-durable (BLOCK_SIZE_K untouched; GROUP_SIZE_M is
scheduling-only; down_moe_use_tma=False fine for this target), and the broad try/except
cannot mask a wrong fast-path result (numerically-wrong output raises no exception and is
caught by the evaluator). Non-blocking polish suggested: a narrower exception / debug log.

## Remaining Items

- (Optional, future round) M=64 sits at the reference efficiency frontier for this config
  family (~1.0×); a different lever (e.g. a fused dense-path kernel) would be needed to win it.
- (Optional polish, non-blocking) narrow the fallback exception / add a skip-reason debug log.

## BitLesson Delta

Action: none
Lesson ID(s): NONE
Notes: No new BitLesson promoted this round. The round reinforced two existing project facts
(saved to memory): fp8-saturation makes calc_diff≤5e-6 require bit-exact kernel reproduction,
and the only correctness-preserving decode speedup is shrinking Triton BLOCK_SIZE_M to remove
dense-decode block padding.
<!-- CLAUDE's WORK SUMMARY  END  -->
---

## Development History (Integral Context)

Accumulated commits since loop start (oldest first):
```
7dc4959 moe_total_decode: shrink Triton BLOCK_SIZE_M for dense decode (bit-exact ~1.06-1.08x)
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
(first round, no prior history)

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
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-0-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
