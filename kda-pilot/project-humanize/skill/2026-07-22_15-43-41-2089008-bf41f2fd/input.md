# Ask Codex Input

## Question

Review this GLM-5.2 kernel-harness candidate diff AND its official benchmark evidence for correctness / reward-hacking risk, then give a GO/NO-GO for committing this round. Your review sandbox (bwrap) cannot read files in this environment, so ALL evidence is inline below.

CONTEXT
- Repo: kernel-harness-amd. Target: dsa_prefill_attn (GLM-5.2 DSA sparse MLA attention, prefill, AMD MI300X / ROCm gfx942; M in {1024,2048,4096}).
- Frozen taskset tasksets/glm52_rocm_local.json + evaluator evaluate_glm52_taskset.py (metric roofline_mfu_bw) are the ONLY authority. Only file edited: testbench/tasks/glm52/dsa_prefill_attn/candidate.py (the sanctioned candidate). No oracle/harness/reference/taskset files touched.
- Correctness gate = FlashMLA 3-layer check: (1) inf/nan positions match, (2) elementwise abs_err<abs_tol OR rel_err<0.0157, (3) DeepGEMM calc_diff <= 5e-6 (tight).

BASELINE / REFERENCE DISPATCH (key facts, all measured)
- The task reference AND the original candidate both call sgl_kernel.flash_mla.flash_mla_sparse_fwd(q,kv,indices,sm_scale,d_v).
- On this ROCm build the CUDA sparse_prefill_fwd op is NOT compiled, so flash_mla_sparse_fwd dispatches to sglang's TileLang sparse-MLA kernel (_try_sglang_tilelang_sparse_mla). tilelang IS available in the rocm venv (confirmed). So the REFERENCE output == TileLang kernel output; calc_diff(tilelang, reference)=0.0 trivially.
- The TileLang kernel is SLOW on these shapes (gather-heavy). Measured device-event medians: ~11.7ms (M=1024), ~26ms (2048), ~44ms (4096).
- The harness ALSO contains a pure-torch _sparse_mla_reference (used only if tilelang unavailable). It is 2.5-3x faster (4.0/8.0/16ms) BUT rounds the QK logits to bf16 before softmax, giving calc_diff=6.52e-6 vs tilelang -> JUST OVER the 5e-6 gate (would FAIL).

THE OPTIMIZATION (this candidate)
An independent PyTorch sparse-attention (gather top-2048 KV per query, QK^T, softmax, weighted V over first d_v=512 dims) that is faster than TileLang. The ONLY change vs the naive bf16 torch path is doing the QK score matmul in fp32 (q and gathered KV upcast for the einsum only). That matches the reference's fp32 logits far better: calc_diff drops 6.52e-6 -> 2.88e-6 (inside the 5e-6 gate, ~1.7x margin) while still ~1.9x faster than TileLang. softmax is fp32, probs cast to bf16, P@V matmul in bf16 -- kept exactly as the reference torch structure; only QK precision raised.

Standalone probe (calc_diff vs tilelang reference; ratio = tilelang_us/variant_us):
  M=1024: qk=bf16 pv=bf16 cd=6.524e-6 FAIL 3.57x | qk=fp32 pv=bf16 cd=2.884e-6 PASS 1.96x | qk=fp32 pv=fp32 cd=1.872e-6 PASS 1.56x
  M=2048: qk=bf16 pv=bf16 cd=6.530e-6 FAIL 3.35x | qk=fp32 pv=bf16 cd=2.884e-6 PASS 1.97x
  M=4096: qk=bf16 pv=bf16 cd=6.532e-6 FAIL 3.14x | qk=fp32 pv=bf16 cd=2.883e-6 PASS 1.89x
Chosen variant: qk=fp32, pv=bf16 (best speed with safe gate margin).

