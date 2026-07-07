# gqa_ragged_prefill_causal_h32_kv8_d128

## Search Findings

Last updated: 2026-07-07T06:26:30.783Z

## Search Findings

### Scope

This update is task-specific for `gqa_ragged_prefill_causal_h32_kv8_d128` on H800 / Hopper SM90: BF16 `q/k/v`, 32 Q/O heads, 8 KV heads, head_dim 128, ragged `qo_indptr`/`kv_indptr`, causal prefill, BF16 output, and FP32 base-2 LSE shaped `[total_q, 32]`.

### Supported reference kernels and applicability

- [unverified] **FlashInfer is the closest semantic match.** `flashinfer.prefill.BatchPrefillWithRaggedKVCacheWrapper` accepts packed ragged Q/K/V via `qo_indptr` and `kv_indptr`, supports `causal=True`, `return_lse=True`, `num_qo_heads`/`num_kv_heads` GQA where Q heads are a multiple of KV heads, and returns output plus LSE shaped `[qo_indptr[-1], num_qo_heads]`. This directly matches the task interface except for submission packaging.
- [unverified] **FlashAttention varlen is a strong semantic reference, not a drop-in LSE match.** `flash_attn_varlen_func` consumes `cu_seqlens_q`/`cu_seqlens_k`, supports BF16, head_dim <= 256, causal masking, arbitrary Q/K lengths, and MQA/GQA by passing fewer KV heads than Q heads. Its LSE layout/convention must be checked or converted: the Python interface exposes `softmax_lse` as `[num_heads, total_q]`, while this task wants `[total_q, 32]` and base-2 LSE.
- [unverified] **Causal alignment is bottom-right, not top-left.** FlashAttention documents that when `seqlen_q != seqlen_k`, causal masks align to the bottom-right corner. The task reference implements the same rule with `delta = kv_len - q_len` and legal keys `kv_pos < local_q + 1 + delta`.
- [unverified] **GQA should be indexed, not materialized.** FlashAttention documents that KV heads are fewer than Q heads and Q heads in each group attend to one KV head. For this task use `kv_head = q_head / 4` for h32/kv8. Do not expand K/V to 32 heads in memory.
- [unverified] **Open CUTLASS/Triton evidence is weaker for this exact H800 path.** FlashAttention-3 uses Hopper WGMMA/TMA/CUTLASS abstractions, and `hopper/tile_size.h` returns a 128x128 forward tile for element_size=2, head_dim<=128, causal/local/paged cases. However, the reviewed sources did not establish a standalone open CUTLASS or CUDA-Triton H800 ragged causal GQA prefill kernel with this task's return-LSE contract. FlashAttention's documented Triton backend is ROCm/AMD, not CUDA H800.
- [unverified] **cuDNN can be a correctness/performance comparator, not an open submission kernel.** NVIDIA cuDNN documents Hopper BF16 ragged/paged SDPA with MHA/MQA/GQA, masking, deterministic support, d<=256, and stats tensors. It is closed-library evidence and its stats layout/base must be adapted before comparing to this task.

### H800 scheduling and tiling implications

- [unverified] FlashInfer's paper separates compile-time tile selection from runtime scheduling. It stores Q/O as ragged tensors, selects query tile size from average query length and resource constraints, splits long KV work into chunks, sorts chunks by length/cost, and merges partial attention states. This is the most relevant published design for ragged load imbalance.
- [unverified] FlashInfer's load-balanced scheduler uses persistent kernels and fixed workspace regions so split-KV partial outputs and scheduler metadata remain CUDA-Graph compatible. If split-K is tried here, merge partial states deterministically in a fixed order and keep LSE/output state in FP32.
- [locally-tested] Existing H800 candidate history shows the long tail dominates this task. Latest recorded `pair2_init_guard` passed 21/21 with mean 2.299679 ms, p90 15.417104 ms, max 15.809776 ms; reference speedup is explicitly ignored in `benchmark.csv`.
- [locally-tested] NCU evidence for the clean long-row pair2 path (`longkv_pair2_profiled`) shows SM throughput about 83%, DRAM throughput below 0.5%, zero barrier stalls, about 18% active warps, and 158 registers/thread on the two highest-latency long rows. This supports focusing on scalar online-softmax/SFU scheduling and register pressure rather than DRAM bandwidth.
- [rejected] The pair1 occupancy variant reduced registers/thread from 158 to 108 and raised active warps to about 24%, but it doubled CTA work and lost mean/p90/max versus pair2. Do not promote pair1 merely for occupancy.
- [locally-tested] Earlier long-row profiling found the baseline grouped kernel was not DRAM-bound and paid shared-memory barrier/scoreboard costs. Direct warp-local K/V loads and four-warps-per-CTA grouped-head sharing improved long rows while preserving full legal-KV scans.
- [sound inference] For this operator, a conservative H800 path is: short rows use a lightweight direct kernel; long rows use pair2/shared-KV grouping with runtime length thresholds derived only from `qo_indptr`/`kv_indptr`; only revisit split-KV if profiles show load imbalance after current pair2/SFU work.

