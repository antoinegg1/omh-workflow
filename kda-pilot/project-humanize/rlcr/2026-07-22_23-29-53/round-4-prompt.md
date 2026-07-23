Your work is not finished. Read and execute the below with ultrathink.

## Original Implementation Plan

**IMPORTANT**: Before proceeding, review the original plan you are implementing:
@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md

This plan contains the full scope of work and requirements. Ensure your work aligns with this plan.

---

## Round Re-anchor (REQUIRED FIRST STEP)

Before writing code:
- Re-read @.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md
- Re-read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md
- Re-read the most recent round summaries/reviews that led to this round
- Write the current round contract to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-4-contract.md

Your round contract must contain:
- Exactly one **mainline objective**
- The 1-2 target ACs for this round
- Which issues are truly **blocking** that mainline objective
- Which issues are **queued** and explicitly out of scope
- Concrete success criteria for this round

Do not start implementation until the round contract exists.

## Task Lane Rules

Use the Task system (TaskCreate, TaskUpdate, TaskList) with one required tag per task:
- `[mainline]` for plan-derived work that directly advances this round's objective
- `[blocking]` for issues that prevent the mainline objective from succeeding safely
- `[queued]` for non-blocking bugs, cleanup, or follow-up work

Rules:
- `[mainline]` work is the round's primary success condition
- `[blocking]` work is allowed only when it truly blocks the mainline objective
- `[queued]` work must be documented but must NOT replace the round objective
- If a new bug does not block the current objective, tag it `[queued]` and keep moving on mainline work

Before executing each task in this round:
1. Read @/home/lichangye/kernel-harness-amd/.humanize/bitlesson.md
2. Run `bitlesson-selector` for each task/sub-task
3. Follow selected lesson IDs (or `NONE`) during implementation

---
Below is Codex's review result:
<!-- CODEX's REVIEW RESULT START -->
# Round 3 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude did make the intended data-only mainline advance: the missing
`testbench/knowledge` entry exists at
`testbench/knowledge/entries/glm52--moe_total_prefill--mi300x--20260723a.json`,
`knowledge.py lint` passes, and `knowledge.py query --task glm52/moe_total_prefill
--gpu MI300X` returns the new entry newest-first.

The entry's core provenance checks out. The source artifact
`/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json` exists,
its `candidate.sha256` is
`221718a3bb122f1e86e15acac805dd0f69a047d379c5af28f804fabd0cb167c6`, and that
matches the committed `testbench/tasks/glm52/moe_total_prefill/candidate.py`.
The entry result fields match the persisted aggregate: geomean `1.0459`,
min conservative `1.0038`, repeat `10`, `shapes_won=3`,
`shapes_regressed=0`, and `worst_calc_diff=0.0`.

Clean closure is still blocked by a Round-3 contract miss. The contract's
definition of done explicitly required `knowledge.py index --check` and
`knowledge.py distill --check` to be green, regenerated if needed. Claude's
summary instead justifies leaving those generated tracked files stale. That
contradicts the round's own DoD and leaves task10/finalization incomplete.

Goal Alignment Summary:
`ACs: 5/5 addressed, 4/5 fully met | Forgotten items: 0 | Unjustified deferrals: 1`

## Mainline Gaps

