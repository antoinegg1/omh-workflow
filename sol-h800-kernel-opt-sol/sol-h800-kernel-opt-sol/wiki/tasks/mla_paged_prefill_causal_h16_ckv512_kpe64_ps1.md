# mla_paged_prefill_causal_h16_ckv512_kpe64_ps1

## Search Findings

Last updated: 2026-07-07T05:52:17.279Z

## Search Findings

### H800/SM90 scope

- **Status: locally-tested.** This operator is BF16 DeepSeek-style MLA paged causal prefill: `q_nope[total_q,16,512]`, `q_pe[total_q,16,64]`, `ckv_cache[num_pages,1,512]`, `kpe_cache[num_pages,1,64]`, token-page `kv_indices`, BF16 `output[total_q,16,512]`, and FP32 base-2 `lse[total_q,16]` (`definition.json`).
- **Status: locally-tested.** The workload mixes tiny rows with long tails up to `total_q=16384`. Current best local H800 evidence (`workflow_20260702043539`) passes 38/38 with median `0.192728 ms`, mean `40.070907 ms`, p90 `54.783402 ms`, max `884.958313 ms`; tail latency, not p50, is the unresolved issue (`workload.jsonl`, `benchmark.csv`).
- **Status: locally-tested.** The task reference computes logits as `q_nope @ ckv.T + q_pe @ kpe.T`, applies causal offset `prefix_len = kv_len - q_len`, computes base-2 LSE, and accumulates values from `ckv` only; `kpe64` is key-only, not part of `V` (`definition.json`).

### Public-kernel fit

- **Status: unverified source fact.** The closest public semantic match is `flashinfer.mla.BatchMLAPagedAttentionWrapper`: it exposes `q_nope`, `q_pe`, `ckv_cache`, `kpe_cache`, `qo_indptr`, `kv_indptr`, `kv_indices`, `page_size`, `causal`, `sm_scale`, `return_lse`, and `return_lse_base_on_e`. Its docs state it can be used for decode and incremental prefill; default returned LSE is base-2, matching this task. It also reserves workspace for split-K intermediate attention results.
- **Status: unverified source fact.** `flashinfer.mla.trtllm_batch_decode_with_kv_cache_mla` is documented and tracked in FlashInfer issue #2877 as usable for both decode and prefill, and current docs include flattened-query `cum_seq_lens_q` support. It is not a drop-in for this task because it uses concatenated query/KV layouts plus block/page-table conventions rather than separate `q_nope/q_pe` and `ckv/kpe` task tensors.
- **Status: unverified source fact.** SGLang's MLA backend matrix lists native page sizes: FlashInfer MLA `1`, FlashMLA `64`, Cutlass MLA `128`, and TRTLLM/CuteDSL/TokenSpeed MLA as Blackwell backends with page size `32` or `64`. For this H800 BF16 page_size=1 task, FlashInfer is direct; FlashMLA/Cutlass/Blackwell kernels are reference material, not direct candidates.
- **Status: unverified source fact.** FlashMLA sparse prefill supports SM90/SM100 and H800 performance claims, but its public API is sparse/top-k (`q[s_q,h_q,d_qk]`, `kv[s_kv,h_kv,d_qk]`, `indices[s_q,h_kv,topk]`), has no batch dimension, and is not a dense causal paged-varlen ps=1 prefill replacement.

### Online-softmax and split-K implications

- **Status: unverified source fact.** FlashInfer `cascade.merge_state(v_a,s_a,v_b,s_b)` merges attention outputs and logsumexp states from two KV segments into exact merged output/LSE. FlashInfer MLA can return base-e LSE for cascade compatibility (`return_lse_base_on_e=True`) or base-2 by default. For this task, either keep all custom partial states in base-2 algebra or merge in base-e and divide final LSE by `ln(2)` before returning.
- **Status: sound inference.** A tail-focused H800 candidate should split long KV/query work into exact partial states `(m, l, O)` and merge with online-softmax algebra. The merge must update max, denominator, and weighted output; summing partial `O` tensors or summing LSEs is incorrect.
- **Status: unverified source fact.** FlashMLA's SM90 sparse prefill source uses `B_H=64`, `B_TOPK=64`, `NUM_THREADS=384`, TMA for Q and output store, `cp.async` for KV movement, `exp2f` online softmax, FP32 accumulators, and BF16 output stores. It splits the 512-value output across two warpgroups as 256-channel halves, then normalizes and converts to BF16.
- **Status: unverified source fact with conflict noted.** FlashMLA README describes sparse-prefill LSE in base-2, but the SM90 source writes `final_lse = logf(rL) + rM * ln(2)` and tests compare that behavior. Treat FlashMLA sparse-prefill LSE as natural-log unless a specific revision is locally verified; this task requires base-2.

