# Ask Codex Input

## Question

Confirm whether a committed root-cause fix resolves two [P1] code-review findings on a GLM-5.2 kernel-harness taskset, and give a clear GO or NO-GO for finalizing this optimization round.

CONTEXT
- Repo: kernel-harness-amd. GLM-5.2 operators on AMD MI300X / ROCm gfx942, fp8_e4m3fnuz.
- The loop scoring authority is the frozen taskset tasksets/glm52_rocm_local.json (pins hardware.platform = rocm, profile amd-mi300x) plus evaluator evaluate_glm52_taskset.py (metric roofline_mfu_bw). A win = at least one shape with a conservative primary_util ratio above 1 and zero shape regressions.
- Two candidate files each have a device guard that raises on non-ROCm hardware so run() falls back to the reference: dsa_prefill_attn/candidate.py has 'if torch.version.hip is None: raise', and index_score_prefill/candidate.py has 'if arch != gfx942: raise'. On real ROCm/MI300X hardware both guards pass and the fast paths win 3/3 shapes (persisted result.json).

THE TWO [P1] FINDINGS (from the last review, produced BEFORE the fix below)
[P1] dsa_prefill_attn/candidate.py:93 — When run through its documented run.sh / default backend, torch.version.hip is None so this branch always throws and run() falls back to flash_mla_sparse_fwd (the baseline); zero real wins. Remedy named by the reviewer: either the task runner/contract needs to select ROCm, or the candidate needs a B200 fast path.
[P1] index_score_prefill/candidate.py:80 — Under the documented default run, the ROCm/AITER path is rejected by the gfx942 guard and run() calls the same deep_gemm baseline; the optimized path never runs.

ROOT CAUSE (verified)
The harness DEFAULT backend was cuda-b200. testbench/bin/config.py defaulted KERNEL_HARNESS_PROFILE = cuda-b200 (mirrored in harness/backends/registry.py and harness/result_store.py), and the generated per-task task.json carried deployment = B200-DP1-TP1-EP32. So a bare run.sh (no env) resolved to B200, where the ROCm guards correctly fall back. The loop SCORING path already ran on ROCm (hence the persisted 3/3 wins), but the documented per-task default gate disagreed with it. The reviewer named remedy number 1: make the task runner/contract select ROCm.

THE FIX (committed as e01d123, applied by the repo owner, the only party permitted to edit harness/oracle/generated files)
The harness defaults and task metadata were aligned to ROCm/MI300X:
- config.py, registry.py, result_store.py now default PLATFORM=rocm, PROFILE=amd-mi300x, PROVIDER=aiter-torch-reference, TIMER=event.
- All 26 glm52 task.json deployment strings are now MI300X-DP1-TP1-EP32; the generator sync_glm52_tasks.py derives it from ops.DEVICE_PROFILE so it cannot drift back to B200.
- problem.json per-task roofline peaks re-synced to MI300X (HBM 8.0 to 5.3 TB/s, fp8 4.5 to 2.6149 PFLOP/s, bf16 2.25 to 1.3074 PFLOP/s), fp8_dtype e4m3fn to e4m3fnuz.
- Candidate guards are UNCHANGED in logic; only their doc-comments were updated.

HARD EVIDENCE
1. Documented default gate now resolves to ROCm/MI300X. With all KERNEL_HARNESS_* env unset, importing config.py yields PLATFORM=rocm, PROFILE=amd-mi300x, PROVIDER=aiter-torch-reference, TIMER=event. On this ROCm box torch.version.hip is set and the aiter module arch == gfx942, so BOTH guards pass and BOTH fast paths engage on a bare run.sh.
2. Non-reward-hack: git diff of tasksets/ versus the review base is exactly 0 lines (workload sweeps, the 5e-6 calc_diff gate, and the cost-model formula are untouched). All 88 changed files are under testbench/.
3. Peak-invariance: the win verdict is primary_util_ratio = candidate_util / reference_util; both sides divide by the same min(peak_flops, ai*peak_bw), so the B200 to MI300X peak change cancels in the ratio and cannot manufacture or erase a win. shapes_won and shapes_regressed are unaffected; the persisted 3/3 wins per task stand on their own ratios.
4. Candidate logic unchanged since the win commit: the only non-comment change to either candidate.py since the measured wins is the ROCm guard itself (added earlier to fix a prior [P1] unsafe-fallback on CUDA); everything else is comments.
5. Validation: selftest.py reports 26 tasks / 0 problems; sync_glm52_tasks.py --check reports 24 dirs in sync with glm52_ops. Both exit 0.

Note: registry.py still REGISTERS a cuda-b200 bundle as a selectable option (only reachable if someone explicitly sets KERNEL_HARNESS_PROFILE=cuda-b200); the DEFAULT resolution is rocm/amd-mi300x. Keeping CUDA selectable is intended harness design, not the default gate.

QUESTIONS
1. Does aligning the documented default gate to ROCm/MI300X (remedy number 1, which the reviewer itself named) fully resolve BOTH [P1] findings? On the default gate both guards now pass and the fast paths run and win 3/3.
2. Is this a legitimate correctness-preserving fix rather than a reward hack, given tasksets/ is byte-for-byte unchanged and the win verdict is peak-invariant?
3. Any remaining correctness or reward-hacking risk that should block finalizing this round?
Give a clear GO or NO-GO.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_21-52-17
- Tool: codex
