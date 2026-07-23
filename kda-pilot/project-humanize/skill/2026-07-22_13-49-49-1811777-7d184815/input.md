# Ask Codex Input

## Question

You are reviewing an RLCR Round 0 target selection + contract before implementation for a GLM-5.2 ROCm MI300X kernel-harness. Your sandbox cannot read the filesystem; review the CONTENT below. Focus on: (1) is the target choice sound? (2) reward-hacking / contract-violation risks in the proposed candidate direction; (3) correctness traps.

=== SELECTED TARGET: moe_total_decode (official_total, production-equivalent) ===
- Fused MoE decode. hidden[M,6144] -> w1[E=8, 2I=4096, H=6144] (gate+up) -> SiLU(gate)*up -> w2[E=8, H=6144, I=2048] -> out[M,6144]. top_k=8, activation silu, is_gated=True. M in {16,32}.
- Inputs (frozen dict from glm52_ops.build_inputs, shared byte-for-byte with reference): hidden_states bf16; w1,w2 float8_e4m3fnuz (AMD fnuz); topk_weights (M,8) f32 = softmax(randn); topk_ids (M,8) int32 = arange(8) repeated per row (DENSE: every token -> all 8 experts); router_logits zeros; w1_scale,w2_scale (8,)=ones; a1_scale,a2_scale (1,)=ones; plus topk_output(StandardTopKOutput) and moe_runner_config(MoeRunnerConfig) helpers.
- Reference/baseline/oracle: sglang.srt.layers.moe.moe_runner.triton_utils.fused_moe.fused_moe(hidden,w1,w2,topk_output,cfg,use_fp8_w8a8=True,w1_scale,w2_scale,a1_scale,a2_scale). Selects AITER Triton blockscale GEMM on gfx942.
- ABI: run(inputs:dict)->output. MUST NOT re-quantize/re-seed/rebuild tensors inside run(); layout changes (.contiguous/.view) allowed and timed. inputs['out'] if present is NaN-poisoned; returning it unwritten fails.
- Correctness: FlashMLA 3-layer, dense-masked: inf/nan positions match; per-element abs_err<abs_tol OR rel_err<0.015703125 (abs_tol=1e-4*|ref|.max()); DeepGEMM calc_diff<=1e-5 (scale-sensitive; uniform k*ref is caught). Re-checked on fresh inputs after timing.
- Gate: warmup=3 repeat=10 iterations=30. win=ref_p10/cand_p90>1.0; regress=ref_p90/cand_p10<1.0; >=1 win & 0 regress passes. run() MAY fall back to glm52_ops.reference on losing shapes; falling back on EVERY shape = 0 wins = fail. HIP graph capture+replay timing, inputs cloned + L2 flush per iter outside measured window.
- Smoke util (candidate==reference, so = reference's own util): moe_total_decode M=16 bw_util 0.243 (memory-bound, ~76% headroom to HBM roof).

=== PROPOSED CANDIDATE DIRECTION ===
Because top_k==num_experts==8 and topk_ids==arange(8) for every token, the MoE is effectively DENSE (no sparsity). Hypothesis: SGLang fused_moe still pays generic routing overhead (topk sort / expert align / scatter-gather / padding) that is wasted when routing is identity. At decode M=16/32 the GEMMs are tiny and the op is memory-bound streaming ~302MB fp8 weights, so launch+routing overhead is a meaningful latency fraction. Candidate would keep weights in fp8 (preserve bandwidth) but skip routing: grouped/batched per-expert fp8 GEMM over all M rows, SiLU-gate*up, second fp8 GEMM, then topk-weighted sum, with reference fallback on any shape it cannot beat.

=== QUESTIONS ===
1. Is moe_total_decode a sound first target vs moe_total_prefill/index_score_prefill given the memory-bound (overhead-only) win ceiling?
2. What reward-hacking or contract-violation risks does the dense-GEMM direction carry (e.g. relying on scales==1.0, relying on topk_ids==arange, dtype fnuz handling, applying topk_weights/silu ordering, NaN-poison output)?
3. Any correctness traps (calc_diff scale sensitivity, fnuz vs fn, gate+up interleave order in w1)?
Answer concisely with APPROVE or REVISE, then a short risk list and any must-do guardrails.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_13-49-49
- Tool: codex
