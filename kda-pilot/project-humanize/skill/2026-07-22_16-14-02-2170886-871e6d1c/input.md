# Ask Codex Input

## Question

Review this GLM-5.2 kernel-harness candidate diff AND its official benchmark evidence for correctness / reward-hacking risk, then give a clear GO or NO-GO for committing this round.

CONTEXT
- Repo: kernel-harness-amd. Target task: index_score_prefill (GLM-5.2 indexer score / MQA logits, prefill; AMD MI300X / ROCm gfx942). M in {1024,2048,4096}.
- Frozen taskset tasksets/glm52_rocm_local.json + evaluator testbench/bin/evaluate_glm52_taskset.py (metric roofline_mfu_bw, primary_util = MFU) are the ONLY authority. Only file edited: testbench/tasks/glm52/index_score_prefill/candidate.py (the sanctioned candidate). No oracle/harness/reference/taskset files touched.
- Correctness gate = FlashMLA 3-layer check culminating in DeepGEMM calc_diff <= 5e-6.

WHAT THE REFERENCE ACTUALLY IS (evidence)
- The task's default candidate / reference is deep_gemm.fp8_mqa_logits(q_fp8,(k_fp8,k_scale),weights,ks,ke,clean_logits=False). On this ROCm build that dispatches to aiter's Triton kernel aiter.ops.triton.attention.fp8_mqa_logits.
- I timed the reference (deep_gemm.fp8_mqa_logits) directly: 2.01 / 15.09 / 29.17 ms at M=1024/2048/4096 — i.e. the reference IS the slow aiter Triton kernel, not a faster path.
- On gfx942 that aiter function's LDS-occupancy heuristic (_gfx942_tile_fits_lds) predicts the default (BLOCK_KV=128, num_stages=2) tile will not keep two workgroups co-resident, so it DROPS to BLOCK_KV=64, num_stages=1. The grid is (seq_len,) — one program per query row — so the KV loop over seq_len_kv=65536 dominates; a 64-wide tile serialises it badly.

THE OPTIMIZATION (this candidate)
- Calls the reference's OWN Triton kernel _fp8_mqa_logits_kernel directly with the reference's EXACT preprocessing (same fnuz recast + scale compensation copied verbatim; same clean_logits=False torch.empty output buffer with the same seq_len_kv_aligned slice and strides; same matrix_instr_nonkdim heuristic = 16 if seq_len<=1024 else 32), overriding ONLY the launch tile to BLOCK_KV=256, num_stages=1 (num_warps=4, waves_per_eu=2 unchanged from the reference).
- weights arrives 3D (M,32,1); I squeeze the trailing unit dim to (M,32) — same view the reference deep_gemm path uses internally (the kernel wants [seq_len,NUM_HEADS]).
- BLOCK_KV changes how many keys each program processes per inner iteration; it does NOT change the per-logit reduction (the q.k dot is over HEAD_SIZE=128, accumulated identically). num_stages/num_warps/waves_per_eu are pure scheduling. matrix_instr_nonkdim (MFMA shape) is kept EXACTLY at the reference heuristic value.
- Guards: fast path runs only on gfx942, only when not-gluon, only power-of-2 heads/head_size, Q rank 3, and only when the heuristic does NOT already resolve to the large tile; ANY exception falls back to the untouched deep_gemm.fp8_mqa_logits reference via try/except.

STANDALONE PROBE (my harness build, glm52_ops.build_inputs, event-timed):
  M=1024: fast path runs, calc_diff=0.000e+00 (bit-exact), t_ref=2.01ms t_fast=1.31ms ratio 1.538
  M=2048: calc_diff=0.000e+00, t_ref=15.09ms t_fast=3.92ms ratio 3.849
  M=4096: calc_diff=0.000e+00, t_ref=29.17ms t_fast=7.77ms ratio 3.752
(An earlier bug: I forgot to squeeze 3D weights, so the fast path raised and silently fell back to reference → the first official run reported correct_not_faster ratio~1.0 on all 3. After the squeeze fix the fast path runs. This is why I double-checked calc_diff==0 and the fallback.)

OFFICIAL EVALUATOR RESULTS (metric roofline_mfu_bw, primary_util = MFU; ratio = candidate/reference):
  M=1024: passed  ratio 1.5573 (conservative 1.5353)  correct=True  mfu 0.1598  tflops 418.0  bw_gbps 214.0
  M=2048: passed  ratio 3.8931 (conservative 3.8471)  correct=True  mfu 0.1068  tflops 279.3  bw_gbps 140.8
  M=4096: passed  ratio 3.7618 (conservative 3.6944)  correct=True  mfu 0.1077  tflops 281.7  bw_gbps 140.9
Summary: passed=3, correct_not_faster=0, incorrect=0, infra_failed=0. All 3 shapes correct AND faster, 0 regressions.

