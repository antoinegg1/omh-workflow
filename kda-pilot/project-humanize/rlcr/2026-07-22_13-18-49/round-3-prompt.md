# Code Review Findings

You are in the **Review Phase**. Codex has performed a code review and found issues that need to be addressed.

## Required Re-anchor

Before touching code:
- Re-read the original plan at @.humanize/kernel-agent/refined-plan.md
- Re-read the goal tracker at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md
- Refresh the current round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-3-contract.md

The round contract must preserve a single mainline objective. Code review findings do NOT automatically become the new round objective.

## Review Results

## Codex Review Issues

- [P1] Guard ROCm-only sparse MLA path on CUDA — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:117-117
  When this task is run under the default cuda/cuda-b200 backend, this call now takes the PyTorch gather/einsum workaround for every valid input instead of the optimized `sgl_kernel.flash_mla_sparse_fwd` baseline. The optimization notes and measurements are specific to MI300X/TileLang, so on B200 this replaces the CUDA FlashMLA kernel with a much heavier PyTorch loop and will regress the default gate rather than falling back to the reference; add a platform/backend guard before taking the fast path.
The DSA candidate applies an MI300X-specific PyTorch workaround unconditionally, which breaks the default B200 behavior for that task. The other changes may be valid for the ROCm target, but this unguarded path makes the patch unsafe as a default candidate.

Review comment:

- [P1] Guard ROCm-only sparse MLA path on CUDA — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:117-117
  When this task is run under the default cuda/cuda-b200 backend, this call now takes the PyTorch gather/einsum workaround for every valid input instead of the optimized `sgl_kernel.flash_mla_sparse_fwd` baseline. The optimization notes and measurements are specific to MI300X/TileLang, so on B200 this replaces the CUDA FlashMLA kernel with a much heavier PyTorch loop and will regress the default gate rather than falling back to the reference; add a platform/backend guard before taking the fast path.

## Issue Classification

Classify each review finding before acting on it:
- **blocking side issue**: prevents the current mainline objective from succeeding safely or prevents review acceptance
- **queued side issue**: valid follow-up, but does not block the current round objective

Queued issues may be documented, but they must NOT take over the round.

## Task Rules

Every task must use one lane tag:
- `[blocking]` for review findings that must be fixed now
- `[queued]` for non-blocking follow-up work

Do not create new `[mainline]` tasks in review phase unless the review proves the previous mainline objective was incomplete.

## Instructions

1. **Refresh the round contract** at `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-3-contract.md`
2. **Address blocking issues first** and keep the mainline objective stable
3. **Focus on fixes only** - do not add new features or make unrelated changes
4. **Commit your changes** after fixing the issues
5. **Write your summary** to: `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-3-summary.md`

## Summary Template

Your summary should include:
- The mainline objective for this round
- Which blocking issues were fixed
- Which issues were reclassified as queued follow-up
- How each fixed issue was resolved
- Any issues that could not be resolved (with explanation)
- Confirmation that `goal-tracker.md` was updated if the blocking/queued issue lists changed
- A Goal Tracker Update Request only if tracker reconciliation still needs Codex help

## Important Notes

- The COMPLETE signal has no effect during the review phase
- You must address the code review findings to proceed
- After you commit and write your summary, Codex will perform another code review
- The loop continues until no `[P0-9]` issues are found

## BitLesson Selection (REQUIRED FOR EACH FIX TASK)

Before implementing each fix task, you MUST:

1. Read @/home/lichangye/kernel-harness-amd/.humanize/bitlesson.md
2. Run `bitlesson-selector` for each fix task/sub-task to select relevant lesson IDs
3. Follow the selected lesson IDs (or `NONE`) during implementation

Reference: @/home/lichangye/kernel-harness-amd/.humanize/bitlesson.md

## Task Tag Routing Reminder

Follow the plan's per-task routing tags strictly:
- `coding` task -> Claude executes directly
- `analyze` task -> execute via `/humanize:ask-codex`, then integrate the result
- Keep Goal Tracker Active Tasks columns `Tag` and `Owner` aligned with execution
