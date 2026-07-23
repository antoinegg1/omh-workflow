# Ask Codex Input

## Question

RLCR Round 0 baseline review for GLM-5.2 ROCm MI300X target moe_total_decode. Your sandbox cannot read files; review CONTENT below and approve ONE concrete candidate direction or name a profiling question.

=== BASELINE (probe repeat=1, memory-bound decode, GPU MI300X, metric roofline_mfu_bw) ===
Op streams ~302MB fp8 (e4m3fnuz) expert weights for all 8 experts (DENSE: topk_ids==arange(8), top_k==num_experts==8). HBM peak ~5300 GB/s.
Per-shape reference (==candidate default) achieved:
M=1 bw_util .289 (~197us), M=4 .288 (~198us), M=8 .310 (~184us), M=16 .2415 (~238us, best_tflops 40.7, best_bw_gbps 1279.7), M=32 .2258 (~256us, 75.6 TF, 1196.6 GB/s), M=64 .2185 (~268us).
Conservative primary-util ratio (candidate/reference) ~0.97-0.99 (candidate==reference default; noise band ~±4%).
Peak-BW floor for 302MB ~57us; reference at M=16 ~238us => ~4x APPARENT headroom, but it is overhead not reclaimable bytes: both reference and candidate must stream the same 302MB dense expert weights, so a win requires HIGHER ACHIEVED BANDWIDTH (fewer launches, no topk sort/expert-align/scatter-gather/padding, better access pattern), and the win margin vs noise is thin.
Task workload shapes are M in {16,32}; the frozen taskset also sweeps M in {1,4,8,64} (candidate will fall back to reference on non-{16,32} shapes -> neutral).

=== ENV FEASIBILITY ===
torch._scaled_mm -> HIPBLAS_STATUS_NOT_SUPPORTED (cannot use). Available: aiter.gemm_a8w8, aiter.batched_gemm_a8w8, aiter.per_tensor_quant, aiter.gemm_a8w8_bpreshuffle; sglang aiter_w8a8_block_fp8_linear importable; aiter.fused_moe importable. Reference itself = sglang fused_moe -> AITER Triton blockscale GEMM (so the underlying expert GEMM kernel is AITER's; the removable part is the MoE routing wrapper).

=== PROPOSED DIRECTION ===
Dense per-expert fp8 path, guarded (M in {16,32}, topk_ids dense identity, scales==1, fnuz dtype, dims) else fall back to glm52_ops.reference. For the dense case: batched fp8 GEMM hidden@w1[e] (w1 [E,2I,H]; verify gate/up split empirically), silu(gate)*up in fp32, requantize activations per a2_scale, batched fp8 GEMM @w2[e] (w2 [E,H,I]), then sum_e topk_weights[:,e]*y_e in fp32. Compile/warmup at import; run() body only kernel calls. Bench M=16,32 at repeat=10 before any claim.
Profiling: DEFER (try candidate A/B first; profile with rocprofv3/flyprof only if candidate fails and reason unclear).

=== QUESTIONS ===
1. Is 'try the dense candidate before profiling' the right call, or should I profile first to confirm removable overhead exists (given the win margin is thin and it shares AITER's GEMM)?
2. Which single fp8 GEMM primitive is the best first bet on MI300X for skinny M=16/32 dense experts: per-expert aiter.gemm_a8w8 loop, aiter.batched_gemm_a8w8, or a fused Triton kernel?
3. Any risk this is a NO-GO (reference near its practical roof) I should pre-empt with a decisive cheap measurement?
Answer: APPROVE <direction> or REVISE, then the single primitive to try first, then the one cheap decisive measurement to take.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_14-01-19
- Tool: codex
