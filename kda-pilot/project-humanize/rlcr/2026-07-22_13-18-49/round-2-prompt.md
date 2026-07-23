Your work is not finished. Read and execute the below with ultrathink.

## Drift Recovery Mode

Codex judged the recent implementation rounds as failing to advance the mainline.

- Consecutive stalled/regressed rounds: 2
- Last mainline verdict: stalled

This round is a **drift recovery round**. Do not continue with normal issue-clearing behavior.

## Original Implementation Plan

**IMPORTANT**: Re-anchor on the original plan first:
@.humanize/kernel-agent/refined-plan.md

## Required Recovery Re-anchor

Before changing code:
- Re-read @.humanize/kernel-agent/refined-plan.md
- Re-read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md
- Re-read the recent round summaries and review results that led here
- Rewrite the round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-2-contract.md

Your recovery contract must contain:
- Exactly one recovered **mainline objective**
- The 1-2 target ACs that prove mainline progress this round
- The root cause of recent drift or stagnation
- Which issues are truly **blocking** the recovered mainline objective
- Which issues remain **queued** and explicitly out of scope
- Concrete success criteria that would change the verdict back to `ADVANCED`

Do not start implementation until the recovery contract exists.

## Task Lane Rules

Use the Task system (TaskCreate, TaskUpdate, TaskList) with one required tag per task:
- `[mainline]` for plan-derived work that directly advances the recovered objective
- `[blocking]` for issues that prevent the recovered mainline objective from succeeding safely
- `[queued]` for non-blocking bugs, cleanup, or follow-up work

Rules:
- This round must prove mainline movement, not just reduce noise
- `[blocking]` work is allowed only when it directly unblocks the recovered mainline objective
- `[queued]` work must stay documented but must NOT replace the recovered objective
- If a new issue does not block the recovered objective, tag it `[queued]` and keep moving on mainline work

---
Below is Codex's review result:
<!-- CODEX's REVIEW RESULT START -->
I could not complete the required review because the review environment cannot read or write local files. Every shell command failed before execution with:

```text
bwrap: Failed to make / slave: Permission denied
```

`apply_patch` also failed with the same sandbox helper error, so I could not write `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-1-review-result.md` or update `goal-tracker.md`.

**Mainline Progress Verdict: STALLED**

**Mainline Gaps**
- Mandatory plan-first review was not possible. I could not read `.humanize/kernel-agent/refined-plan.md`.
- I could not inspect `round-1-prompt.md`, round history, `candidate.py`, git commits, evaluator artifacts, or the tracker.
- Claude’s claimed completion is therefore unverified, not approved.

**Blocking Side Issues**
- The review-side filesystem sandbox is broken: `bwrap: Failed to make / slave: Permission denied`.
- This blocks independent code review, result verification, and safe goal-tracker maintenance.

**Queued Side Issues**
- Re-run round-1 review after fixing the sandbox.
- Re-run or complete round-0 review as well, since the supplied history says it was also infra-blocked.

**Goal Alignment Summary**
```text
ACs: unknown/unknown addressed | Forgotten items: unknown | Unjustified deferrals: unknown
```

No tracker changes were applied. Claude’s requested tracker updates are not rejected on substance; they are unverified and unsafe to apply without file access.
<!-- CODEX's REVIEW RESULT  END  -->
---

## Goal Tracker Reference

Before starting work, **read and update** @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md as needed:
- Keep the immutable section unchanged
- Record the drift/stagnation cause in the mutable section if it changed planning
- Keep blocking vs queued issue classification accurate
- Ensure the tracker and contract now describe the same recovered mainline objective

## Recovery Guardrails

- Do not spend this round mostly on queued cleanup
- Do not broaden scope to compensate for previous stalls
- If the original approach was flawed, log the plan evolution explicitly instead of silently changing direction
- If you cannot produce a credible recovered mainline objective, say so in the summary with concrete blockers

## BitLesson Selection (REQUIRED FOR EACH TASK)

Before executing each task or sub-task, you MUST:

1. Read @/home/lichangye/kernel-harness-amd/.humanize/bitlesson.md
2. Run `bitlesson-selector` for each task/sub-task to select relevant lesson IDs
3. Follow the selected lesson IDs (or `NONE`) during implementation

Reference: @/home/lichangye/kernel-harness-amd/.humanize/bitlesson.md

---

Note: You MUST NOT try to exit by lying, editing loop state files, or executing `cancel-rlcr-loop`.

After completing the work, please:
0. If the `code-simplifier` plugin is installed, use it to review and optimize your code. Invoke via: `/code-simplifier`, `@agent-code-simplifier`, or `@code-simplifier:code-simplifier (agent)`
1. Commit your changes with a descriptive commit message
2. Write your work summary into @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-2-summary.md

## Task Tag Routing Reminder

Follow the plan's per-task routing tags strictly:
- `coding` task -> Claude executes directly
- `analyze` task -> execute via `/humanize:ask-codex`, then integrate the result
- Keep Goal Tracker Active Tasks columns `Tag` and `Owner` aligned with execution

**Optional fallback**: if you could not safely update the mutable section of `goal-tracker.md` directly, include this section in your summary:
```markdown
## Goal Tracker Update Request

### Requested Changes:
- [E.g., "Mark Task X as completed with evidence: tests pass"]
- [E.g., "Add to Blocking Side Issues: bug Y blocks AC-2"]
- [E.g., "Add to Queued Side Issues: cleanup Z is non-blocking"]
- [E.g., "Plan Evolution: changed approach from A to B because..."]
- [E.g., "Defer Task Z because... (impact on AC: none/minimal)"]

### Justification:
[Explain why these changes are needed and how they serve the Ultimate Goal]
```

Codex will review your request and reconcile the Goal Tracker if justified.