### SM90/H800 knobs worth trying here

- **Status: unverified source fact.** FlashMLA's deep dive explains the pressure point: a `64 x 512` FP32 output accumulator consumes `32768` registers, and an SM has `65536` 32-bit registers, so the kernel cannot keep two full output matrices resident. Its seesaw schedule splits `O` into `64 x 256` halves, overlaps Tensor Core and CUDA-core softmax work, uses fine-grained TMA copies for a `64 x 576` K block, `EVICT_FIRST` TMA cache hints, PDL overlap of `splitkv_mla`/`combine`, and a tile scheduler for load balance.
- **Status: sound inference.** This operator has only `h=16`; blindly porting FlashMLA's `B_H=64` head grouping will underfill lanes. A direct H800 design should tile over multiple query tokens and/or smaller head groups, then split the 512 value dimension into 64/128/256-channel chunks to control register pressure.
- **Status: sound inference.** Use 64-token KV chunks as the first split granularity because both FlashMLA source and deep dive center on 64-wide K/topK tiles. Validate smaller value-channel chunks before adding TMA/cache-hint complexity.

### Correctness and reward-hack checks

- **Status: locally-tested.** Promotion evidence must be absolute H800 latency and full-workload correctness, not reference speedup; `task.md` explicitly marks the PyTorch reference as a correctness oracle only.
- **Status: sound inference.** Required checks for any split-K/sequence-parallel attempt: base-2 final LSE, causal offset per batch (`prefix_len = kv_len - q_len`), page_size=1 token ordering through arbitrary `kv_indices`, no value accumulation from `kpe64`, FP32/TC accumulation until final BF16 store, and correct sentinels for empty/all-masked rows.
- **Status: sound inference.** Do not promote median-only wins. Report median, mean, p90, max, and per-workload tail rows; current evidence already shows sub-ms median with ~0.885 s max.
- **Status: sound inference.** Do not hard-code UUIDs, row lengths, contiguous page indices, or sparse/top-k approximations. The contract is exact dense causal attention over the provided page indices.

### Sources

- FlashInfer BatchMLAPagedAttentionWrapper docs: https://docs.flashinfer.ai/api/attention.html#flashinfer.mla.BatchMLAPagedAttentionWrapper
- FlashInfer TRTLLM MLA docs: https://docs.flashinfer.ai/generated/flashinfer.mla.trtllm_batch_decode_with_kv_cache_mla.html
- FlashInfer issue #2877: https://github.com/flashinfer-ai/flashinfer/issues/2877
- FlashInfer cascade merge_state docs: https://docs.flashinfer.ai/generated/flashinfer.cascade.merge_state.html
- SGLang attention backend matrix: https://docs.sglang.io/advanced_features/attention_backend.html
- FlashMLA README: https://github.com/deepseek-ai/FlashMLA
- FlashMLA SM90 sparse prefill source: https://github.com/deepseek-ai/FlashMLA/blob/main/csrc/sm90/prefill/sparse/config.h and https://github.com/deepseek-ai/FlashMLA/blob/main/csrc/sm90/prefill/sparse/phase1.cuh
- FlashMLA H800 deep dive: https://github.com/deepseek-ai/FlashMLA/blob/main/docs/20250422-new-kernel-deep-dive.md
- Local task evidence: `tasks/007_flashinfer_019_mla_paged_prefill_causal_h16_ckv512_kpe64_ps1/definition.json`, `task.md`, `workload.jsonl`, `benchmark.csv`