### Numerics and exact task contract

- [locally-tested] The task reference converts Q/K/V to FP32, computes logits and online softmax in FP32, writes BF16 output, and stores LSE as `torch.logsumexp(logits) / log(2)` in FP32. Output initialization is zero and LSE initialization is `-inf`.
- [unverified] FlashInfer's maintainer confirmed default returned LSE is base-2 (`log2(sum(exp2(...)))`), while FlashAttention/FA3 comparisons may use natural-log LSE. Convert natural log to base-2 or use an exp2/log2 internal path consistently.
- [sound inference] If using exp2 internally, multiply logits by `log2(e)` before `exp2`, maintain `(m, sum, acc)` in FP32, store `lse = m + log2(sum)`, and cast only the final output vector to BF16.
- [sound inference] Split-K or split-Q merges must compose attention states, not average outputs. Merge each partial `(m, sum, acc)` with a stable deterministic order; atomics over partial outputs/LSE are a correctness risk.

### Correctness and reward-hack risks

- [locally-tested] Causal bound must be `allowed_end = min(kv_len, local_q + 1 + (kv_len - q_len))`. Top-left `tril` is wrong when `kv_len != q_len`.
- [locally-tested] Every active `(sequence, query token, q_head)` must scan all legal keys `[0, allowed_end)`. Do not skip legal positions to match known long rows.
- [locally-tested] LSE must be base-2 FP32 with shape `[total_q, 32]`; natural-log LSE, transposed FlashAttention LSE layout, dummy LSE, or stale LSE can fail independently of output.
- [locally-tested] Runtime dispatch may use tensor shapes and indptr-derived lengths. It must not use workload UUIDs, row numbers, safetensor paths, evaluator paths, trace/profile paths, pointer identity, random seeds, call-stack inspection, or precomputed outputs.
- [unverified] Blackwell-only ideas such as FlashInfer CuTe DSL SM100+ paths, SM100a/SM110a CUTLASS FMHA guards, FA4 TMEM/2-CTA designs, and NVFP4 kernels are inspiration only until revalidated on H800.

### Sources

- FlashInfer attention API docs: https://docs.flashinfer.ai/api/attention.html
- FlashInfer `prefill.py`: https://raw.githubusercontent.com/flashinfer-ai/flashinfer/main/flashinfer/prefill.py
- FlashInfer paper: https://arxiv.org/pdf/2501.01005
- FlashInfer LSE base issue: https://github.com/flashinfer-ai/flashinfer/issues/2113
- FlashAttention README: https://github.com/Dao-AILab/flash-attention
- FlashAttention Python interface: https://raw.githubusercontent.com/Dao-AILab/flash-attention/main/flash_attn/flash_attn_interface.py
- FlashAttention Hopper tile sizes: https://raw.githubusercontent.com/Dao-AILab/flash-attention/main/hopper/tile_size.h
- FlashAttention-3 Hopper blog: https://tridao.me/blog/2024/flash3/
- NVIDIA cuDNN Attention docs: https://docs.nvidia.com/deeplearning/cudnn/latest/operations/Attention.html
- Local task contract: `tasks/005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128/definition.json`
- Local workload and benchmark evidence: `tasks/005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128/workload.jsonl`, `tasks/005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128/benchmark.csv`
- Local H800 profiles: `tasks/005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128/profile/profiled_longkv_tile/20260701Tprofiled_longkv_tile/REPORT.md`, `.../longkv_pair2_profiled/20260702Tlongkv_pair2_profiled/REPORT.md`, `.../longkv_pair1_occ/20260702T143156_pair1_occ/REPORT.md`
