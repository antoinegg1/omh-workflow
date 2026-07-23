# Ask Codex Input

## Question

You are reviewing RLCR Round 0 preflight+smoke evidence for a GLM-5.2 ROCm MI300X kernel-harness. Your sandbox cannot read the filesystem, so the evidence is embedded below; review the CONTENT only.

=== AC-1 evidence (collected by the implementer) ===
- git status --short --untracked-files=all: EMPTY (clean worktree).
- git show-ref --heads kda-base/glm52-rocm-mfu-bw-20260722 => f60a69768b4172eabd7ddbc7ffacc2b621af50b4 (matches required base). HEAD == this commit. Current branch codex/amd-glm52-rocm-evalbench-v2.
- source /home/lichangye/rocm_env.sh exports: ROCM_TORCH_VENV=/home/lichangye/venvs/rocm-torch, SGLANG_ROOT=/opt/devmachine/lichangye/repos/sglang, AITER_ROOT=/opt/devmachine/lichangye/repos/aiter, TMPDIR=/opt/devmachine/lichangye/tmp, TRITON_CACHE_DIR=/opt/devmachine/lichangye/kernel-harness-cache/triton, AITER_CONFIG_DIR=/opt/devmachine/lichangye/aiter_configs.
- PATH tools: rocm-smi=/opt/rocm/bin/rocm-smi, rocprofv3=/opt/rocm/bin/rocprofv3, claude=/usr/local/bin/claude, codex=/home/lichangye/.codex/bin/codex.
- claude plugins details humanize@PolyArch lists gen-plan, start-rlcr-loop, ask-codex.

=== AC-2 evidence (smoke run) ===
Command: evaluate_glm52_taskset.py --taskset tasksets/glm52_rocm_local.json --smoke --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock.
JSON summary: {total:13, passed:0, correct_not_faster:13, incorrect:0, infra_failed:0}.
All 13 result rows have metric_name=='roofline_mfu_bw'. A programmatic check confirmed NONE of these required keys are missing on any row: metric_name, geomean_mfu, geomean_bw_util, best_tflops, best_bw_gbps, geomean_primary_util, geomean_primary_util_ratio_conservative.
Example row moe_total_decode[M=16]: metric_name=roofline_mfu_bw, geomean_mfu=0.015678, geomean_bw_util=0.243305, best_tflops=40.998, best_bw_gbps=1289.517, geomean_primary_util=0.243305, geomean_primary_util_ratio_conservative=0.9871, score_scope=official_total, production_equivalent=True. Default candidate==reference so every row is correct_not_faster (expected, not a win).

=== Question ===
Against AC-1 (clean worktree; base ref == f60a697...; rocm_env exports; PATH tools; plugin skills) and AC-2 (smoke infra_failed==0 and incorrect==0; every row metric_name=='roofline_mfu_bw'; rows carry geomean_mfu, geomean_bw_util, best_tflops, best_bw_gbps), is anything missing or invalid before proceeding to target selection? Answer concisely: start with PASS or FAIL, then list any concrete gaps or risks to watch.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_13-39-53
- Tool: codex
