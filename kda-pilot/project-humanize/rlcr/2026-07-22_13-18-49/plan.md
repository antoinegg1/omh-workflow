# GLM-5.2 ROCm MI300X KDA Optimization Plan

## Goal Description

Run a KDA-Pilot style Claude/Codex RLCR optimization loop for the GLM-5.2 ROCm
MI300X taskset in `/home/lichangye/kernel-harness-amd`, using the frozen
`tasksets/glm52_rocm_local.json` workload and the `roofline_mfu_bw` evaluator as
the only correctness and performance authority.

The loop must optimize candidate implementations for selected GLM-5.2 operators
without using the previous OMH workflow, without CUDA/B200 assumptions, and
without live `sglang serve` as a benchmark baseline.

## Acceptance Criteria

- AC-1: Environment and review base are valid before implementation.
  - Positive Tests:
    - `git status --short --untracked-files=all` in `/home/lichangye/kernel-harness-amd` is clean except ignored `.humanize/` state.
    - `git show-ref --heads kda-base/glm52-rocm-mfu-bw-20260722` resolves to `f60a69768b4172eabd7ddbc7ffacc2b621af50b4`.
    - `source /home/lichangye/rocm_env.sh` exposes `ROCM_TORCH_VENV`, `SGLANG_ROOT`, `AITER_ROOT`, `TMPDIR`, `TRITON_CACHE_DIR`, and `AITER_CONFIG_DIR`.
    - `rocm-smi`, `rocprofv3`, `claude`, and `codex` are on `PATH`.
    - `claude plugins details humanize@PolyArch` lists `gen-plan`, `start-rlcr-loop`, and `ask-codex`.
  - Negative Tests:
    - Starting RLCR with any base other than `kda-base/glm52-rocm-mfu-bw-20260722` is rejected by review.
    - Proceeding with uncommitted tracked files before loop start is rejected.

- AC-2: The evaluator reports MFU/BW fields for the frozen taskset.
  - Positive Tests:
    - A smoke run succeeds with `infra_failed == 0` and `incorrect == 0`.
    - Each result row includes `metric_name == "roofline_mfu_bw"`.
    - Each result row includes MFU/BW fields such as `geomean_mfu`, `geomean_bw_util`, `best_tflops`, and `best_bw_gbps`.
  - Negative Tests:
    - A result that only reports latency or raw speedup without MFU/BW fields is rejected.
    - A result from a changed taskset, changed workload sweep, or changed tolerance is rejected.

- AC-3: Candidate changes preserve the GLM-5.2 task ABI and correctness contract.
  - Positive Tests:
    - Candidate code exposes `run(inputs: dict) -> output` through the task-local `candidate.py` or an external candidate root.
    - The same frozen input dict feeds reference and candidate.
    - Pre-timing and post-timing correctness both pass.
  - Negative Tests:
    - Rebuilding inputs, reseeding tensors, re-quantizing weights, weakening tolerances, changing the cost model, or monkey-patching the reference path is rejected.
    - Any run with `incorrect > 0` or `infra_failed > 0` is rejected.

- AC-4: A performance win is evidence-backed and reported in MFU/BW terms.
  - Positive Tests:
    - At least one shape for a claimed task has a conservative primary-util win and zero shape regressions.
    - The result report names task id, M shape, bound, MFU, BW utilisation, GB/s, TFLOP/s, latency, primary-util ratio, command, GPU, commit, and JSON artifact path.
  - Negative Tests:
    - A candidate that falls back to `glm52_ops.reference` on every shape is not counted as an improvement.
    - A single noisy probe is not sufficient for a final claim.

- AC-5: Final artifacts are scoped and reviewable.
  - Positive Tests:
    - Large JSON, profile traces, caches, and build artifacts remain under `/opt/devmachine/lichangye` or ignored `.humanize/` state.
    - Final git diff excludes raw traces, build outputs, cache trees, and scratch logs.
  - Negative Tests:
    - Committing `.humanize/`, cache directories, profiler dumps, or generated binaries is rejected.

## Path Boundaries

### Upper Bound

The loop may implement shape-specialized ROCm candidates, Python dispatch glue,
Triton ROCm kernels, HIP/C++ extensions, and reference fallback for losing
shapes. It may gather ROCm profiling evidence when a named bottleneck question
requires it. It may optimize multiple selected operators if the first official
target converges early.

### Lower Bound

The loop must at least complete one official target attempt with baseline
numbers, a reasoned candidate attempt, correctness evidence, MFU/BW benchmark
evidence, and either an improvement or a named no-go blocker.

### Allowed Choices

- Can use: PyTorch ROCm, Triton ROCm, HIP/C++ extensions, SGLang/AITER APIs
  already available in the configured environment, task-local candidate files,
  external candidate roots, ROCm profiling artifacts, ROCmKernelWiki, and
  rocm-report-style summaries.
- Cannot use: previous OMH workflow, CUDA-only requirements, `nvidia-smi`,
  Nsight Compute, B200/H200 assumptions, nvcc-only implementation rules, live
  `sglang serve` benchmark baselines, modified workload rows, relaxed
  correctness thresholds, fabricated evidence, or destructive changes outside
  the target worktree.

## Fixed Commands

Use this environment before any GPU work:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
```

Smoke:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --smoke --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_smoke_${RUN_ID:-manual}.json
```

Single task probe:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --task TASK_ID \
  --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_TASK_ID_${RUN_ID:-manual}.json
```

Gate-quality taskset run:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --repeat 10 --iterations 30 --warmup 3 \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_full_gate_${RUN_ID:-manual}.json
```

