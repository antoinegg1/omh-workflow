# FULL GOAL ALIGNMENT CHECK - Round 4

This is a **mandatory checkpoint** (at configurable intervals). You must conduct a comprehensive goal alignment audit.

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan.md

You MUST read this plan file first to understand the full scope of work before conducting your review.

---
## Claude's Work Summary
<!-- CLAUDE's WORK SUMMARY START -->
# Review Round 4 Summary

## Round Type
Review-phase round. The Stop-hook advanced the counter to round 4 and ran the round-3 code
review, which returned two `[P2]` findings (no `[P0]`/`[P1]`). No new mainline target was
selected; **target #5 was NOT selected.**

## Mainline Objective (unchanged)
Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`) — all
landed, Codex-verified in the round-2 review, with the round-3 `[P1]` guard already fixed.
The only work this round was to adjudicate and dispose of the round-3 code-review findings.

## Findings — Adjudication & Classification
Both `[P2]` findings are the same root issue viewed from two candidates, and it is a
**stale-`task.json`-metadata false positive**, not a candidate defect:

1. `[P2]` `dsa_prefill_attn/candidate.py:84` — "guard `torch.version.hip is None` always
   raises on the committed B200 task → always falls back → can't beat the reference."
2. `[P2]` `index_score_prefill/candidate.py:85` — "`_mqa_mod.arch != 'gfx942'` fast path leaves
   every B200 shape neutral → gate can't be satisfied."

**Both are classified `[queued]` (owner-facing), not `[blocking]`.** The premise (gate = B200)
contradicts the loop's declared sole authority:

- `tasksets/glm52_rocm_local.json` pins `hardware.platform = rocm` / `amd-mi300x` and lists
  **both** `dsa_prefill_attn` and `index_score_prefill` in `score_model.official_metrics`. So
  both tasks are scored on ROCm/MI300X, where the guards pass and the fast paths engage.
- The `task.json` `deployment` strings are internally inconsistent: `moe_total_{decode,prefill}`
  = `MI300X-...`, but `dsa`/`index_score` still = `B200-...` — stale pre-ROCm leftovers from the
  generator `testbench/bin/sync_glm52_tasks.py`. `task.json` is a **forbidden oracle edit**.
- Persisted authoritative runs are ROCm/gfx942: `dsa` 3/3 won (worst calc_diff 2.884e-6 ≤ 5e-6),
  `index_score` 3/3 won (calc_diff 0.0). The guards key off the real device, not the stale string.
- No candidate-only edit satisfies the B200 premise: guarded ⇒ neutral (this complaint);
  unguarded ⇒ the round-3 `[P1]` regression (PyTorch loop slower than fast CUDA FlashMLA);
  a real B200 kernel needs B200 hardware and is forbidden by the plan ("no CUDA/B200
  assumptions"); editing `task.json` metadata is a forbidden oracle change.

## Work Completed
Permitted, minimal, **doc-only** candidate-side action (the reviewer's missing context was that
the authoritative gate is ROCm, not the stale `task.json` B200 string):

- `dsa_prefill_attn/candidate.py` — added a comment beside the `torch.version.hip is None` guard
  citing the taskset authority and the stale-`task.json` note.
- `index_score_prefill/candidate.py` — added the same anchoring comment beside the
  `_mqa_mod.arch != "gfx942"` guard.
- **No control-flow or math change.** The ROCm fast paths are byte-for-byte unchanged; the
  guards are kept (removing them re-opens the round-3 `[P1]`).

## Files Changed
- `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` — +9 comment lines.
- `testbench/tasks/glm52/index_score_prefill/candidate.py` — +8 comment lines.
- Commit `a7428ef` (verified diff is 100% comment lines: no non-comment added line).

## Validation
- `python3 -m py_compile` on both candidates → OK.
- `git diff --cached` grep confirms every added line is a comment (doc-only).
- Independent adjudication via `/humanize:ask-codex` (gpt-5.5:xhigh, 134 s) → **GO**: "the
  round-4 `[P2]` is a stale-metadata false positive, not a real candidate defect… keeping the
  runtime device guards is the correct engineering choice… no reward-hack or correctness risk…
  keep the guards, classify the finding as an owner-facing stale `task.json` metadata issue, and
  finalize on the ROCm authority." Codex independently re-verified the persisted ROCm results
  (`dsa` shapes_won=3, regressed=0, worst calc_diff 2.884e-6; `index_score` shapes_won=3,
  regressed=0, calc_diff 0) and that the diff is comments-only + `py_compile`/`git diff --check` clean.
- GPU re-benchmark not run: the ROCm sglang/aiter substrate under `/opt/devmachine/lichangye`
  is missing (queued). Not required — the change is a provable no-op (comments only).

## Which issues were fixed vs reclassified
- **Fixed (to the extent permitted):** added the anchoring context both findings were missing,
  so the next review can see the fast paths are reachable and winning on the authoritative gate.
- **Reclassified as queued follow-up:** the underlying stale `task.json` `deployment: B200-...`
  on `dsa`/`index_score` — an owner-facing fix in the forbidden-to-edit oracle generator
  `sync_glm52_tasks.py`, not a candidate change.

## Issues that could not be resolved (with explanation)
- The reviewer's literal remedies — "make the optimization applicable to B200" or "change the
  task/backend metadata consistently" — are both out of my permitted scope: no B200 hardware
  (plan forbids B200 assumptions) and `task.json` is a forbidden oracle file. The candidate is
  already correct on **both** platforms: wins on ROCm (authoritative gate), safely falls back to
  the untouched reference on CUDA/B200 (exactly what round-3 `[P1]` demanded).

## Remaining Items
- No `[P0-9]` issue is a candidate defect. The two `[P2]`s are queued owner-facing stale-metadata
  items (forbidden oracle edit). Queued: restore ROCm substrate; DSA fallback provider-alignment
  nit; target #5 deferred to a future explicit contract.

## Goal Tracker Update
`goal-tracker.md` updated: plan-evolution log appended (round 4 adjudication); the two `[P2]`
adjudications added to Completed and Verified (this round, Codex GO); Blocking Side Issues left
empty; the stale `task.json` `deployment: B200` metadata added to Queued Side Issues. No AC
change. No Codex help needed for tracker reconciliation (the adjudication itself was Codex-GO'd).

## BitLesson Delta
- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson-selector` was invoked for the fix task but terminated on a Bedrock API error
  (`context_management: Extra inputs are not permitted`). Moot: `.humanize/bitlesson.md` has zero
  entries and `bitlesson_allow_empty_none: true`, so the selection is deterministically NONE. (A
  candidate lesson — "when a code review's premise rests on stale generated-oracle metadata that
  contradicts the frozen taskset authority, anchor the guard to the authority and classify the
  finding owner-facing rather than removing a correct guard" — is worth adding later, but adding
  KB entries is out of scope for this adjudication-only review round.)
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
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_13-18-49/round-3-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-3-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-2-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-review-result.md


