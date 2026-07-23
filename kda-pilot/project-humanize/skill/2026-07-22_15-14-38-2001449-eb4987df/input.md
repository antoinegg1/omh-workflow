# Ask Codex Input

## Question

Review this GLM-5.2 kernel-harness candidate diff AND its official benchmark evidence for correctness / reward-hacking risk, then give a GO/NO-GO for committing this round. NOTE: your filesystem/sandbox may be unavailable; if so, review purely from the inline evidence below (all files quoted in full) and say so.

CONTEXT
- Repo: kernel-harness-amd. Target task THIS round: moe_total_prefill (GLM-5.2 fused MoE, PREFILL phase, AMD MI300X / ROCm gfx942, fp8_e4m3 w8a8). prefill_M in {1024,2048,4096}.
- Frozen taskset tasksets/glm52_rocm_local.json + evaluator evaluate_glm52_taskset.py (metric roofline_mfu_bw) are the ONLY authority. Only file edited this round: testbench/tasks/glm52/moe_total_prefill/candidate.py. No oracle/harness/reference/taskset files touched.
- Correctness gate = FlashMLA 3-layer check culminating in DeepGEMM calc_diff <= 5e-6 (very tight, scale-sensitive).
- Prefill is COMPUTE-BOUND here: evaluator reports primary_util == mfu at every shape (bw_util tiny 0.04-0.08).

PRIOR ESTABLISHED FACT (round 0, same op decode phase): the fp8 intermediate activation saturates (act amax ~76288 vs FP8_MAX 224, ~45% clamp), so NO reimplementation of the fp8 MoE can pass calc_diff<=5e-6 — proven by feeding the reference's EXACT intermediate_cache2 into an independent a2-quant+gemm2 and still getting calc_diff 3.15e-2 (~3000x over gate). The ONLY correctness-safe lever is to drive the reference's OWN Triton kernels (_fused_moe_kernel_sequence) with a numerically-identical but faster launch config.

THE OPTIMIZATION (this round, prefill)
Prefill is dense-degenerate (top_k==num_experts==8, topk_ids==arange(8) => every token routes to every expert). The reference's resolver (try_get_optimal_moe_config) returns GROUP_SIZE_M=32 for all three prefill M. GROUP_SIZE_M is the Triton L2-swizzle grouping: it only reorders WHICH (m,n) output tile each program computes for L2 locality; it NEVER changes the per-output-element fp32 K-accumulation (that is BLOCK_SIZE_K, left untouched). So overriding it is bit-exact.

The candidate:
1. calls sglang's OWN try_get_optimal_moe_config to get the reference's resolved config (BLOCK_SIZE_M/N/K, num_warps, num_stages, waves_per_eu all kept as tuned),
2. overrides ONLY GROUP_SIZE_M on both gemm1 cfg and down cfg to: 1 if M<=1024 else 4,
3. if the resolver already picked that GROUP_SIZE_M, raises -> reference fallback (no-op case),
4. recomputes moe_align_block_size with the UNCHANGED BLOCK_SIZE_M,
5. calls sglang's OWN _fused_moe_kernel_sequence directly with the reference's exact fp8 args.
run() wraps the fast path in try/except -> untouched reference on any surprise.

STANDALONE BIT-EXACT SWEEP (event-timed, run_cfg vs run_cfg so wrapper overhead cancels; calc_diff measured against reference output):
  M=1024: default GM=32; GM=1 -> calc_diff 0.00e+00, ratio_vs_default 1.146x (GM=4 1.067x)
  M=2048: default GM=32; GM=4 -> calc_diff 0.00e+00, ratio_vs_default 1.057x (GM=1 1.042x); GM=1,BN=128 REGRESSES to 0.956x (so I do NOT touch BN)
  M=4096: default GM=32; GM=4 -> calc_diff 0.00e+00, ratio_vs_default 1.020x (GM=1 1.013x)
All variants calc_diff==0.00e+00 (bit-exact).

OFFICIAL EVALUATOR RESULTS (evaluate_glm52_taskset.py --task moe_total_prefill --repeat 10 --iterations 30 --warmup 3; metric roofline_mfu_bw, primary_util=MFU; ratio=candidate/reference; conservative=geomean_primary_util_ratio_conservative; CUPTI cold-L2 device-kernel median):
  M=1024: passed  mfu=0.2463 tflops=644.2 bw_gbps=445.6 ratio=1.1474 conservative=1.0634 correct=True
  M=2048: passed  mfu=0.2704 tflops=706.9 bw_gbps=316.4 ratio=1.0553 conservative=1.0046 correct=True
  M=4096: passed  mfu=0.2787 tflops=728.9 bw_gbps=237.3 ratio=1.0460 conservative=1.0021 correct=True
  summary: passed=3, correct_not_faster=0, incorrect=0, infra_failed=0, total=3. All correct AND faster; 0 regressions.