RLCR start command after human plan review:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan.md --skip-quiz --claude-answer-codex --max 12 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

Claude session launch for implementation:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
claude --permission-mode bypassPermissions --model opus --effort max
```

Model split:

- Claude implementation model: `opus`, effort `max`.
- Codex review model: `gpt-5.5:xhigh`, timeout `5400` seconds per review call.
- RLCR loop cap: `--max 12`.

## Target Prioritization

Start with official metrics that already showed useful signal or have direct
production value:

1. `moe_total_decode`
2. `moe_total_prefill`
3. `dsa_prefill_attn`
4. `index_score_prefill`

Diagnostic MoE split rows are useful for attribution, but final reporting must
separate them from the official fused MoE totals.

## Dependencies and Sequence

### Milestone 1: Preflight

- Verify clean worktree and review base.
- Verify Humanize plugin and Codex model setting.
- Verify ROCm environment and GPU visibility.
- Run smoke evaluator and record JSON path.
- Inspect the selected target task's README, task.json, problem.json,
  workload.jsonl, candidate.py, and the relevant `glm52_ops.py` reference path.

### Milestone 2: Baseline Characterization

- Run the selected task with probe settings.
- Extract per-shape latency, bound, MFU, BW utilisation, TFLOP/s, GB/s,
  conservative primary-util ratio, and shape verdicts.
- Decide whether profiling is needed. Profile only to answer a named question.

### Milestone 3: Candidate Implementation

- Implement the smallest task-local candidate that can plausibly win at least
  one shape while preserving fallback for losing shapes.
- Keep setup/compilation outside the timed body.
- Run correctness first, then probe benchmark, then gate-quality benchmark for
  any claimed win.

### Milestone 4: Review and Iterate

- Ask Codex to review every candidate round for contract violations, false wins,
  missing MFU/BW evidence, changed workload/tolerance, unsafe fallback, and
  noisy measurement.
- Either refine implementation or record no-go evidence with an active bound.

### Milestone 5: Final Report

- Summarize commands, JSON artifacts, target commit, GPU, per-shape results,
  MFU/BW metrics, candidate changes, failed attempts, and conclusion.
- Ensure `git diff` contains only intended source changes.

## Task Breakdown

| Task ID | Description | Target AC | Tag | Depends On |
|---------|-------------|-----------|-----|------------|
| task1 | Verify clean base, Humanize plugin, Codex model string, ROCm env, and smoke evaluator. | AC-1, AC-2 | coding | - |
| task2 | Review preflight and smoke evidence for missing setup or invalid metric fields. | AC-1, AC-2 | analyze | task1 |
| task3 | Select first official target using current MFU/BW evidence and inspect its full task contract. | AC-3, AC-4 | coding | task2 |
| task4 | Review selected target contract and identify reward-hacking risks before implementation. | AC-3 | analyze | task3 |
| task5 | Establish baseline/probe results for the selected target and decide whether profiling is needed. | AC-2, AC-4 | coding | task4 |
| task6 | Review baseline evidence and approve one concrete candidate direction or profiling question. | AC-4 | analyze | task5 |
| task7 | Implement the first candidate with shape dispatch and reference fallback where needed. | AC-3, AC-4 | coding | task6 |
| task8 | Review code diff for ABI, correctness, fallback, workload, and metric-contract violations. | AC-3, AC-5 | analyze | task7 |
| task9 | Run correctness, probe benchmark, and gate-quality benchmark for the candidate. | AC-2, AC-3, AC-4 | coding | task8 |
| task10 | Review benchmark evidence and decide improve, iterate, or no-go. | AC-4 | analyze | task9 |
| task11 | Finalize report and clean diff, or begin the next target if the first target is complete. | AC-5 | coding | task10 |

## Claude-Codex Deliberation

### Agreed Points

- The frozen `kernel-harness-amd` evaluator is the authority.
- MFU/BW fields are mandatory for performance reporting.
- Official MoE rollups must not be conflated with diagnostic split rows.
- A reference fallback on every shape is not an improvement.
- Live SGLang serving is out of scope for RLCR acceptance.

### Known Tensions

- Claude may want broad multi-operator changes; Codex should push back toward
  one official target until evidence supports expanding scope.
- Claude may prefer quick `--repeat 1` probes; Codex should require
  gate-quality runs before final claims.
- Profiling should be used when it answers a named bottleneck question, but not
  as a substitute for correctness and benchmark gates.

## Decision Ledger

- DEC-1: Review base.
  - Decision: Use `kda-base/glm52-rocm-mfu-bw-20260722`.
  - Commit: `f60a69768b4172eabd7ddbc7ffacc2b621af50b4`.
  - Status: FINAL.

- DEC-2: Metric.
  - Decision: Use `roofline_mfu_bw` with MFU for compute-bound shapes and HBM BW
    utilisation for memory-bound shapes.
  - Status: FINAL.

- DEC-3: First target.
  - Decision: Prefer `moe_total_decode`, then `moe_total_prefill`,
    `dsa_prefill_attn`, or `index_score_prefill` if evidence changes.
  - Status: REVIEW AT LOOP START.

## Completion Checklist

- Clean review base confirmed.
- Humanize and Codex model settings confirmed.
- Smoke JSON recorded.
- Target contract read.
- Baseline/probe JSON recorded.
- Candidate correctness passes before and after timing.
- Final claim includes MFU, BW utilisation, GB/s, TFLOP/s, latency, bound, and
  primary-util ratio.
- Final diff excludes `.humanize/`, caches, profiler dumps, build artifacts, and
  scratch logs.
