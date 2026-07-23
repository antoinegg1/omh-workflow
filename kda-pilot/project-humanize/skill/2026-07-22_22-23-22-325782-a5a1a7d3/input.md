# Ask Codex Input

## Question

GO/NO-GO — round-6 review fixes for GLM-5.2 ROCm kernel-harness (two [P1] findings). Codex cannot read the repo (bwrap-blocked), so ALL evidence is inline below.

CONTEXT
- Repo kernel-harness-amd, GLM-5.2 on AMD MI300X / ROCm gfx942, fp8_e4m3fnuz. The frozen taskset tasksets/glm52_rocm_local.json + evaluate_glm52_taskset.py (metric roofline_mfu_bw) is the SOLE authority. A "win" = shapes_won>=1 AND shapes_regressed==0. Correctness gate = FlashMLA 3-layer check culminating in DeepGEMM calc_diff<=5e-6.
- Prior rounds: four targets optimized + Codex-verified (moe_total_decode, moe_total_prefill, dsa_prefill_attn, index_score_prefill). Round 4/5 [P1]: the harness DEFAULT backend was cuda-b200, so a bare ./run.sh resolved to B200 where the ROCm device guards correctly fall back to reference (no win). The repo OWNER committed e01d123, flipping the harness default to rocm/amd-mi300x (config.py, registry.py, result_store.py) plus task/problem.json metadata. tasksets/ is byte-for-byte unchanged; wins are peak-invariant (primary_util_ratio = candidate_util/reference_util, both dividing by the same roofline denominator, so the B200->MI300X peak change cancels and cannot manufacture/erase a win). Round 5 already earned an inline-evidence Codex GO on e01d123.
- Round 6 Stop-hook review raised TWO [P1]s that are CONSEQUENCES of the e01d123 default-flip, not defects in the four optimized targets.

======================================================================
[P1] A  (MINE — FIXED, commit baea0bc): index_score_prefill fallback called deep_gemm directly.
======================================================================
BEFORE: module-level 'import deep_gemm'; _reference() called deep_gemm.fp8_mqa_logits(...) directly. Under the now-default ROCm/MI300X backend that risks an import crash on a DeepGEMM-less MI300X runner and does not match the aiter backend named in problem.json.

AFTER — the final testbench/tasks/glm52/index_score_prefill/candidate.py (the ONLY file I edited; it is the sanctioned per-task candidate file, NOT an oracle/harness file). Relevant parts verbatim:

  from __future__ import annotations
  import torch
  from testbench.harness import glm52_ops
  OP = 'index_score'
  PHASE = 'prefill'
  _TARGET_BLOCK_KV = 256
  _TARGET_NUM_STAGES = 1

  def _reference(inputs: dict):
      # Fall back through the harness reference (the selected backend's authoritative
      # oracle), NOT deep_gemm directly. On MI300X glm52_ops.reference dispatches to
      # aiter's fp8_mqa_logits, matching the backend described in problem.json; this
      # also keeps the module import-safe on a ROCm runner without DeepGEMM installed.
      return glm52_ops.reference(OP, PHASE, inputs)

  def _fast_index_score_prefill(inputs: dict):
      from aiter.ops.triton.attention import fp8_mqa_logits as _mqa_mod
      from aiter.ops.triton._triton_kernels.attention.fp8_mqa_logits import _fp8_mqa_logits_kernel
      arch = _mqa_mod.arch
      if arch != "gfx942":
          raise RuntimeError("fast path validated only on gfx942; use reference")
      if _mqa_mod.TRITON_GE_36 and _mqa_mod._gluon_fp8_mqa_logits_kernel is not None:
          raise RuntimeError("gluon kernel active; use reference")
      # ... replicates the reference's fnuz recast + scale compensation + clean_logits=False
      #     output buffer EXACTLY, keeps matrix_instr_nonkdim heuristic verbatim, then:
      _fp8_mqa_logits_kernel[(seq_len,)](... BLOCK_KV=_TARGET_BLOCK_KV, num_warps=4,
          num_stages=_TARGET_NUM_STAGES, waves_per_eu=2, matrix_instr_nonkdim=matrix_instr_nonkdim)
      return logits

  def run(inputs: dict):
      try:
          return _fast_index_score_prefill(inputs)
      except Exception:
          return _reference(inputs)

