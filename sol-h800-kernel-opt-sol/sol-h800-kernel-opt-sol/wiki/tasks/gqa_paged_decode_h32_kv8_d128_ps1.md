# gqa_paged_decode_h32_kv8_d128_ps1

## Search Findings

Last updated: 2026-07-07T05:19:59.107Z

## Search Findings

### Synthesis

- [locally-tested] This operator is BF16 GQA paged decode with 32 Q heads, 8 KV heads, head_dim=128, page_size=1, BF16 output, and FP32 LSE returned as `logsumexp / log(2)`; empty KV ranges leave zero output and `-inf` LSE. Source: local `definition.json`.
- [unverified] Public decode kernels usually start from one thread block/CTA per sequence/head or per sequence/KV-head/partition, then add split-KV or multi-block scheduling when the grid underfills the GPU or the context is long enough to amortize a reduce. vLLM's paged-attention design maps grid `(num_heads, num_seqs, max_num_partitions)`, and TensorRT-LLM recommends testing generation multi-block when `batch_size * num_heads < #SMs` plus an internal minimum-token heuristic.
- [locally-tested] The local grouped-direct H800 candidate used `grid = batch_size * 8`, `block = 128`, four warps per `(batch, kv_head)` CTA, and passed 48/48, but tails were launch-underfilled: row 33 B=64/`num_kv_indices=50902` had 0.39 waves/SM and 1.21 ms kernel duration; B=16 tails had 0.10 waves/SM and ~1.01-1.02 ms kernel duration. Dominant stall was L1TEX scoreboard from indirect page-indexed K/V loads.
- [locally-tested] The local split-KV H800 candidate gated on runtime `kv_indices.numel() > 8192` with `split_tokens = 512`. It passed 48/48 and improved p90/max from 1.130998/1.144016 ms to 0.328602/0.373568 ms versus grouped-direct, while row-33 partial-kernel waves/SM rose from 0.39 to 38.79. Median regressed from 0.160520 ms to 0.166936 ms in that profile, so split-KV is a tail-latency tool, not automatically a median win.
- [locally-tested] Later benchmark rows show persistent/pooled tail candidates also passed 48/48 with p50 around 0.147 ms and p90 around 0.262 ms, but the provided local profile evidence is for grouped-direct and split-KV, not those persistent variants. Treat persistent scheduling as a promising next direction requiring its own H800 profile.

### Split-KV merge semantics

- [unverified] FlashInfer's paged batch decode wrapper exposes caller-owned split-K workspace, `fixed_split_size` in pages, `disable_split_kv`, and GQA (`num_qo_heads` multiple of `num_kv_heads`). The docs say `fixed_split_size` can make FA2 split-KV reductions deterministic and batch-size invariant, and `disable_split_kv` exists for determinism/CUDA-graph constraints.
- [unverified] FlashInfer cascade `merge_states(v, s)` merges segment outputs `v` shaped `[seq_len, num_states, num_heads, head_dim]` with segment logsumexp `s` shaped `[seq_len, num_states, num_heads]`, where `s` is expected float32.
- [unverified] FlashAttention Hopper combine code loads partial LSE, computes final LSE as `log(sum(exp(lse_i - max_lse))) + max_lse`, stores the final LSE, rescales each partial output by `exp(lse_i - final_lse)`, accumulates in float, and converts only the final output element type. This is the correct split-KV merge pattern.
- [locally-tested] SOL requires base-2 LSE (`logsumexp / log(2)`). FlashAttention combine uses natural-log math; FlashInfer persistent decode writes `log2(d) + m`. Do not mix these without an explicit base conversion.

### H800/SM90 mapping patterns for this operator

