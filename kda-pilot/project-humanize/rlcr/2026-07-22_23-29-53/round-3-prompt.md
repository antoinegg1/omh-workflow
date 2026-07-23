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
- Write the current round contract to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-3-contract.md

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
# Round 2 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude did complete the kernel-facing Round-2 objective. I verified the corrected
review boundary (`3ddb2ea..HEAD`) contains only two candidate files, with the
Round-2 code delta limited to `testbench/tasks/glm52/moe_total_prefill/candidate.py`.
The new `_pick_group_size_m()` branch is exactly the claimed `M >= 4096 -> 16`
shift, with `BLOCK_SIZE_K` untouched.

The persisted gate artifacts support the MoE recovery claim:

| Task / artifact | Result |
|---|---|
| `kda_round2_moe_decode_official_r10a.json` | 2/2 wins, `shapes_regressed=0`, min_cons `1.0411`, `calc_diff=0` |
| `kda_round2_moe_decode_official_r10b.json` | 2/2 wins, `shapes_regressed=0`, min_cons `1.0454`, `calc_diff=0` |
| `kda_round2_moe_prefill_official_r10a.json` | 3/3 wins, `shapes_regressed=0`, min_cons `1.0058`, `calc_diff=0` |
| `kda_round2_moe_prefill_official_r10b.json` | 3/3 wins, `shapes_regressed=0`, min_cons `1.0038`, `calc_diff=0` |
| `kda_round2_dsa_prefill_attn_official_r10.json` | 3/3 wins, geomean `2.1213`, min_cons `2.0691`, worst `calc_diff=2.8842527531880435e-06` |
| `kda_round2_index_score_prefill_official_r10.json` | 3/3 wins, geomean `2.8416`, min_cons `1.5321`, `calc_diff=0` |

I also verified `selftest.py` passes, `sync_glm52_tasks.py --check` passes, the
taskset still names `rocm / amd-mi300x / aiter-torch-reference / event`, the
official metrics are unchanged, and there is no Round-2-boundary diff to
`glm52_ops.py`, task metadata, taskset files, runner/timing/reward code, or
generated `run.sh` files.

Clean closure is still blocked by one process requirement: the repo guide requires
one append-only `testbench/knowledge` entry per completed optimization session, and
no new entry was added for the Round-2 MoE tail-shape recovery. The `.humanize`
BitLesson entry is useful, but it is not a substitute for the harness knowledge
base.

Goal Alignment Summary:
`ACs: 5/5 addressed, 4/5 fully met | Forgotten items: 1 | Unjustified deferrals: 0`

## Mainline Gaps

No kernel-performance mainline gap remains. The accepted MoE win profile is restored
under the runnable pinned-CK reference, and the final four-task result has no lost
accepted wins and no shape regressions.

Task10/finalization is incomplete because the required knowledge-base entry is
missing; I classify that below as a blocking side issue for clean session closure
rather than as a kernel implementation failure.

## Blocking Side Issues

1. **Missing required `testbench/knowledge` entry blocks clean closure.**

   Evidence:
   - `testbench/knowledge/README.md` requires one structured entry per completed
     optimization session.
   - `find testbench/knowledge/entries` shows no new Round-2 entry after the
     existing `20260722a` GLM52 entries.
   - `git diff 3ddb2ea..HEAD -- testbench/knowledge` is empty.
   - The new lesson exists only in `.humanize/bitlesson.md`.

   Required implementation plan:
   1. Draft one new JSON entry, suggested id
      `glm52--moe_total_prefill--mi300x--20260723a`, for the Round-2 committed
      `moe_total_prefill` tail-shape recovery.
   2. Use only persisted `result.json` facts. For the final result fields, use one
      of the committed-candidate official prefill gates, for example
      `/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json`:
      geomean `1.0459`, min_cons `1.0038`, repeat `10`, `shapes_won=3`,
      `shapes_regressed=0`.
   3. In `approaches`, record the `GROUP_SIZE_M` sweep:
      `GM=1/8` regressed, `GM=2/4` neutral, `GM=16/32` won, and the committed
      winner was `GM=16` for `M>=4096` because it restored the official full sweep
      without changing `BLOCK_SIZE_K` or `calc_diff`.
   4. Include the decode `BLOCK_SIZE_M` sweep as preservation/context evidence in
      the entry text or caveats: current `BM=32` already won, so no decode code
      change was made.
   5. Install with `python3 testbench/bin/knowledge.py add <draft.json>`, then run
      `python3 testbench/bin/knowledge.py lint`.
   6. Update `round-2-summary.md` and the tracker to cite the installed entry, then
      mark task10 complete again.

## Queued Side Issues

- **`AITER_TRITON_ONLY=0` remains manual provenance, not encoded state.**

  External aiter is correctly restored at HEAD `2ca7878e2d47`, CK
  `b6759456103a6e78137ecbae673c69865884f7e3`, and `module_quant.so` is present.
  But sourcing `/home/lichangye/rocm_env.sh` currently yields
  `AITER_TRITON_ONLY=1`. This does not invalidate the successful artifacts, but
  future MoE gates must explicitly export `AITER_TRITON_ONLY=0` until the owner
  fixes the default env or result schema.

- **Non-MoE task `run.sh` wrappers still select the wrong Python on this machine.**

  `dsa_prefill_attn/run.sh` and `index_score_prefill/run.sh` ignore
  `ROCM_TORCH_VENV` and fall back to `/opt/conda/bin/python3` when repo `.venv` is
  absent; that Python has CUDA torch and no ROCm. The Round-2 dsa/index artifacts
  are still valid because they were generated with the ROCm Python through
  `evaluate_task.py`/taskset-equivalent invocation and their candidate hashes match
  the committed files. This is an infrastructure follow-up, not a reason to change
  generated task files in this round.

## Goal Tracker Update

I updated the mutable section of
`.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md`:

- Plan Version is now 3, documenting that kernel wins are verified but clean
  closure needs the missing knowledge entry.
- `task10` is reopened as `needs revision`.
- Added a blocking side issue for the missing Round-2 `testbench/knowledge` entry.
- Corrected the `AITER_TRITON_ONLY` queued issue to reflect that the sourced env
  still defaults to `1`.
- Added the non-MoE `run.sh` Python-selection issue as queued.

Do not stop the loop yet: the kernel objective advanced, but finalization is not
complete until the required knowledge entry is added and validated.
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

- Keep the mainline objective from @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-3-contract.md stable for this round
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
2. Write your work summary into @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-3-summary.md

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
