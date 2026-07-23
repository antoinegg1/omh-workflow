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
