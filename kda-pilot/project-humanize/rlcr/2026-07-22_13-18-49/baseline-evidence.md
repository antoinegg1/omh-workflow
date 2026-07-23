# Round 0 — Baseline / Probe: moe_total_decode (task5)

## Command & artifact
```
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json --task moe_total_decode \
  --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_moe_total_decode_r0_20260722_135131.json
```
Artifact: `/opt/devmachine/lichangye/tmp/kda_glm52_moe_total_decode_r0_20260722_135131.json`
(probe: repeat 1 — noisy, direction only; NOT a verdict).

## Per-shape baseline (reference == candidate default)
Latency derived from measured `best_bw_gbps` and cost-model `bytes_hbm` (302–310 MB, fp8
weights dominate). GPU: MI300X. metric_name=roofline_mfu_bw. bound: memory (decode).

| M | bw_util | mfu | prim_util | cons_ratio | best_tflops | best_bw_gbps | latency(µs) | AI |
|---|---------|-----|-----------|------------|-------------|--------------|-------------|-----|
| 1 | 0.2890 | 0.00117 | 0.2890 | 0.9659 | 3.062 | 1531.59 | ~197 | 2.0 |
| 4 | 0.2877 | 0.00466 | 0.2877 | 0.9661 | 12.178 | 1524.79 | ~198 | 8.0 |
| 8 | 0.3103 | 0.01003 | 0.3103 | 0.9926 | 26.226 | 1644.49 | ~184 | 16.0 |
| 16 | 0.2415 | 0.01556 | 0.2415 | 0.9948 | 40.687 | 1279.74 | ~238 | 31.8 |
| 32 | 0.2258 | 0.02891 | 0.2258 | 0.9901 | 75.597 | 1196.59 | ~256 | 63.2 |
| 64 | 0.2185 | 0.05526 | 0.2185 | 0.9795 | 144.493 | 1158.25 | ~268 | 124.8 |

Note: the frozen taskset sweeps decode M=[1,4,8,16,32,64]; the task's own workload.jsonl
is {16,32}. The official gate for the harness task is M∈{16,32}; the evaluator reports the
full decode sweep. Focus win shapes on 16/32 (task workload), keep an eye on all six.

## Roofline reading
- Memory-bound: MFU tiny (0.001–0.055); primary_util == bw_util. HBM peak (derived) ≈ 5300 GB/s.
- Reference streams ~302 MB fp8 weights (all 8 experts, dense) at only 22–31% of peak BW.
  Peak-BW floor ≈ 57 µs vs measured ~238 µs at M=16 ⇒ ~4x apparent headroom.
- BUT: **the headroom is overhead, not bandwidth to reclaim by "moving less data"** — both
  reference and any candidate must stream the same 302 MB of expert weights (dense routing).
  A win must come from **higher achieved bandwidth**: fewer kernel launches, no topk
  sort/expert-align/scatter-gather/padding, better access pattern. cons_ratio ~0.97–0.99
  means the reference is near its OWN measured roof under this metric — a real win must beat
  the reference's effective bandwidth, and the margin is thin (noise ±~4%).

## Environment facts confirmed (under evaluator env)
- FP8_DTYPE = `torch.float8_e4m3fnuz`, FP8_MAX = 224.0, IS_ROCM = True (must set
  KERNEL_HARNESS_PLATFORM=rocm; the evaluator does this).
- `torch._scaled_mm` → HIPBLAS_STATUS_NOT_SUPPORTED on this stack (cannot use directly).
- Available fp8 GEMM paths: aiter `gemm_a8w8`, `batched_gemm_a8w8`, `per_tensor_quant`,
  `gemm_a8w8_bpreshuffle`; SGLang `aiter_w8a8_block_fp8_linear` importable;
  `aiter.fused_moe` importable.

## Profiling decision: DEFER (try candidate first)
Per plan "profile only to answer a named question." I have a strong structural hypothesis
(dense routing ⇒ removable sort/scatter/launch overhead) and a concrete candidate direction,
so profiling would not change the first action. Decision: implement the dense-batched
candidate and measure. **If** it fails to win AND the reason is unclear, THEN profile with
rocprofv3/flyprof to answer the named question "where does the reference's non-bandwidth
time go at M=16/32 — launches, scatter, or GEMM tails?"

## Candidate direction (to encode with task4 guardrails)
Dense per-expert fp8 path with runtime guards + reference fallback:
1. Guard: M∈{16,32}, topk_ids==arange(E) per row, top_k==E==8, all scales==1.0, dtype fnuz,
   expected dims. Else `return glm52_ops.reference('moe_total','decode',inputs)`.
2. For the dense case: batched/grouped fp8 GEMM hidden@w1[e] (gate+up, [E,2I,H]), verify
   gate/up split empirically, silu(gate)*up, batched fp8 GEMM @w2[e] ([E,H,I]), then
   sum_e topk_weights[:,e] * y_e. fp32 accumulation before SiLU and final sum.
3. Compilation/warmup at import time; run() body is only the kernel calls.
4. Benchmark M=16 and M=32 at gate quality (repeat 10) before any claim.