OFFICIAL EVALUATOR RESULTS (roofline_mfu_bw; primary_util=MFU; ratio=candidate/reference; repeat=10 iterations=30 warmup=3; CUPTI cold-L2 device-kernel median):
  M=1024: passed  primary_util(MFU)=0.03297  TFLOP/s=43.11  GB/s=33.43  ratio=1.6467  conservative=1.555  correct=True
  M=2048: passed  primary_util(MFU)=0.03256  TFLOP/s=42.57  GB/s=27.51  ratio=1.5619  conservative=1.461  correct=True
  M=4096: passed  primary_util(MFU)=0.03308  TFLOP/s=43.26  GB/s=25.16  ratio=1.3998  conservative=1.199  correct=True
Summary: passed=3, correct_not_faster=0, incorrect=0, infra_failed=0.

FULL DIFF of candidate.py (only file changed; docstring trimmed):
```python
import torch
from sgl_kernel.flash_mla import flash_mla_sparse_fwd

def _fast_sparse_mla_prefill(inputs: dict):
    q = inputs['q']; kv = inputs['kv']; indices = inputs['indices']
    if q.dtype != torch.bfloat16 or kv.dtype != torch.bfloat16:
        raise RuntimeError('unexpected dtype; use reference')
    if q.ndim != 3:
        raise RuntimeError('unexpected q rank; use reference')
    kv2 = kv.view(kv.shape[0], kv.shape[-1])
    idx = indices.view(indices.shape[0], -1).long()
    sm_scale = float(inputs['sm_scale']); d_v = int(inputs['d_v'])
    s_q, n_heads, _ = q.shape; topk = idx.shape[1]
    if idx.shape[0] != s_q:
        raise RuntimeError('indices/query mismatch; use reference')
    out = torch.empty(s_q, n_heads, d_v, dtype=torch.bfloat16, device=q.device)
    chunk = 256 if s_q >= 256 else s_q
    for start in range(0, s_q, chunk):
        end = min(start + chunk, s_q)
        gathered = kv2[idx[start:end].reshape(-1)].view(end - start, topk, -1)
        q_chunk = q[start:end]
        scores = torch.einsum('chd,ckd->chk', q_chunk.float(), gathered.float()) * sm_scale
        probs = torch.softmax(scores, dim=-1).to(torch.bfloat16)
        out[start:end].copy_(torch.einsum('chk,ckd->chd', probs, gathered[..., :d_v]))
    return out

def run(inputs: dict):
    try:
        return _fast_sparse_mla_prefill(inputs)
    except Exception:
        return flash_mla_sparse_fwd(inputs['q'], inputs['kv'], inputs['indices'], inputs['sm_scale'], inputs['d_v'])
```

QUESTIONS:
1. Reward hack or legitimate? It does NOT rebuild/re-quantize/re-seed inputs, does NOT weaken tolerances, does NOT touch oracle/reference/taskset. It is an independent kernel whose output PASSES the official calc_diff<=5e-6 gate against the frozen reference. Note it computes QK in fp32 (MORE precise than the naive bf16 path). Is passing the gate by being more precise (rather than bit-exact) a legitimate way to satisfy correctness here, or does it smell like tuning-to-the-reference? Any hidden cheating?
2. Correctness durability: the gate uses a fixed seed; measured calc_diff=2.88e-6 (~1.7x margin under 5e-6) consistently across all 3 M. Is ~1.7x margin adequate, or should I take qk=fp32 pv=fp32 (cd=1.87e-6, ~2.7x margin) at the cost of dropping the M=1024 win from 1.96x to 1.56x? Any risk the margin collapses on the gate's actual inputs?
3. The try/except -> flash_mla_sparse_fwd fallback: any path where a WRONG tensor is returned instead of raising? (fast path builds a fresh out tensor; on exception we return the untouched reference kernel.)
4. Is a ~1.4-1.65x MFU win on 3/3 prefill shapes (0 regress, 0 incorrect) a valid, committable round? GO or NO-GO with any required changes.

## Configuration

- Model: gpt-5.5
- Effort: xhigh
- Timeout: 5400s
- Timestamp: 2026-07-22_15-43-41
- Tool: codex