Use this history to identify patterns across rounds: recurring issues, stalled progress, or drift from the mainline objective. Weight recent rounds more heavily but watch for systemic trends in the full commit log.

## Part 1: Goal Tracker Audit (MANDATORY)

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md and verify:

### 1.1 Acceptance Criteria Status
For EACH Acceptance Criterion in the IMMUTABLE SECTION:
| AC | Status | Evidence (if MET) | Blocker (if NOT MET) | Justification (if DEFERRED) |
|----|--------|-------------------|---------------------|----------------------------|
| AC-1 | MET / PARTIAL / NOT MET / DEFERRED | ... | ... | ... |
| ... | ... | ... | ... | ... |

### 1.2 Forgotten Items Detection
Compare the original plan (@.humanize/kernel-agent/refined-plan.md) with the current goal-tracker:
- Are there tasks that are neither in "Active", "Completed", nor "Deferred"?
- Are there tasks marked "complete" in summaries but not verified?
- List any forgotten items found.

### 1.3 Deferred Items Audit
For each item in "Explicitly Deferred":
- Is the deferral justification still valid?
- Should it be un-deferred based on current progress?
- Does it contradict the Ultimate Goal?

### 1.4 Goal Completion Summary
```
Acceptance Criteria: X/Y met (Z deferred)
Active Tasks: N remaining
Estimated remaining rounds: ?
Critical blockers: [list if any]
```

## Part 2: Mainline Drift Audit (MANDATORY)

Determine whether the recent rounds are still serving the original plan:
- Is the current round's mainline objective clear and singular?
- Has Claude been advancing mainline ACs, or mostly clearing side issues?
- Which findings are true **blocking side issues** versus merely **queued side issues**?

Include a short drift summary:
```
Mainline Progress Verdict: ADVANCED / STALLED / REGRESSED
Blocking Side Issues: N
Queued Side Issues: N
```

The `Mainline Progress Verdict` line is mandatory. If you omit it, the Humanize stop hook will block the round and require the review to be rerun.

## Part 3: Implementation Review

- Conduct a deep critical review of the implementation
- Verify Claude's claims match reality
- Identify any gaps, bugs, or incomplete work
- Reference @docs for design documents

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

## Part 5: Progress Stagnation Check (MANDATORY for Full Alignment Rounds)

To implement the original plan at @.humanize/kernel-agent/refined-plan.md, we have completed **5 iterations** (Round 0 to Round 4).

The project's `.humanize/rlcr/2026-07-22_13-18-49/` directory contains the history of each round's iteration:
- Round input prompts: `round-N-prompt.md`
- Round output summaries: `round-N-summary.md`
- Round review prompts: `round-N-review-prompt.md`
- Round review results: `round-N-review-result.md`

**How to Access Historical Files**: Read the historical review results and summaries using file paths like:
- `@.humanize/rlcr/2026-07-22_13-18-49/round-3-review-result.md` (previous round)
- `@.humanize/rlcr/2026-07-22_13-18-49/round-2-review-result.md` (2 rounds ago)
- `@.humanize/rlcr/2026-07-22_13-18-49/round-3-summary.md` (previous summary)

**Your Task**: Review the historical review results, especially the **recent rounds** of development progress and review outcomes, to determine if the development has stalled.

**Signs of Stagnation** (circuit breaker triggers):
- Same issues appearing repeatedly across multiple rounds
- No meaningful progress on Acceptance Criteria over several rounds
- Claude making the same mistakes repeatedly
- Circular discussions without resolution
- No new code changes despite continued iterations
- Codex giving similar feedback repeatedly without Claude addressing it

**If development is stagnating**, write **STOP** (as a single word on its own line) as the last line of your review output @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-4-review-result.md instead of COMPLETE.

## Part 6: Output Requirements

- If issues found OR any AC is NOT MET (including deferred ACs), write your findings to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-4-review-result.md
- Include specific action items for Claude to address, classified into:
  - Mainline Gaps
  - Blocking Side Issues
  - Queued Side Issues
- **If development is stagnating** (see Part 4), write "STOP" as the last line
- **CRITICAL**: Only write "COMPLETE" as the last line if ALL ACs from the original plan are FULLY MET with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any AC is deferred
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals allowed