- [unverified] For GQA ratio 4, map work by KV head and process the four Q heads sharing that KV head inside the CTA/work unit. FlashInfer persistent source bases Q at `(kv_head_idx * gqa_group_size) * q_stride_h` and writes output as `[kv_head, gqa_group_size, head_dim]`; this avoids reloading the same K/V stream once per Q head.
- [unverified] vLLM's paged-attention design stores K as `[num_blocks, num_kv_heads, head_size/x, block_size, x]` and V as `[num_blocks, num_kv_heads, head_size, block_size]`; its `Vec` abstraction targets 16-byte query/key and value fetches. For BF16 d128, use 16B vectorized chunks where alignment permits.
- [unverified inference] With SOL `page_size=1`, each page is one token, so page/block locality is minimal. Coalescing must come from vectorized d128 loads, adjacent lanes/heads, and reusing one KV head across its four Q heads. Do not assume multi-token page locality from public kernels with 8-128 token KV blocks.
- [locally-tested] Local H800 grouped-direct evidence says shared K/V staging with per-token barriers/global-to-shared round trips was not beneficial for this page_size=1 path; removing staging recovered latency while L1TEX scoreboard remained dominant. Reintroduce shared memory only when the staged K/V is actually reused across the four Q heads or multiple MMA/softmax steps.

### Safe thresholds and anti-hack constraints

- [locally-tested] Safe dispatch inputs are runtime tensor/device-derived values: `kv_indices.numel()`, `kv_indptr` row lengths/max row length, total pages, batch size, head counts, and H800 SM count. The local split path using `kv_indices.numel() > 8192` passed reward review because it did not branch on workload metadata.
- [unverified] TensorRT-LLM's public rule of thumb (`batch_size * num_heads < #SMs`) supports an occupancy gate, but the docs also require a minimum-token heuristic before multi-block wins. For this operator, combine occupancy with row/page length; batch-size-only gates are brittle.
- [rejected] Do not dispatch on workload UUID, safetensor path, trace/run directory, row number, pointer identity, random seed, candidate name, or evaluator metadata. Do not cache row-specific page patterns or outputs across calls.

### Blackwell-only / not directly applicable

- [rejected] FlashInfer SM100/NVFP4/Cute-DSL/TMEM-style paths are not H800 deliverables unless an SM90 analogue is implemented and locally validated.
- [unverified] TensorRT-LLM XQA is relevant as an MQA/GQA generation concept and supports BF16 compute, but its documented paged KV cache block sizes are 8/16/32/64/128 tokens, not SOL `page_size=1`. Use its heuristics, not its layout assumptions, for this task.

### Sources

- FlashInfer attention API: https://docs.flashinfer.ai/api/attention.html
- FlashInfer KV layout tutorial: https://docs.flashinfer.ai/tutorials/kv_layout.html
- FlashInfer cascade merge_states: https://docs.flashinfer.ai/generated/flashinfer.cascade.merge_states.html
- FlashInfer decode source: https://raw.githubusercontent.com/flashinfer-ai/flashinfer/main/include/flashinfer/attention/decode.cuh
- FlashInfer persistent source: https://raw.githubusercontent.com/flashinfer-ai/flashinfer/main/include/flashinfer/attention/persistent.cuh
- vLLM paged attention design: https://docs.vllm.ai/en/v0.6.2/dev/kernel/paged_attention.html
- TensorRT-LLM GPT attention docs: https://nvidia.github.io/TensorRT-LLM/advanced/gpt-attention.html
- FlashAttention Hopper combine kernel: https://raw.githubusercontent.com/Dao-AILab/flash-attention/main/hopper/flash_fwd_combine_kernel.h
- Local task contract/definition: `tasks/004_flashinfer_013_gqa_paged_decode_h32_kv8_d128_ps1/{task.md,definition.json}`
- Local H800 grouped profile: `tasks/004_flashinfer_013_gqa_paged_decode_h32_kv8_d128_ps1/profile/cuda_gqa_honest_grouped_tail/20260702T035754Z/REPORT.md`
- Local H800 split-KV profile: `tasks/004_flashinfer_013_gqa_paged_decode_h32_kv8_d128_ps1/profile/cuda_gqa_splitkv_tail_reduce/20260702T043557Z/REPORT.md`
- Local benchmark log: `tasks/004_flashinfer_013_gqa_paged_decode_h32_kv8_d128_ps1/benchmark.csv`
