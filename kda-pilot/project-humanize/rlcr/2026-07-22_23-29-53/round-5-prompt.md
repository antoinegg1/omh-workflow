# Code Review Findings

You are in the **Review Phase**. Codex has performed a code review and found issues that need to be addressed.

## Required Re-anchor

Before touching code:
- Re-read the original plan at @.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md
- Re-read the goal tracker at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md
- Refresh the current round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-5-contract.md

The round contract must preserve a single mainline objective. Code review findings do NOT automatically become the new round objective.

## Review Results

## Codex Review Issues

- [P3] Read archived results when rebuilding plots — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105-105
  When this rebuild script is run from a fresh checkout of the archive, the `runs/glm52/...` directories it reads here are not part of the archived artifacts, while the matching `result.json` files are committed under `archive/0720-Best-GLM-52/lichangye/<task>/result.json`. This makes the documented rebuild command depend on the author's local run cache instead of the archive contents.
The main harness changes appear structurally consistent, but the new archive rebuild script is not self-contained and will fail outside the author's local run directory despite the needed result JSONs being archived.

Review comment:

- [P3] Read archived results when rebuilding plots — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105-105
  When this rebuild script is run from a fresh checkout of the archive, the `runs/glm52/...` directories it reads here are not part of the archived artifacts, while the matching `result.json` files are committed under `archive/0720-Best-GLM-52/lichangye/<task>/result.json`. This makes the documented rebuild command depend on the author's local run cache instead of the archive contents.

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

1. **Refresh the round contract** at `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-5-contract.md`
2. **Address blocking issues first** and keep the mainline objective stable
3. **Focus on fixes only** - do not add new features or make unrelated changes
4. **Commit your changes** after fixing the issues
5. **Write your summary** to: `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-5-summary.md`

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
