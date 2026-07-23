# Code Review Findings

You are in the **Review Phase**. Codex has performed a code review and found issues that need to be addressed.

## Required Re-anchor

Before touching code:
- Re-read the original plan at @.humanize/kernel-agent/refined-plan.md
- Re-read the goal tracker at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md
- Refresh the current round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-4-contract.md

The round contract must preserve a single mainline objective. Code review findings do NOT automatically become the new round objective.

## Review Results

## Codex Review Issues

- [P2] Avoid disabling the fast path on the B200 task — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:84-85
  For the committed `dsa_prefill_attn` problem/default backend this task is still CUDA/B200, so this guard always raises and `run()` falls back to the original `flash_mla_sparse_fwd` reference. Since the gate requires at least one shape to beat the reference, this candidate cannot pass on the documented task unless the optimization is made applicable to B200 or the task/backend metadata is changed consistently.

- [P2] Do not gate the prefill score fast path to gfx942 — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:85-87
  The committed `index_score_prefill` task is still the CUDA/B200 problem, but this fast path only accepts gfx942/AITER; on B200 it raises here (or earlier on the AITER import) and `run()` returns the unchanged `deep_gemm.fp8_mqa_logits` reference. That leaves every B200 shape neutral, so the performance gate cannot be satisfied for the documented task.
Two modified candidates are ROCm/MI300X-only while their committed tasks remain B200/CUDA, so those fast paths are unreachable under the documented gate and fall back to the reference.

Full review comments:

- [P2] Avoid disabling the fast path on the B200 task — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:84-85
  For the committed `dsa_prefill_attn` problem/default backend this task is still CUDA/B200, so this guard always raises and `run()` falls back to the original `flash_mla_sparse_fwd` reference. Since the gate requires at least one shape to beat the reference, this candidate cannot pass on the documented task unless the optimization is made applicable to B200 or the task/backend metadata is changed consistently.

- [P2] Do not gate the prefill score fast path to gfx942 — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:85-87
  The committed `index_score_prefill` task is still the CUDA/B200 problem, but this fast path only accepts gfx942/AITER; on B200 it raises here (or earlier on the AITER import) and `run()` returns the unchanged `deep_gemm.fp8_mqa_logits` reference. That leaves every B200 shape neutral, so the performance gate cannot be satisfied for the documented task.

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

1. **Refresh the round contract** at `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-4-contract.md`
2. **Address blocking issues first** and keep the mainline objective stable
3. **Focus on fixes only** - do not add new features or make unrelated changes
4. **Commit your changes** after fixing the issues
5. **Write your summary** to: `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-4-summary.md`

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
