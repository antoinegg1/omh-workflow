# Round 2 Code Review Result

I read the original plan first (`.humanize/kernel-agent/refined-plan.md`), then the round-2 prompt, prior round summaries/reviews, current goal tracker, candidate diffs, persisted `runs/glm52/*/result.json` artifacts, and knowledge entries.

Mainline Progress Verdict: ADVANCED

## Implementation Review

No required implementation fixes.

The committed candidate changes stay inside the sanctioned task-local files:

- `testbench/tasks/glm52/moe_total_decode/candidate.py`
- `testbench/tasks/glm52/moe_total_prefill/candidate.py`
- `testbench/tasks/glm52/dsa_prefill_attn/candidate.py`
- `testbench/tasks/glm52/index_score_prefill/candidate.py`

No oracle, task definition, workload, timer, evaluator, tolerance, or legacy path changes were introduced. The four knowledge entries are append-only and lint clean.

Persisted authoritative `result.json` evidence verifies the claimed wins:

- `moe_total_decode`: `runs/glm52/moe_total_decode/20260722T083714Z-126708/result.json`, 2/2 shapes won, 0 regress, calc_diff 0.0, ratios 1.0745/1.0567.
- `moe_total_prefill`: `runs/glm52/moe_total_prefill/20260722T083730Z-959e52/result.json`, 3/3 shapes won, 0 regress, calc_diff 0.0, ratios 1.1398/1.0606/1.0447.
- `dsa_prefill_attn`: `runs/glm52/dsa_prefill_attn/20260722T083802Z-1b233d/result.json`, 3/3 shapes won, 0 regress, worst calc_diff 2.884e-6 <= 5e-6, ratios 1.2981/1.3066/1.3087.
- `index_score_prefill`: `runs/glm52/index_score_prefill/20260722T084041Z-7a3d33/result.json`, 3/3 shapes won, 0 regress, calc_diff 0.0, ratios 1.5545/3.9228/3.7449.

The result rows include the required AC-4 fields: bound, candidate/reference latency, MFU, BW utilisation, GB/s, TFLOP/s, primary-util ratios, command context via the persisted run, GPU/stack environment, and artifact paths. `round-2-summary.md` now contains the per-shape latency/bound addendum.

Static review of the `index_score_prefill` fast path matches the AMD provider contract: it squeezes the 3D weights view like `rocm_amd._try_aiter_mqa_logits`, preserves fnuz recast/scale compensation, uses the same clean-logits buffer shape/stride pattern, keeps the matrix instruction heuristic, and only changes KV-loop tiling. Official correctness and post-timing correctness are bit-exact.

Static review of the `dsa_prefill_attn` fast path matches the task math for the official inputs: gather top-k KV, fp32 QK score matmul, fp32 softmax, bf16 P@V over `d_v=512`, returning a fresh bf16 output. The official correctness gate passed before and after timing on all three shapes.

Checks run during this review:

- `python3 testbench/bin/selftest.py` -> `26 tasks, 0 problems`
- `python3 testbench/bin/knowledge.py lint` -> `16 entries, 0 problems`
- `git diff --check f60a697..HEAD` -> no whitespace errors
- `git show-ref --heads kda-base/glm52-rocm-mfu-bw-20260722` resolves to `f60a69768b4172eabd7ddbc7ffacc2b621af50b4`

I could not rerun ROCm GPU gates in this review shell because `/home/lichangye/venvs/rocm-torch` points to a missing `/opt/devmachine/lichangye/venvs/rocm-torch`, and `/opt/devmachine/lichangye/repos/{aiter,sglang}` is also absent. That is classified below as queued infrastructure restoration, not as a candidate failure, because the persisted run artifacts record clean ROCm executions from a non-dirty tree at `37132ff` and the later HEAD change is comment/knowledge only.

## Mainline Gaps

None.

The drift-recovery objective (`dsa_prefill_attn`) advanced and passed. The next prioritized target (`index_score_prefill`) also landed in the same stuck round counter cycle and passed. The original refined plan's four prioritized targets are now completed with persisted evidence and knowledge entries.

## Blocking Side Issues

None for the current mainline objective.

The prior `bwrap` review failure and stop-hook syntax crash block the loop verifier's automation, not the candidate implementations or the persisted per-task evidence.

## Queued Side Issues

- Codex `review` sandbox still fails under `bwrap`; owner/harness should fix reviewer sandboxing so normal verdicts can read files.
- Stop-hook syntax crash at `loop-codex-stop-hook.sh:1915` keeps `state.md` stuck at `current_round: 2`; owner/harness should fix it before future round transitions.
- ROCm runtime substrate is currently absent from `/opt/devmachine/lichangye`, preventing this review shell from rerunning `check_env.py` or GPU gates; restore the venv/source trees before the next benchmark round.
- DSA fallback calls `sgl_kernel.flash_mla.flash_mla_sparse_fwd` directly instead of `glm52_ops.reference('dsa_attn','prefill', inputs)`. This does not affect official validated shapes because the fast path is taken and passed, but a future maintenance touch should make the fallback provider-aligned.

## Goal Alignment Summary

ACs: 5/5 addressed | Forgotten items: 0 | Unjustified deferrals: 0

- AC-1: Preflight evidence exists; base branch resolves; tools are on PATH. Current ROCm venv absence is queued for future reruns.
- AC-2: Smoke/preflight evidence and all persisted result rows report `roofline_mfu_bw` with MFU/BW fields.
- AC-3: Candidate ABI is preserved; official correctness and post-timing correctness pass.
- AC-4: Wins are reported in MFU/BW terms with per-shape bound and latency from `result.json`.
- AC-5: Final tracked diff is scoped to candidate files plus append-only knowledge entries; no `.humanize`, caches, traces, binaries, or generated task files are committed.

## Goal Tracker Updates Applied

I updated the mutable section of `goal-tracker.md` only:

- Bumped plan version to 3 for this reconciliation.
- Reconciled completed evidence rows to the authoritative persisted `result.json` values.
- Marked `moe_total_decode` verified by this review instead of leaving it pending from the round-0 infra-blocked review.
- Corrected the confusing "Round-4 lever" wording to "Target #4 lever".
- Added queued issues for the currently missing ROCm runtime substrate and the DSA provider-aligned fallback hygiene item.

No immutable goal or AC text was changed.

COMPLETE