FACTS:
- The fast path _fast_index_score_prefill is byte-for-byte UNCHANGED by baea0bc. It lazily imports aiter INSIDE the function (so module import no longer needs deep_gemm), guards arch!='gfx942', and launches the reference's OWN Triton kernel with a bit-exact BLOCK_KV=256/num_stages=1 launch-config override. BLOCK_KV changes only the KV-loop tiling, never the per-logit q.k reduction over HEAD_SIZE=128 — standalone probe measured calc_diff==0.00e+00 at M in {1024,2048,4096}.
- Only the fallback body and the module import surface changed, strictly TOWARD the authoritative reference: _reference now returns glm52_ops.reference('index_score','prefill', inputs), the selected backend oracle, which on MI300X dispatches to aiter fp8_mqa_logits (glm52_ops.py:847).
- Persisted official result runs/glm52/index_score_prefill/20260722T084041Z-7a3d33/result.json: 3/3 shapes WON, calc_diff 0.0. The fast path is unchanged so this win still applies on the ROCm scoring runner.
- Validation: python3 -m py_compile OK; grep shows deep_gemm now appears ONLY in docstring/comment prose (0 code references); module imports are torch + testbench.harness.glm52_ops.

QUESTION A: Is the [P1] A fix correct, safe, and NOT a reward hack? Does routing the fallback through glm52_ops.reference (instead of deep_gemm directly) fully resolve the reviewer's finding ("this should fall back through the harness reference instead") while preserving the bit-exact fast-path 3/3 win? Any risk I have missed (e.g., a path where a wrong tensor is returned instead of falling back)?

======================================================================
[P1] B  (OWNER/HARNESS — classified, cannot be agent-fixed): default selects ROCm while the shipped default candidates are CUDA.
======================================================================
- With no KERNEL_HARNESS_* env the default now selects ROCm/MI300X, but 17 of 26 task-local default candidate.py files still 'import deep_gemm' at module level AND call it directly in run() (e.g. q_b_prefill -> deep_gemm.fp8_gemm_nt). On a ROCm runner without DeepGEMM those ./run.sh invocations fail at candidate import. VERIFIED COUNT: exactly 17 module-level importers-and-callers, and ALL 17 are non-target tasks; index_score_prefill is now docstring-only (fixed above); the remaining 8 candidates never reference deep_gemm.
- ROOT: those 17 defaults are GENERATED by testbench/bin/sync_glm52_tasks.py from 4 per-family templates that hardcode 'import deep_gemm' (line 108 "gemm"->fp8_gemm_nt, 130 "moe"->fp8_m_grouped_gemm_nt_masked, 151 "score_prefill"->fp8_mqa_logits, 161 "score_decode"->fp8_paged_mqa_logits). candidate.py is "NEVER overwritten if it already exists" (sync line 12), so regeneration requires the owner's --force-candidate. The generator and registry.py:48 (default backend) are harness files OUTSIDE my permitted edit scope; the 17 tasks are OUTSIDE my plan's four targets.
- Reviewer's named remedy: "either keep CUDA as the default until the candidates are ported, or regenerate the default candidates to call the selected backend reference."
- MY CLASSIFICATION: [P1] B is owner/harness-owned. I should NOT (a) edit the forbidden generator/registry files, nor (b) hand-edit the 17 non-target generated candidates — because a hand-edit diverges from the generator template and gets wiped by the next --force-candidate, and touching 17 non-plan tasks is scope drift. Proposed OWNER remedy: repoint the 4 sync_glm52_tasks.py templates at the backend-agnostic glm52_ops.reference(op, phase, inputs) (drop the hard deep_gemm import), then run sync_glm52_tasks.py --force-candidate to regenerate the 17 defaults — mirroring the index_score_prefill fix. The alternative (keep CUDA default in registry.py) re-opens the round-4/5 [P1], so regeneration is the coherent path.

QUESTION B: Is my classification of [P1] B as owner/harness-owned correct? Specifically: is it right that I should surface it to the owner with the regenerate remedy rather than hand-edit the 17 non-target generated candidates or the forbidden generator/registry files? Is the proposed owner remedy sound? And are the four TARGET wins valid REGARDLESS of [P1] B — since all four fast paths engage on the ROCm scoring runner, index_score's is unchanged, and [P1] B is only about the OTHER 17 non-target candidates' import-safety, not the four targets' correctness or measured ratios?

======================================================================
QUESTION C: With [P1] A fixed at root (baea0bc) and [P1] B correctly delegated to the owner, is there ANY correctness or reward-hacking risk that blocks FINALIZING round 6 on the AGENT's side? I will not select target #5. Give a clear GO or NO-GO with any required changes.

## Configuration

- Model: gpt-5.5
- Effort: high
- Timeout: 3600s
- Timestamp: 2026-07-22_22-23-22
- Tool: codex
