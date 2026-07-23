# Code Review Findings

You are in the **Review Phase**. Codex has performed a code review and found issues that need to be addressed.

## Required Re-anchor

Before touching code:
- Re-read the original plan at @.humanize/kernel-agent/refined-plan.md
- Re-read the goal tracker at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md
- Refresh the current round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-6-contract.md

The round contract must preserve a single mainline objective. Code review findings do NOT automatically become the new round objective.

## Review Results

## Codex Review Issues

- [P1] Avoid defaulting to ROCm before candidates are ported — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-48
  With no `KERNEL_HARNESS_*` overrides, this now selects ROCm/MI300X for every task, but most task-local `candidate.py` files were not changed and still import/launch CUDA DeepGEMM (for example `q_b_prefill` uses `deep_gemm.fp8_gemm_nt`). On a ROCm-only runner `./run.sh` for those tasks fails during candidate import instead of providing the reference-like baseline, so either keep CUDA as the default until the candidates are ported or regenerate the default candidates to call the selected backend reference.

- [P1] Use the harness reference for the ROCm fallback — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:72-73
  When the fast path is skipped (for example gluon active, non-gfx942, or a changed heuristic), this fallback calls DeepGEMM rather than the selected ROCm oracle (`glm52_ops.reference`/AITER). On MI300X installations without DeepGEMM the module already fails at import, and even with DeepGEMM installed the fallback no longer matches the backend described in `problem.json`, so this should fall back through the harness reference instead.
The patch switches the default harness to ROCm while leaving many default candidates tied to CUDA DeepGEMM, and one new ROCm candidate still falls back through DeepGEMM instead of the harness reference. These issues can break normal task runs on the intended MI300X backend.

Full review comments:

- [P1] Avoid defaulting to ROCm before candidates are ported — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-48
  With no `KERNEL_HARNESS_*` overrides, this now selects ROCm/MI300X for every task, but most task-local `candidate.py` files were not changed and still import/launch CUDA DeepGEMM (for example `q_b_prefill` uses `deep_gemm.fp8_gemm_nt`). On a ROCm-only runner `./run.sh` for those tasks fails during candidate import instead of providing the reference-like baseline, so either keep CUDA as the default until the candidates are ported or regenerate the default candidates to call the selected backend reference.

- [P1] Use the harness reference for the ROCm fallback — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:72-73
  When the fast path is skipped (for example gluon active, non-gfx942, or a changed heuristic), this fallback calls DeepGEMM rather than the selected ROCm oracle (`glm52_ops.reference`/AITER). On MI300X installations without DeepGEMM the module already fails at import, and even with DeepGEMM installed the fallback no longer matches the backend described in `problem.json`, so this should fall back through the harness reference instead.

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

1. **Refresh the round contract** at `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-6-contract.md`
2. **Address blocking issues first** and keep the mainline objective stable
3. **Focus on fixes only** - do not add new features or make unrelated changes
4. **Commit your changes** after fixing the issues
5. **Write your summary** to: `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-6-summary.md`

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
