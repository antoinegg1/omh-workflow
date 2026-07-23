# Ask Codex Input

## Question

You are performing a FIRST-PASS PLANNING CRITIQUE (not implementation) for a Humanize gen-plan step.
Do NOT write code. Do NOT modify files. Only analyze the draft and propose stronger plan directions.

## Repository context

Project: `/home/lichangye/kernel-harness-amd` is a kernel-optimization test harness for GLM-5.2 operators.
- `testbench/bin/evaluate_glm52_taskset.py` is the authoritative evaluator (correctness + performance).
- `testbench/harness/evaluate_task.py` computes per-shape roofline metrics (useful FLOPs, HBM bytes,
  arithmetic intensity, achieved TFLOP/s, achieved GB/s, MFU, BW utilisation, primary resource).
- `testbench/harness/glm52_ops.py` holds the reference implementations.
- `tasksets/glm52_rocm_local.json` is the FROZEN taskset (workload M sweeps, tolerances, cost model).
- Candidate ABI: `def run(inputs: dict): ...` living in
  `testbench/tasks/glm52/<harness_task>/candidate.py` or an external `--candidate-root`.
- Target GPU: AMD MI300X, gfx942, ROCm, SGLang + AITER. This is NOT CUDA/B200/Nsight.
- Metric: `roofline_mfu_bw`. Compute-bound shapes use MFU as primary util; memory-bound use HBM BW util.

## Scaffold acceptance/config (authoritative, from config.toml)

- correctness: `infra_failed == 0 and incorrect == 0`
- performance_gate: "per task: at least one shape wins and zero shapes regress; taskset summary reports
  passed/correct_not_faster/incorrect/infra_failed"
- headline: report MFU, BW utilisation, GB/s, TFLOP/s, primary-util ratio, speedup, and shape verdicts
- no_go_requires: correct baseline numbers, at least one reasoned candidate attempt, profile or roofline
  evidence, and a named active bound or blocker
- Operator scopes: selected_task, official_task, diagnostic_component (rolls up to moe_total_*), official_total.
- Decode diagnostics map to harness tasks: routed_expert_gate_up_decode -> moe_gate_proj_decode,
  routed_expert_down_decode -> moe_down_proj_decode.
- Clean immutable review base: kda-base/glm52-rocm-mfu-bw-20260722 (commit f60a69768b41...).
- Keep all large generated JSON/traces/build/cache under /opt/devmachine/lichangye/tmp (or another
  /opt/devmachine/lichangye path).
- Fallback semantics: a candidate may dispatch a custom fast path on shapes it wins and fall back to
  glm52_ops.reference on shapes it cannot win; falling back on EVERY shape is NOT an improvement.

## Raw draft to critique

The draft asks to generate an implementation plan for a KDA-Pilot-style ROCm optimization loop that:
optimizes 11 target GLM-5.2 operators + 2 official MoE rollups; uses the frozen taskset + evaluator as
authority; reports roofline_mfu_bw (MFU/BW) fields; starts with a preflight (git status, GPU visibility,
rocm-smi, rocprofv3, ROCM_TORCH_VENV, SGLANG_ROOT, AITER_ROOT, cache paths, smoke eval); ranks the first
optimization target by evidence preferring official metrics with real headroom (moe_total_decode,
moe_total_prefill, dsa_prefill_attn, or index_score_prefill) before diagnostic-only split rows; preserves
fallback semantics; enforces correctness-before-performance, post-timing correctness, JSON evidence; uses
ROCm profiling only to answer a named question (standard ROCm artifacts / rocm-report-style summaries, NOT
FlyDSL-only flyprof assumptions); never uses CUDA-only gates (nvidia-smi, Nsight, nvcc, NCU, B200/H200);
never fabricates benchmark/profile/GPU-id evidence. Acceptance requires infra_failed==0, incorrect==0, all
claimed tasks pass post-timing correctness, MFU/BW present, every performance claim cites a JSON artifact
path, each claimed speedup names task id/M shape/bound/MFU/BW util/GB/s/TFLOP/s/latency/conservative
primary-util ratio, and final notes separate official metrics from diagnostic MoE split rows. A no-go must
record baseline numbers, candidate attempts, correctness state, profile/roofline evidence, and the named
active bottleneck; do not finalize a no-go from a single losing probe.

## Your task

Critique the assumptions, identify missing requirements/edge cases, and propose stronger plan directions.
Focus on: correctness/fallback safety, roofline-metric reporting fidelity, target-ranking soundness, ROCm
profiling discipline, evidence integrity, and anything that could make the RLCR loop waste iterations or
produce an invalid "win". Be concrete and specific to this harness.

Respond in EXACTLY this format with these six headers:

CORE_RISKS:
- (highest-risk assumptions and potential failure modes)

MISSING_REQUIREMENTS:
- (likely omitted requirements or edge cases)

TECHNICAL_GAPS:
- (feasibility or architecture gaps)

ALTERNATIVE_DIRECTIONS:
- (viable alternatives with tradeoffs)

QUESTIONS_FOR_USER:
- (questions that need explicit human decisions)

CANDIDATE_CRITERIA:
- (candidate acceptance criteria suggestions, ideally as AC-style testable statements)

## Configuration

- Model: gpt-5.5
- Effort: high
- Timeout: 540s
- Timestamp: 2026-07-22_13-01-49
- Tool: codex