FULL candidate.py (only file changed; docstring trimmed here):
```python
OP='moe_total'; PHASE='prefill'
def _pick_group_size_m(m):
    return 1 if m <= 1024 else 4
def _fast_moe_total_prefill(inputs):
    hidden=inputs['hidden_states']; w1=inputs['w1']; w2=inputs['w2']
    topk_weights=inputs['topk_weights']; topk_ids=inputs['topk_ids']
    w1_scale=inputs['w1_scale']; w2_scale=inputs['w2_scale']; a1_scale=inputs['a1_scale']; a2_scale=inputs['a2_scale']
    E,N,_=w1.shape; M=hidden.shape[0]; topk=topk_ids.shape[1]
    if topk != E: raise RuntimeError('non-dense routing; use reference')
    import sglang.srt.layers.moe.moe_runner.triton_utils.fused_moe as fm
    from sglang.srt.layers.moe.moe_runner.triton_utils.moe_align_block_size import moe_align_block_size
    if topk_ids.dtype != torch.int32: topk_ids=topk_ids.to(torch.int32)
    cfg,(down_cfg,_)=fm.try_get_optimal_moe_config(w1.shape,(w2.shape[0],w2.shape[1],w2.shape[2]),topk,'fp8_w8a8',M,block_shape=None,per_channel_quant=False,return_down_config=True)
    cfg=dict(cfg); down_cfg=dict(down_cfg) if down_cfg is not None else None
    gm=_pick_group_size_m(M)
    if cfg.get('GROUP_SIZE_M')==gm and (down_cfg is None or down_cfg.get('GROUP_SIZE_M')==gm):
        raise RuntimeError('resolver GROUP_SIZE_M already optimal; use reference')
    cfg['GROUP_SIZE_M']=gm
    if down_cfg is not None: down_cfg['GROUP_SIZE_M']=gm
    sorted_token_ids,expert_ids,num_tokens_post_padded=moe_align_block_size(topk_ids,cfg['BLOCK_SIZE_M'],E)
    return fm._fused_moe_kernel_sequence(hidden,w1,w2,topk_weights,topk_ids,sorted_token_ids,expert_ids,num_tokens_post_padded,cfg,down_cfg,False,b1=None,b2=None,use_fp8_w8a8=True,use_int8_w8a8=False,use_int8_w8a16=False,use_int4_w4a16=False,per_channel_quant=False,w1_scale=w1_scale,w2_scale=w2_scale,w1_zp=None,w2_zp=None,a1_scale=a1_scale,a2_scale=a2_scale,block_shape=None,activation='silu',is_gated=True,no_combine=False,inplace=False,apply_router_weight_on_input=False,routed_scaling_factor=None,gemm1_alpha=None,gemm1_limit=None,filter_expert=True,hooks=None,swiglu_limit=None)
def run(inputs):
    try: return _fast_moe_total_prefill(inputs)
    except Exception: return glm52_ops.reference(OP,PHASE,inputs)
```

QUESTIONS:
1. Legitimate optimization or reward hack? It does NOT rebuild/re-quantize/re-seed inputs, does NOT weaken tolerances, does NOT touch oracle/reference/taskset. It calls the reference's own kernels with a numerically-identical (bit-exact, proven calc_diff=0) but better-L2-swizzle config. Any hidden cheating?
2. Correctness durability: is GROUP_SIZE_M truly guaranteed bit-exact vs BLOCK_SIZE_K? Is there ANY path where changing only GROUP_SIZE_M (Triton L2 group swizzle) could change fp accumulation/rounding on ROCm (e.g. via matrix_instr_nonkdim/kpack interaction, or masking of padded tiles)? Note: measured calc_diff==0.0 at all three M.
3. The M=2048/4096 conservative ratios are thin (1.0046, 1.0021). Is a ~1.15x win at M=1024 plus two thin-but-positive conservative wins (0 regressions, all correct) a valid committable round, or should I fall back to reference at M=4096 to avoid a marginal claim?
4. Any risk in the broad try/except -> reference fallback masking a wrong result? (kernel seq returns a fresh tensor; on exception we return reference.)
Give a clear GO or NO-GO with any required changes.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_15-14-38
- Tool: codex
