# Ask Codex Input

## Question

Review this GLM-5.2 kernel-harness candidate diff AND its official benchmark evidence for correctness/reward-hacking risk, then give a GO/NO-GO for committing this round.

CONTEXT
- Repo: kernel-harness-amd. Target task: moe_total_decode (GLM-5.2 fused MoE, decode phase, AMD MI300X / ROCm gfx942, fp8_e4m3 w8a8).
- Frozen taskset tasksets/glm52_rocm_local.json + evaluator evaluate_glm52_taskset.py (metric roofline_mfu_bw) are the ONLY authority. Only file edited: testbench/tasks/glm52/moe_total_decode/candidate.py (the sanctioned candidate file). No oracle/harness/reference files touched.
- Correctness gate = FlashMLA 3-layer check culminating in DeepGEMM calc_diff <= 5e-6 (very tight, scale-sensitive).

WHY REIMPLEMENTATION IS IMPOSSIBLE (evidence, M=16, via monkeypatch-capturing the reference internal tensors):
- My fp8 gemm1 (dequant->fp32 matmul) vs reference intermediate_cache1: ~0.99 cosine/row (not bit-exact).
- silu_and_mul: my fp32 vs reference intermediate_cache2 = 0.99999999 (not the problem).
- Feeding the reference EXACT intermediate_cache2 into my own a2-quant (static per-tensor via sglang OWN scaled_fp8_quant)+gemm2 still yields cosine 0.969 / calc_diff 3.15e-2 (~3000x over gate).
Root cause: fp8 intermediate saturates (act amax ~76288 vs FP8_MAX 224, ~45% of values clamp at +/-224). At that cliff any tiny gemm1/quant difference flips many fp8 codes. So calc_diff<=5e-6 REQUIRES bit-exact reproduction of the reference Triton fp8 kernels; no aiter primitive or hand kernel does it.

THE OPTIMIZATION (this candidate):
Decode is dense-degenerate: top_k==num_experts==8, topk_ids==arange(8) => every token routes to every expert. Reference picks BLOCK_SIZE_M=128 (or 64), but at decode M<=64 each expert owns only M rows, so moe_align_block_size pads every expert block up to BLOCK_SIZE_M (up to ~8x wasted padded-row work in BOTH fp8 GEMMs). The candidate: (1) calls sglang OWN try_get_optimal_moe_config to get the reference resolved config; (2) overrides ONLY BLOCK_SIZE_M (both gemm1 cfg and down cfg) to clamp(next_pow2(M),16,128), keeping BLOCK_SIZE_N/K, GROUP_SIZE_M, num_warps, num_stages exactly as tuned; (3) recomputes moe_align_block_size with the shrunk block; (4) calls sglang OWN _fused_moe_kernel_sequence directly with the reference exact fp8 args. BLOCK_SIZE_M changes only the tile grid, NOT the per-output-element fp32 K-accumulation order (that is BLOCK_SIZE_K, untouched). Measured calc_diff == 0.00e+00 (bit-exact) for M in {1,4,8,16,32,64} in a standalone probe. run() wraps the fast path in try/except -> falls back to the untouched reference on any surprise. For M>32 it deliberately falls back to reference (shrinking there measured a 0.7% regression).

OFFICIAL EVALUATOR RESULTS (metric roofline_mfu_bw, primary_util=BW utilization; ratio=candidate/reference):
  M=1  : passed              ratio 1.0683 (cons 1.0581) correct=True bw 0.4928
  M=4  : passed              ratio 1.0700 (cons 1.0544) correct=True bw 0.4877
  M=8  : passed              ratio 1.0757 (cons 1.0659) correct=True bw 0.4845
  M=16 : passed              ratio 1.0757 (cons 1.0568) correct=True bw 0.3462
  M=32 : passed              ratio 1.0566 (cons 1.0428) correct=True bw 0.3308
  M=64 : correct_not_faster  ratio ~1.0 (reference fallback) correct=True bw 0.2895
Summary: passed=5, correct_not_faster=1, incorrect=0, infra_failed=0. All 6 shapes correct.

FULL LOGIC of candidate.py run() (only file changed):
def run(inputs): try: return _fast_moe_total_decode(inputs) except Exception: return glm52_ops.reference(OP,PHASE,inputs)
_fast_moe_total_decode: extracts hidden/w1/w2/topk_weights/topk_ids/w1_scale/w2_scale/a1_scale/a2_scale from inputs; E,N,_=w1.shape; M=hidden.shape[0]; topk=topk_ids.shape[1]; if topk!=E raise; if M>32 raise; import sglang fused_moe module fm and moe_align_block_size; cast topk_ids to int32 if needed; cfg,(down_cfg,_)=fm.try_get_optimal_moe_config(w1.shape,(w2.shape[0],w2.shape[1],w2.shape[2]),topk,'fp8_w8a8',M,block_shape=None,per_channel_quant=False,return_down_config=True); cfg=dict(cfg); down_cfg=dict(down_cfg) if not None; bm=clamp(next_pow2(M),16,128); cfg['BLOCK_SIZE_M']=min(cfg['BLOCK_SIZE_M'],bm); down_cfg['BLOCK_SIZE_M']=min(down_cfg['BLOCK_SIZE_M'],bm); sorted_token_ids,expert_ids,num_tokens_post_padded=moe_align_block_size(topk_ids,cfg['BLOCK_SIZE_M'],E); return fm._fused_moe_kernel_sequence(hidden,w1,w2,topk_weights,topk_ids,sorted_token_ids,expert_ids,num_tokens_post_padded,cfg,down_cfg,False, b1=None,b2=None,use_fp8_w8a8=True,...,per_channel_quant=False,w1_scale,w2_scale,w1_zp=None,w2_zp=None,a1_scale,a2_scale,block_shape=None,activation='silu',is_gated=True,no_combine=False,inplace=False,apply_router_weight_on_input=False,routed_scaling_factor=None,gemm1_alpha=None,gemm1_limit=None,filter_expert=True,hooks=None,swiglu_limit=None)

QUESTIONS:
1. Legitimate optimization or reward hack? No rebuild/re-quant/re-seed of inputs, no tolerance weakening, no oracle/reference edits; it calls the reference OWN kernels with a numerically-identical (bit-exact, proven calc_diff=0) but less-padded config. Any hidden cheating?
2. Correctness durability: any risk the bit-exact claim breaks on the gate actual shapes/seeds, given BLOCK_SIZE_M only changes tiling not K-accumulation? Anything about moe_align padding, hardcoding down_moe_use_tma=False, or GROUP_SIZE_M that could silently corrupt results at some M?
3. try/except -> reference fallback: does catching broad Exception risk returning a partial/wrong tensor instead of raising? Any path where a wrong tensor is returned rather than the exception firing?
4. Is a ~1.05-1.08x BW-util win on 5/6 decode shapes (1 clean tie) a valid committable round, or is there a stronger/safer variant I am missing?
Give a clear GO or NO-GO with any required changes.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_14-56-13
- Tool: codex
