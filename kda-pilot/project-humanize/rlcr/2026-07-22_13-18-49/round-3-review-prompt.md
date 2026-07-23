# Code Review - Round 3

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-3-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Review Round 3 Summary

## Round Type
Review-phase round. The fixed Stop-hook advanced the counter to round 3 and ran the round-2
code review, which returned exactly one `[P1]` finding. No new mainline target was selected;
**target #5 was NOT selected.**

## Mainline Objective (unchanged)
Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`) — all
landed and Codex-verified in the round-2 review. The only work this round was to clear the
round-2 code-review blocking finding. Mainline objective stayed stable; no features, no new
targets.

## Work Completed
Fixed the single `[P1]` (blocking) code-review finding: the DSA fast path was unguarded on
non-ROCm platforms.

- **Finding** (`testbench/tasks/glm52/dsa_prefill_attn/candidate.py:66`): `_fast_sparse_mla_prefill`
  took the PyTorch fp32-QK sparse-MLA reimplementation for every valid input regardless of
  platform. Under the default `cuda/cuda-b200` backend the reference `flash_mla_sparse_fwd` is
  the fast CUDA FlashMLA kernel, so the unconditional PyTorch path would replace it with a much
  heavier gather/einsum loop and regress the default gate rather than fall back — an
  "unsafe fallback" (the class the plan's task4 review gate guards against, refined-plan line 187).
- **Fix:** added a platform guard at the top of the fast path:
  `if torch.version.hip is None: raise RuntimeError("non-ROCm platform; use reference ...")`.
  The raise is caught by `run()`'s existing `try/except`, which returns the reference kernel, so
  the fast path engages only on ROCm/HIP (where the reference dispatches to the slow TileLang
  kernel because CUDA `sparse_prefill_fwd` is not compiled).

## Files Changed
- `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` — +9 lines (guard + comment only; no
  change to the ROCm fast-path math or the fallback). Commit `4597e91`.

## Validation
- `python3 -m py_compile testbench/tasks/glm52/dsa_prefill_attn/candidate.py` → OK.
- Guard predicate on this shell's CUDA torch (`2.9.1+cu128`, `torch.version.hip=None` — a
  faithful B200 stand-in): evaluates `True` → fast path skipped → reference (fast CUDA FlashMLA)
  used. This is the desired B200 behavior the finding asked for.
- On the ROCm MI300X box `torch.version.hip == "7.0.51831"` → guard `False` → fast path taken,
  unchanged. The fix is therefore a proven no-op on ROCm: the already-verified persisted result
  `runs/glm52/dsa_prefill_attn/20260722T083802Z-1b233d/result.json` (3/3 shapes won, worst
  calc_diff 2.884e-6 ≤ 5e-6, 0 regress) still holds.
- GPU re-benchmark not run: the ROCm sglang/aiter substrate under `/opt/devmachine/lichangye`
  is currently missing (queued side issue). Not required for correctness because the ROCm branch
  is unchanged by this guard.

## Remaining Items
- None blocking. No `[P0-9]` issues remain from this review.
- Queued (not this round's objective): DSA fallback provider-alignment nit (direct
  `flash_mla_sparse_fwd` call still returns the reference); restore missing ROCm substrate before
  next benchmark round; target #5 selection deferred to a future explicit contract.

## Goal Tracker Update
`goal-tracker.md` updated: `[P1]` fix added to Completed and Verified (this round), Blocking Side
Issues list left empty (no open blockers), queued lists retained, plan-evolution log appended.
No AC change. No Codex help needed for tracker reconciliation.

## BitLesson Delta
- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson-selector` was run for the fix task; the project BitLesson KB has zero entries
  and `bitlesson_allow_empty_none: true`, so the selection is NONE. (A candidate lesson —
  "platform-guard reference-dispatch-dependent fast paths so they fall back where the reference
  is already the fast kernel" — is worth adding later, but adding KB entries is out of scope for
  this fix-only review round.)
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
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-0-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-0-review-result.md


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
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-3-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
