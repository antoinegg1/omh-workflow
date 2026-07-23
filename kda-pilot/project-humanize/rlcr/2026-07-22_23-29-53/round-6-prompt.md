# Code Review Findings

You are in the **Review Phase**. Codex has performed a code review and found issues that need to be addressed.

## Required Re-anchor

Before touching code:
- Re-read the original plan at @.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md
- Re-read the goal tracker at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md
- Refresh the current round contract at @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-6-contract.md

The round contract must preserve a single mainline objective. Code review findings do NOT automatically become the new round objective.

## Review Results

## Codex Review Issues

- [P1] Update default candidates before switching the backend — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-53
  When no `KERNEL_HARNESS_*` variables are set, `run.sh` now selects ROCm/MI300X, but most existing task candidates are still the CUDA defaults; for example `index_score_decode/candidate.py` reads `inputs['kv_cache_fp8']`/`block_tables` while the ROCm score builder supplies `k_fp8`/`k_scale`/`ks`/`ke`, and GEMM/MoE candidates still call `deep_gemm`. On the default path these tasks fail before a user edits anything instead of providing the correct reference baseline, so update/regenerate candidates for the selected backend or keep the default CUDA until that is done.

- [P2] Regenerate stale tensor tables for ROCm contracts — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_decode/problem.json:13-13
  After declaring this task as the ROCm ks-range score form, the committed `contract.tensors` table still describes the old CUDA paged ABI (`q_fp8` as `[16,1,32,128]`, `kv_cache_fp8`, `seqlens`, `block_tables`). On MI300X, `build_inputs` for this same problem returns `q_fp8 [M,32,128]`, `k_fp8`/`k_scale`, `weights [M,32,1]`, `ks`/`ke`, so `problem.json` is no longer a truthful machine-readable contract and a candidate generated from it will use missing keys.

- [P2] Archive the candidate bytes that match the result hashes — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/dsa_prefill_attn/result.json:57-57
  The archived result records an exact candidate SHA, but the committed archived candidate file has a different hash (for this task the result says `7d8437...`, while `candidate/candidate.py` hashes to `d5c7e7...`; the same mismatch exists for the other three archived tasks). This makes the archive unable to prove that the committed candidate produced the accepted `result.json`, so rerun/update the results or archive the exact bytes that were measured.
The backend default switch leaves many default task candidates incompatible with the selected ROCm inputs, and some generated problem/archive metadata no longer matches the artifacts it describes. These are contract/runtime issues rather than cosmetic documentation drift.

Full review comments:

- [P1] Update default candidates before switching the backend — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-53
  When no `KERNEL_HARNESS_*` variables are set, `run.sh` now selects ROCm/MI300X, but most existing task candidates are still the CUDA defaults; for example `index_score_decode/candidate.py` reads `inputs['kv_cache_fp8']`/`block_tables` while the ROCm score builder supplies `k_fp8`/`k_scale`/`ks`/`ke`, and GEMM/MoE candidates still call `deep_gemm`. On the default path these tasks fail before a user edits anything instead of providing the correct reference baseline, so update/regenerate candidates for the selected backend or keep the default CUDA until that is done.

- [P2] Regenerate stale tensor tables for ROCm contracts — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_decode/problem.json:13-13
  After declaring this task as the ROCm ks-range score form, the committed `contract.tensors` table still describes the old CUDA paged ABI (`q_fp8` as `[16,1,32,128]`, `kv_cache_fp8`, `seqlens`, `block_tables`). On MI300X, `build_inputs` for this same problem returns `q_fp8 [M,32,128]`, `k_fp8`/`k_scale`, `weights [M,32,1]`, `ks`/`ke`, so `problem.json` is no longer a truthful machine-readable contract and a candidate generated from it will use missing keys.

- [P2] Archive the candidate bytes that match the result hashes — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/dsa_prefill_attn/result.json:57-57
  The archived result records an exact candidate SHA, but the committed archived candidate file has a different hash (for this task the result says `7d8437...`, while `candidate/candidate.py` hashes to `d5c7e7...`; the same mismatch exists for the other three archived tasks). This makes the archive unable to prove that the committed candidate produced the accepted `result.json`, so rerun/update the results or archive the exact bytes that were measured.

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

1. **Refresh the round contract** at `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-6-contract.md`
2. **Address blocking issues first** and keep the mainline objective stable
3. **Focus on fixes only** - do not add new features or make unrelated changes
4. **Commit your changes** after fixing the issues
5. **Write your summary** to: `/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-6-summary.md`

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
