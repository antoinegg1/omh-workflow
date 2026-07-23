# Round 0 — Target Selection & Contract (task3)

## Selected first official target: `moe_total_decode`

### Selection rationale (evidence-based)
Priority order from plan/DEC-3 is `moe_total_decode` > `moe_total_prefill` >
`dsa_prefill_attn` > `index_score_prefill`. Smoke MFU/BW evidence (candidate==reference,
so these ARE the reference's own utilisations):

| official target | shape | bound | primary_util | note |
|-----------------|-------|-------|--------------|------|
| moe_total_decode | M=16 | memory | bw_util 0.243 | ~76% headroom to HBM roof; official_total, production-equivalent |
| moe_total_prefill | M=1024 | compute | mfu 0.169 | large fp8 GEMMs; alt if decode is a no-go |
| index_score_prefill | M=1024 | compute | mfu 0.110 | MQA logits (aiter fp8_mqa_logits) |
| dsa_prefill_attn | M=1024 | compute | mfu 0.025 | very low util — likely fusion/overhead bound; trap risk |

Chosen: **`moe_total_decode`** — highest plan priority, official_total with direct
production value, and it carries a concrete structural win hypothesis (below).

### Contract (from `run.sh --describe`, task.json, glm52_ops, rocm_amd backend)
- harness_task: `moe_total_decode`; operator `moe_total`; phase `decode`; family `moe_fused`.
- score_scope: `official_total`, production_equivalent=True. Deployment MI300X-DP1-TP1-EP32, S=65536, seed=0.
- MATH: SGLang fused MoE total. hidden[M,6144] -> w1[E,2I=4096,H=6144] (gate+up) -> SiLU(gate)*up -> w2[E,H=6144,I=2048] -> out[M,6144]. E=8, top_k=8, activation silu, is_gated=True.
- WORKLOAD: M in {16, 32}. Every shape must pass correctness AND be beaten on latency for a win.
- Tensors (real build_inputs, M=16): hidden_states (16,6144) bf16; w1 (8,4096,6144) float8_e4m3fnuz; w2 (8,6144,2048) float8_e4m3fnuz; topk_weights (16,8) f32; topk_ids (16,8) int32 = arange(8) per row; router_logits (16,8) f32 zeros; w1_scale/w2_scale (8,) = ones; a1_scale/a2_scale (1,) = ones. Also topk_output (StandardTopKOutput) and moe_runner_config (MoeRunnerConfig) helpers.
- Reference (baseline == oracle == latency denominator): `rocm_amd._fused_moe_reference` ->
  `sglang.srt.layers.moe.moe_runner.triton_utils.fused_moe.fused_moe(..., use_fp8_w8a8=True, w1_scale, w2_scale, a1_scale, a2_scale)`. Selects AITER Triton blockscale GEMM on gfx942.
- CONTRACT/ABI: `run(inputs: dict) -> output`. Same frozen dict feeds reference; do NOT re-quantize/re-seed/rebuild any tensor inside run(). Layout changes (.contiguous/.view) are allowed and timed.
- CORRECT: FlashMLA 3-layer check, dense mask: (1) inf/nan positions match; (2) per-element abs_err<abs_tol OR rel_err<rel_tol (rel_tol=0.015703125, abs_tol=1e-4*|ref|.max()); (3) DeepGEMM calc_diff <= 1e-5 (scale-sensitive). Re-checked on fresh inputs after timing.
- FAST/gate: warmup=3, repeat=10, iterations=30 default. win = ref_p10/cand_p90 > 1.0; regress = ref_p90/cand_p10 < 1.0; neutral otherwise. >=1 win, 0 regress passes. run() MAY branch per shape and fall back to `glm52_ops.reference('moe_total','decode',inputs)` on shapes it cannot win; falling back on EVERY shape = 0 wins = fail. HIP graph capture+replay timing, inputs cloned + L2 flush per iter (outside window).
- Exit codes: 0 correct+fast, 1 correct not faster, 2 incorrect, 3 infra/contract.

### Structural win hypothesis (to validate at baseline/probe)
`topk_ids == arange(8)` for every token and `num_experts == top_k == 8` ⇒ the MoE is
**dense**: every token is processed by every expert, no real sparsity. SGLang's
`fused_moe` still performs the generic MoE routing pipeline (topk-id sort / expert
alignment / scatter-gather / padding) whose cost is pure overhead when routing is the
identity. At decode M=16/32 the per-expert GEMMs are tiny and the op is memory-bound on
streaming ~302 MB of fp8 weights, so kernel-launch + sort/scatter overhead is a
meaningful fraction of latency. A candidate that keeps weights in fp8 (to preserve HBM
bandwidth advantage) but skips routing — e.g. a grouped/batched per-expert fp8 GEMM over
the full M rows with a direct topk-weighted sum — may shave that overhead and win at
M=16 and/or M=32, with reference fallback on any shape it cannot beat.

Risks to confirm in task4/task5: (a) fp8 dtype is e4m3**fnuz** (AMD) — any manual GEMM
must use an fnuz-correct path; (b) scales are 1.0 here but the kernel must still apply
w1/w2/a scales to stay correct on the frozen inputs; (c) the Triton fused_moe may
already special-case/rebalance so the routing overhead is small — baseline probe +
optional profiling will tell; (d) memory-bound ceiling means both paths stream the same
weights, so any win is overhead-only and could be inside the noise band.

### Alternatives if `moe_total_decode` is a no-go
`moe_total_prefill` (compute-bound fp8 GEMM, mfu 0.17) is the next target; then
`index_score_prefill`. `dsa_prefill_attn` is deprioritised (mfu 0.025 suggests
overhead/fusion bound — high risk of being at its own roof).
