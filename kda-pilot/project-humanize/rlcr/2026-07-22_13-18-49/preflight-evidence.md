# Round 0 — Preflight & Smoke Evidence (task1)

## AC-1: Environment & review base
- `git status --short --untracked-files=all`: clean (no output).
- `git show-ref --heads kda-base/glm52-rocm-mfu-bw-20260722` => `f60a69768b4172eabd7ddbc7ffacc2b621af50b4` (matches DEC-1). HEAD == base commit.
- Current branch: `codex/amd-glm52-rocm-evalbench-v2`.
- `source /home/lichangye/rocm_env.sh` exposes:
  - ROCM_TORCH_VENV=/home/lichangye/venvs/rocm-torch
  - SGLANG_ROOT=/opt/devmachine/lichangye/repos/sglang
  - AITER_ROOT=/opt/devmachine/lichangye/repos/aiter
  - TMPDIR=/opt/devmachine/lichangye/tmp
  - TRITON_CACHE_DIR=/opt/devmachine/lichangye/kernel-harness-cache/triton
  - AITER_CONFIG_DIR=/opt/devmachine/lichangye/aiter_configs
- Tools on PATH: rocm-smi (/opt/rocm/bin/rocm-smi), rocprofv3 (/opt/rocm/bin/rocprofv3), claude (/usr/local/bin/claude), codex (/home/lichangye/.codex/bin/codex).
- `claude plugins details humanize@PolyArch` lists gen-plan, start-rlcr-loop, ask-codex (plus others). OK.

## AC-2: Evaluator MFU/BW fields (smoke)
- Command:
  ```
  "$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
    --taskset tasksets/glm52_rocm_local.json \
    --smoke --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
    --json-out /opt/devmachine/lichangye/tmp/kda_glm52_smoke_r0_20260722_133258.json
  ```
- Artifact: `/opt/devmachine/lichangye/tmp/kda_glm52_smoke_r0_20260722_133258.json`
- Summary: total=13, passed=0, correct_not_faster=13, incorrect=0, infra_failed=0.
- All 13 rows: `metric_name == "roofline_mfu_bw"`. No missing required fields
  (metric_name, geomean_mfu, geomean_bw_util, best_tflops, best_bw_gbps,
  geomean_primary_util, geomean_primary_util_ratio_conservative).
- Default candidate == reference => every row `correct_not_faster` (expected; not a win).

### Smoke per-task primary_util (candidate==reference default)
| task | M | primary_util | mfu | bw_util |
|------|---|--------------|-----|---------|
| moe_total_decode | 16 | 0.2433 | 0.0157 | 0.2433 (mem-bound) |
| moe_total_prefill | 1024 | 0.1688 | 0.1688 | 0.0576 (compute-bound) |
| dsa_prefill_attn | 1024 | 0.0250 | 0.0250 | 0.0048 |
| index_score_prefill | 1024 | 0.1096 | 0.1096 | 0.0277 |
| fused_qkv_a_prefill | 1024 | 0.1272 | 0.1272 | 0.0532 |
| q_b_prefill | 1024 | 0.0792 | 0.0792 | 0.0394 |
| o_proj_prefill | 1024 | 0.0901 | 0.0901 | 0.0282 |
| index_q_upproj_prefill | 1024 | 0.1090 | 0.1090 | 0.0593 |
| moe_gate_proj_prefill | 1024 | 0.0764 | 0.0764 | 0.0341 |
| moe_up_proj_prefill | 1024 | 0.0733 | 0.0733 | 0.0327 |
| moe_down_proj_prefill | 1024 | 0.0610 | 0.0610 | 0.0319 |
| routed_expert_gate_up_decode | 16 | 0.0210 | 0.0013 | 0.0210 |
| routed_expert_down_decode | 16 | 0.0258 | 0.0016 | 0.0258 |

Note: prefill rows are compute-bound (primary_util == mfu); decode rows are
memory-bound (primary_util == bw_util). moe_total_decode at M=16 already sits at
bw_util 0.24 with conservative ratio ~0.987 vs its own reference.
