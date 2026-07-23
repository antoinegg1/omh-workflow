# Humanize Gen-Plan Draft For GLM-5.2 ROCm MI300X KDA

Generate an implementation plan for a KDA-Pilot style ROCm optimization loop.
The target worktree is `/home/lichangye/kernel-harness-amd`. The task scaffold is
`/opt/devmachine/lichangye/glm52-rocm-kda-pilot`.

This is not the previous OMH workflow. This is also not the upstream B200/CUDA
KDA-Pilot launcher. Preserve the KDA discipline, but adapt it to ROCm, MI300X,
gfx942, SGLang/AITER, and `kernel-harness-amd`.

## Mandatory Context To Read

From this scaffold:

- `/opt/devmachine/lichangye/glm52-rocm-kda-pilot/README.md`
- `/opt/devmachine/lichangye/glm52-rocm-kda-pilot/tasks/glm52_rocm_mi300x_taskset/config.toml`
- `/opt/devmachine/lichangye/glm52-rocm-kda-pilot/tasks/glm52_rocm_mi300x_taskset/prompt.md`

From the target worktree:

- `/home/lichangye/kernel-harness-amd/tasksets/glm52_rocm_local.json`
- `/home/lichangye/kernel-harness-amd/testbench/bin/evaluate_glm52_taskset.py`
- `/home/lichangye/kernel-harness-amd/testbench/harness/evaluate_task.py`
- `/home/lichangye/kernel-harness-amd/testbench/harness/glm52_ops.py`
- the relevant `testbench/tasks/glm52/<harness_task>/README.md`, `task.json`,
  `problem.json`, `workload.jsonl`, and `candidate.py` before editing a task

ROCm environment:

```bash
source /home/lichangye/rocm_env.sh
```

## Scope

Optimize the selected GLM-5.2 ROCm operators in the frozen taskset:

- `fused_qkv_a_prefill`
- `q_b_prefill`
- `o_proj_prefill`
- `index_q_upproj_prefill`
- `index_score_prefill`
- `moe_gate_proj_prefill`
- `moe_up_proj_prefill`
- `moe_down_proj_prefill`
- `dsa_prefill_attn`
- `routed_expert_gate_up_decode`
- `routed_expert_down_decode`
- official rollups: `moe_total_prefill`, `moe_total_decode`

The selected task count is 11 target tasks; the two MoE total rows are official
rollups and must be reported separately from diagnostic split rows.

## Contract

Use `/home/lichangye/kernel-harness-amd/testbench/bin/evaluate_glm52_taskset.py`
as the authority for correctness and performance.

The frozen taskset is:

```text
/home/lichangye/kernel-harness-amd/tasksets/glm52_rocm_local.json
```

The candidate ABI is:

```python
def run(inputs: dict):
    ...
```

Candidates may live in the task-local default file:

```text
/home/lichangye/kernel-harness-amd/testbench/tasks/glm52/<harness_task>/candidate.py
```

or in an external candidate root passed to the evaluator:

```text
--candidate-root <root-containing-harness_task/candidate.py>
```

The same frozen input dict feeds reference and candidate. Do not rebuild inputs,
re-seed random tensors, re-quantize weights, alter tolerances, alter workload
sweeps, or change the cost model to create a win.

## Metric

The metric is `roofline_mfu_bw`.

For each shape, `evaluate_task.py` computes useful FLOPs, estimated HBM bytes,
arithmetic intensity, achieved TFLOP/s, achieved GB/s, MFU, BW utilisation, and a
primary resource:

- compute-bound shapes use MFU as primary utilisation
- memory-bound shapes use HBM BW utilisation as primary utilisation

The plan must report MFU and BW fields, not only latency or speedup.

## Required Commands

Smoke:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --smoke --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_smoke_${RUN_ID:-manual}.json
```

Single task probe:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --task <task_id> \
  --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_<task_id>_${RUN_ID:-manual}.json
```

Gate-quality full taskset:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --repeat 10 --iterations 30 --warmup 3 \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_full_gate_${RUN_ID:-manual}.json
```

## Plan Requirements

The generated plan must:

- start with a preflight that checks `git status`, GPU visibility, `rocm-smi`,
  `rocprofv3`, `ROCM_TORCH_VENV`, `SGLANG_ROOT`, `AITER_ROOT`, cache paths, and a
  smoke evaluator run
- use the clean immutable review base
  `kda-base/glm52-rocm-mfu-bw-20260722`
  (`f60a69768b4172eabd7ddbc7ffacc2b621af50b4`) before RLCR starts
- keep all large generated JSON, traces, build products, and cache files under
  `/opt/devmachine/lichangye/tmp` or another `/opt/devmachine/lichangye` path
- rank the first optimization target by current evidence, preferring an official
  metric with real headroom (`moe_total_decode`, `moe_total_prefill`,
  `dsa_prefill_attn`, or `index_score_prefill`) before diagnostic-only split rows
- preserve fallback semantics: a candidate may dispatch to a custom fast path on
  shapes it wins and fall back to `glm52_ops.reference` on shapes it cannot win;
  falling back on every shape is not an improvement
- include correctness before performance, post-timing correctness, and JSON
  evidence collection
- use ROCm profiling only to answer a named question; for this non-FlyDSL
  harness, use standard ROCm artifacts and rocm-report-style summaries when
  available, not FlyDSL-only `flyprof` assumptions
- never use CUDA-only requirements such as native CUDA, `nvidia-smi`, Nsight
  Compute, B200, H200, nvcc, or NCU as mandatory gates for this task
- never fabricate benchmark/profile/GPU-id evidence

## Acceptance

A result is acceptable only if:

- `infra_failed == 0`
- `incorrect == 0`
- all claimed tasks pass post-timing correctness
- MFU/BW fields are present in the JSON result
- any performance claim cites the JSON artifact path
- each claimed speedup names task id, M shape, bound, MFU, BW utilisation, GB/s,
  TFLOP/s, latency, and conservative primary-util ratio
- final notes separate official metrics from diagnostic MoE split rows

For a no-go, record the baseline numbers, candidate attempts, correctness state,
profile or roofline evidence, and the named active bottleneck. Do not finalize a
no-go from a single losing probe.

## RLCR Start Command

After reviewing `.humanize/kernel-agent/refined-plan.md`, start the loop with:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan.md --skip-quiz --claude-answer-codex --max 12 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```