1. **Round-3 definition of done is not satisfied: generated KB freshness checks still fail.**

   Evidence:
   - `python3 testbench/bin/knowledge.py lint` passes: `17 entries, 0 problems`.
   - `python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X`
     returns `glm52--moe_total_prefill--mi300x--20260723a` with
     `[win geo=1.0459 minc=1.0038]`.
   - `python3 testbench/bin/knowledge.py index --check` fails with 3 stale
     tracked files:
     `testbench/knowledge/queries/by-op.md`,
     `testbench/knowledge/queries/by-bottleneck.md`, and
     `testbench/knowledge/queries/by-technique.md`.
   - `python3 testbench/bin/knowledge.py distill --check` fails with stale
     `testbench/knowledge/distilled.json` and
     `testbench/knowledge/distilled.md`.
   - Those five generated outputs are tracked by git, so this is not ignored
     cache churn.
   - `round-3-contract.md` says task16 must "regenerate KB indices if a
     `--check` gate would otherwise flag them stale" and the definition of done
     says both `index --check` and `distill --check` must be green.

   Claude's "add-only" rationale may explain why the diff is smaller, but it is
   an explicit deferral of a contract requirement. It cannot be treated as clean
   completion.

   Required implementation plan:
   1. Do not change kernel candidates, task metadata, tasksets, harness scoring,
      timing, references, or existing `testbench/knowledge/entries/*.json` files.
   2. From the current HEAD, run:
      `python3 testbench/bin/knowledge.py index`
   3. Run:
      `python3 testbench/bin/knowledge.py distill`
   4. Review the resulting tracked diffs and keep them limited to:
      `testbench/knowledge/queries/by-op.md`,
      `testbench/knowledge/queries/by-bottleneck.md`,
      `testbench/knowledge/queries/by-technique.md`,
      `testbench/knowledge/distilled.json`, and
      `testbench/knowledge/distilled.md`.
   5. Verify all knowledge checks:
      `python3 testbench/bin/knowledge.py lint`,
      `python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X`,
      `python3 testbench/bin/knowledge.py index --check`, and
      `python3 testbench/bin/knowledge.py distill --check`.
   6. Commit the generated KB updates with a `knowledge:`-scoped message. The
      commit must not include `.humanize/`, scratch artifacts, caches, traces,
      binaries, or any kernel/harness/task authority changes.
   7. Update the current round summary/tracker after the validators are green.
      Do not claim clean completion until all four commands above pass.

## Blocking Side Issues

No separate kernel or correctness blocker was found in Round 3. The blocking
issue is the mainline finalization gap above: tracked generated KB outputs remain
stale even though the round contract required them to be refreshed or checked
green.

## Queued Side Issues

- `AITER_TRITON_ONLY=0` remains manual provenance rather than result-schema state.
  This is still non-blocking for Round 3 because no new GPU gate was run and the
  knowledge entry cites the persisted artifact plus matching candidate hash.

- The non-MoE task `run.sh` wrappers still select the wrong Python on this machine
  when repo `.venv` is absent. This remains an infrastructure follow-up and must
  not take over the knowledge-finalization round.

## Goal Tracker Update

The mutable tracker already reflects this review outcome: Plan Version 5 reopens
task10/task16, records the stale generated KB files as an open blocking side
issue, and gives the same regeneration/verification path. I made no further
tracker edit.

Do not stop the loop yet: the required knowledge entry was installed correctly,
but the Round-3 generated-KB freshness checks are still failing.
<!-- CODEX's REVIEW RESULT  END  -->
---

## Goal Tracker Reference

Before starting work, **read** @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md to understand:
- The Ultimate Goal and Acceptance Criteria you're working toward
- Which tasks are Active, Completed, or Deferred
- Which side issues are blocking vs queued
- Any Plan Evolution that has occurred
- The latest side-issue state that needs attention

**IMPORTANT**: Keep the mutable section of `goal-tracker.md` up to date during the round.
Do NOT change the immutable section after Round 0.
If you cannot safely reconcile the tracker yourself, include an optional "Goal Tracker Update Request" section in your summary (see below).

## Mainline Guardrails

- Keep the mainline objective from @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-4-contract.md stable for this round
- Do not let queued issues take over the round
- If Codex reported several findings, classify them into:
  - mainline gaps
  - blocking side issues
  - queued side issues
- Only mainline gaps and blocking side issues should drive the next code changes

---

Note: You MUST NOT try to exit by lying, editing loop state files, or executing `cancel-rlcr-loop`.

After completing the work, please:
0. If the `code-simplifier` plugin is installed, use it to review and optimize your code. Invoke via: `/code-simplifier`, `@agent-code-simplifier`, or `@code-simplifier:code-simplifier (agent)`
1. Commit your changes with a descriptive commit message
2. Write your work summary into @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-4-summary.md

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