FULL DIFF (only file changed):
diff --git a/testbench/tasks/glm52/index_score_prefill/candidate.py b/testbench/tasks/glm52/index_score_prefill/candidate.py
index 2596a92..b396a1d 100644
--- a/testbench/tasks/glm52/index_score_prefill/candidate.py
+++ b/testbench/tasks/glm52/index_score_prefill/candidate.py
@@ -27,15 +27,159 @@ abs_err < abs_tol OR rel_err < 0.0157, then DeepGEMM's calc_diff
 Baseline to beat: the call below, timed CUPTI cold-L2 on these same inputs.

     ./run.sh
+
+
+OPTIMIZATION (bit-exact launch-config override
+==============================================
+The reference `deep_gemm.fp8_mqa_logits(...)` on this ROCm build dispatches to
+aiter's Triton kernel `aiter.ops.triton.attention.fp8_mqa_logits`. On gfx942
+(MI300X) that function's LDS-occupancy heuristic conservatively drops the KV
+tile to `BLOCK_KV=64, num_stages=1` (it predicts the default 128/2 tile would
+not keep two workgroups co-resident on a CU). That tile is drastically
+under-utilised on the prefill shapes here — the grid is `(seq_len,)` (one
+program per query row) so the KV loop dominates, and a 64-wide tile serialises
+it badly at seq_len_kv=65536.
+
+This candidate calls the reference's OWN Triton kernel (`_fp8_mqa_logits_kernel`)
+with the reference's EXACT preprocessing (same fnuz recast + scale
+compensation, same clean_logits=False output buffer, same strides, same
+`matrix_instr_nonkdim` heuristic), overriding ONLY the launch tile to
+`BLOCK_KV=256, num_stages=1`. BLOCK_KV changes how many keys each program
+processes per inner iteration — it does NOT change the per-logit reduction
+(the q·k dot is over HEAD_SIZE=128, accumulated identically regardless of
+tile), and num_stages/num_warps/waves_per_eu are pure scheduling. Standalone
+probe measured `calc_diff == 0.00e+00` (bit-exact) at M in {1024, 2048, 4096}
+while running 1.4x (M=1024) to ~3.8x (M=2048) faster than the heuristic tile.
+
+run() wraps the fast path in try/except and falls back to the untouched
+reference call on any surprise (unexpected arch, gluon kernel active, shape or
+dtype mismatch, or if the heuristic already resolves to the target tile).
 """
 from __future__ import annotations

+import torch
+
 import deep_gemm


-def run(inputs: dict):
-    # Starting point: the reference call itself — correct, speedup ~1.0. Replace it.
+# Bit-exact launch-config override, tuned per the standalone sweep. BLOCK_KV /
+# num_stages only change the KV-loop tiling and pipelining, never the q.k
+# reduction, so calc_diff stays 0.00e+00 vs the heuristic tile.
+_TARGET_BLOCK_KV = 256
+_TARGET_NUM_STAGES = 1
+
+
+def _reference(inputs: dict):
     return deep_gemm.fp8_mqa_logits(
         inputs["q_fp8"], (inputs["k_fp8"], inputs["k_scale"]), inputs["weights"],
         inputs["ks"], inputs["ke"], clean_logits=False,
     )
+
+
+def _fast_index_score_prefill(inputs: dict):
+    from aiter.ops.triton.attention import fp8_mqa_logits as _mqa_mod
+    from aiter.ops.triton._triton_kernels.attention.fp8_mqa_logits import (
+        _fp8_mqa_logits_kernel,
+    )
+
+    arch = _mqa_mod.arch
+    if arch != "gfx942":
+        raise RuntimeError("fast path validated only on gfx942; use reference")
+    # The gluon path computes its own config we don't override; defer to
+    # reference so we never silently change its kernel.
+    if _mqa_mod.TRITON_GE_36 and _mqa_mod._gluon_fp8_mqa_logits_kernel is not None:
+        raise RuntimeError("gluon kernel active; use reference")
+
+    Q = inputs["q_fp8"]
+    KV = inputs["k_fp8"]
+    kv_scales = inputs["k_scale"]
+    weights = inputs["weights"]
+    cu_starts = inputs["ks"]
+    cu_ends = inputs["ke"]
+
+    if Q.ndim != 3:
+        raise RuntimeError("unexpected Q rank; use reference")
+    # The kernel wants weights as [seq_len, NUM_HEADS] (2D). The frozen input is
+    # [seq_len, NUM_HEADS, 1]; the reference deep_gemm path squeezes the trailing
+    # unit dim internally — replicate that view here (no data change).
+    if weights.ndim == 3 and weights.shape[-1] == 1:
+        weights = weights.squeeze(-1)
+    if weights.ndim != 2:
+        raise RuntimeError("unexpected weights rank; use reference")
+    seq_len, num_heads, head_size = Q.shape
+    seq_len_kv = KV.shape[0]
+    if num_heads & (num_heads - 1) != 0 or head_size & (head_size - 1) != 0:
+        raise RuntimeError("num_heads/head_size not power of 2; use reference")
+
+    # Guard: if the reference heuristic already resolves to (or below) the
+    # target tile there is no bit-exact win to take — defer.
+    if _mqa_mod._gfx942_tile_fits_lds(
+        block_kv=128, head_size=head_size, num_stages=2, occupancy=2
+    ):
+        raise RuntimeError("heuristic already uses the large tile; use reference")
+
+    # --- replicate the reference's clean_logits=False output buffer exactly ---
+    aligned_size = 256
+    seq_len_kv_aligned = (seq_len_kv + aligned_size - 1) // aligned_size * aligned_size
+    logits = torch.empty(
+        (seq_len, seq_len_kv_aligned), dtype=torch.float32, device=Q.device
+    )[:, :seq_len_kv]
+
+    # --- replicate the reference's fnuz recast + scale compensation exactly ---
+    _fnuz = torch.float8_e4m3fnuz
+    convert_q_fn = Q.dtype != _fnuz
+    convert_kv_fn = KV.dtype != _fnuz
+    scale_mul = 1.0
+    if convert_q_fn:
+        scale_mul *= 2.0
+        Q = (Q.to(torch.float32) * 0.5).to(_fnuz)
+    if convert_kv_fn:
+        scale_mul *= 2.0
+        KV = (KV.to(torch.float32) * 0.5).to(_fnuz)
+    if scale_mul != 1.0:
+        kv_scales = kv_scales.to(torch.float32) * scale_mul
+
+    # matrix_instr_nonkdim: keep the reference heuristic verbatim (it selects the
+    # MFMA instruction shape, which we must NOT change to stay bit-exact).
+    matrix_instr_nonkdim = 16 if seq_len <= 1024 else 32
+
+    stride_q_s, stride_q_h, stride_q_d = Q.stride()
+    stride_kv_s, stride_kv_d = KV.stride()
+    stride_w_s, stride_w_h = weights.stride()
+    stride_logits_s, stride_logits_k = logits.stride()
+
+    _fp8_mqa_logits_kernel[(seq_len,)](
+        Q_ptr=Q,
+        KV_ptr=KV,
+        kv_scales_ptr=kv_scales,
+        weights_ptr=weights,
+        cu_start_ptr=cu_starts,
+        cu_end_ptr=cu_ends,
+        logits_ptr=logits,
+        seq_len=seq_len,
+        seq_len_kv=seq_len_kv,
+        NUM_HEADS=num_heads,
+        HEAD_SIZE=head_size,
+        stride_q_s=stride_q_s,
+        stride_q_h=stride_q_h,
+        stride_q_d=stride_q_d,
+        stride_kv_s=stride_kv_s,
+        stride_kv_d=stride_kv_d,
+        stride_w_s=stride_w_s,
+        stride_w_h=stride_w_h,
+        stride_logits_s=stride_logits_s,
+        stride_logits_k=stride_logits_k,
+        BLOCK_KV=_TARGET_BLOCK_KV,
+        num_warps=4,
+        num_stages=_TARGET_NUM_STAGES,
+        waves_per_eu=2,
+        matrix_instr_nonkdim=matrix_instr_nonkdim,
+    )
+    return logits
+
+
+def run(inputs: dict):
+    try:
+        return _fast_index_score_prefill(inputs)
+    except Exception:
+        return _reference(inputs)

QUESTIONS:
1. Is this a legitimate optimization or a reward hack? It does NOT rebuild/re-quantize/re-seed inputs, does NOT weaken tolerances, does NOT touch oracle/reference/taskset. It calls the reference's own Triton kernel with a numerically-identical (bit-exact, proven calc_diff=0) but larger KV tile. Any hidden cheating?
2. Correctness durability: given BLOCK_KV/num_stages only change KV-loop tiling+pipelining (not the HEAD_SIZE=128 dot reduction) and matrix_instr_nonkdim is kept at the reference heuristic, is calc_diff==0 durable across the gate's shapes/seeds? Any risk from BLOCK_KV=256 vs seq_len_kv=65536 tail masking, the clean_logits=False empty-buffer replication, or ks/ke ranges (they are full-range 0..65536 here so no out-of-range positions)?
3. The weights.squeeze(-1): I squeeze a 3D (M,32,1) to (M,32) for the kernel launch — is that a safe view matching what the reference does internally, or could it change the measured problem?
4. The try/except -> reference fallback: any path where a wrong tensor is returned instead of raising? (_fp8_mqa_logits_kernel writes into a fresh logits buffer; on exception we return the untouched reference.)
5. Is a 1.56x-3.89x MFU win on 3/3 prefill shapes, bit-exact, a valid committable round?
Give a clear GO or NO-GO with any required changes.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_16-14-02
- Tool: codex
