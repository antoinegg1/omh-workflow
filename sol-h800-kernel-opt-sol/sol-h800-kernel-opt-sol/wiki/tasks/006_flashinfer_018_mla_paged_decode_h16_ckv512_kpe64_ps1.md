# 006_flashinfer_018_mla_paged_decode_h16_ckv512_kpe64_ps1

- Status: unverified
- Target: local H800 P50 latency
- Promotion: official SOL-ExecBench correctness plus H800 latency evidence

## Notes

Scouts and coordinator should append sourced findings here.

## Search Findings

Last updated: 2026-07-07T04:53:46.630Z

### Evidence-backed synthesis

- **[locally-tested] Task shape:** `definition.json` fixes `num_qo_heads=16`, `head_dim_ckv=512`, `head_dim_kpe=64`, and `page_size=1`; the reference computes `lse = logsumexp(logits * sm_scale) / ln(2)` as FP32 and zeros output for empty KV rows.
- **[unverified/source-backed] Production split-KV pattern:** Flash-Decoding splits K/V, writes one per-split output plus one log-sum-exp scalar, then reduces splits with LSE rescaling. FlashInfer `cascade.merge_states` exposes the same state contract: per-state `v` plus FP32 logsumexp `s`. FlashMLA SM90 dense decode builds scheduler metadata/`num_splits`, launches `splitkv_mla`, stores FP32 `lse_accum` and FP32 `out_accum`, then runs a combine kernel.
- **[locally-tested] Local H800 split policy evidence:** The reward-reviewed `splitkv_midbatch_profile_v1` profile passed 47/47 and chose `B>1` threshold `1024`, chunk `640`, cap `8`, with median `0.571168 ms`, p90 `0.952390 ms`, max `1.579440 ms`. The later reward-reviewed `b1_split_retune_v1` candidate passed 47/47 with tensor-derived `B==1` threshold `768`, chunk `640`, and batched chunk `640`, improving median to `0.513120 ms`, p90 `0.936608 ms`, max `1.587408 ms`. Later long-batch split-cap sweeps cluster near `0.512 ms` median in candidate logs, but are not promoted/reward-finalized; treat cap `10-14`/near `12` as an experiment, not accepted policy.
- **[unverified inference] Bottleneck for this operator:** FlashMLA's H800 analysis says MLA becomes compute-bound around `h_q * s_q >= 128`; this task has `h_q * s_q = 16`, so memory bandwidth, memory latency hiding, split balance, and partial-output traffic dominate more than FlashMLA's compute-bound seesaw schedule.
- **[unverified/source-backed] Hopper tactics:** For `page_size=1` token/page indices and `ckv512+kpe64`, prioritize coalesced/vectorized BF16 loads, enough split CTAs to occupy SM90, and minimizing extra global partial traffic. TMA, warp-specialized seesaw scheduling, PDL, and persistent/tile schedulers are useful only when the access pattern and register footprint justify them; FlashMLA's dense SM90 source requires `page_block_size == 64`, so it is not a direct implementation template for this task's `page_size=1` cache.
- **[rejected as direct H800 guidance] Blackwell/SM100/SM120 paths:** FlashInfer's XQA MLA doc says that XQA MLA is optimized for SM120a/SM121a tensor cores, and the TRTLLM/CuteDSL sparse routing docs discuss SM100/SM103/SM120/SM121 choices. Keep those launch/scheduler ideas as inspiration only until an SM90/H800 analogue is locally validated.

### Merge invariant

For each non-empty split `i`, keep FP32 state. If the split stores unnormalized numerator state, merge as `M=max_i(m_i)`, `D=sum_i d_i * exp(m_i - M)`, `O=sum_i num_i * exp(m_i - M) / D`, and task `LSE2=(M + log(D)) * log2(e)`. If the split stores normalized output plus natural-log `lse_i`, use `LSE=max_i(lse_i) + log(sum_i exp(lse_i - max_i(lse_i)))`, weights `w_i=exp(lse_i - LSE)`, `O=sum_i w_i * o_i`, then return `LSE * log2(e)` for this task. If using base-2 logits internally, use `exp2/log2` consistently and do not apply `sm_scale` twice. Never sum or average normalized split outputs.

### Practical thresholds to try first

1. `B==1`: no split for short rows; split around `seq_len > 768` with chunk about `640` and cap `<=16`. This is better-supported than the older `896/768/512` B1 policy because `b1_split_retune_v1` is later and reward-reviewed.
2. `B>1`: split around `max_seq_len > 1024`, chunk `640`, cap `8` as the conservative reward-reviewed policy. Explore long-batch cap near `12` only with full correctness, p90/max, and reward-hack review.
3. Optimize p90/max, not just median: local profile found chunk `512` had a better median than chunk `640` in one sweep but regressed max latency; chunk `640` preserved the tail.

### Correctness and reward-hack guardrails

- **[locally-tested/task-contract]** Split policy may use only `batch_size`, `kv_indptr`, `kv_indices` lengths, per-row sequence lengths, alignment, and fixed task constants.
- **[locally-tested/task-contract]** With `page_size=1`, `kv_indices` are token/page ids; do not assume they are sorted, contiguous, padded, or equal length across rows.
- **[locally-tested/task-contract]** Empty rows and empty split intervals must produce zero BF16 output and `-inf` FP32 LSE without NaN or stale partials.
- **[locally-tested/task-contract]** Returning natural-log LSE is wrong for this operator even if attention output appears correct.
- **[rejected]** Do not branch on workload row/order, exact observed sequence table, UUID, path, seed, evaluator state, pointer identity, traces, timing files, or precomputed outputs.

### Sources

- Task contract and base-2 LSE reference: `tasks/006_flashinfer_018_mla_paged_decode_h16_ckv512_kpe64_ps1/definition.json`, `tasks/006_flashinfer_018_mla_paged_decode_h16_ckv512_kpe64_ps1/task.md`.
- Local H800 profile: `tasks/006_flashinfer_018_mla_paged_decode_h16_ckv512_kpe64_ps1/profile/splitkv_midbatch_profile_v1/20260702_105951/REPORT.md`.
- Local candidate timing/reward evidence: `tasks/006_flashinfer_018_mla_paged_decode_h16_ckv512_kpe64_ps1/candidates.jsonl` rows for `splitkv_midbatch_profile_v1`, `b1_split_retune_v1`, and later long-batch split sweeps.
- FlashMLA README and usage: <https://github.com/deepseek-ai/FlashMLA>.
- FlashMLA H800 deep dive: <https://raw.githubusercontent.com/deepseek-ai/FlashMLA/main/docs/20250422-new-kernel-deep-dive.md>.
- FlashMLA dense decode API: <https://raw.githubusercontent.com/deepseek-ai/FlashMLA/main/csrc/api/dense_decode.h>.
- FlashMLA Triton benchmark merge example: <https://raw.githubusercontent.com/deepseek-ai/FlashMLA/main/benchmark/bench_flash_mla.py>.
- FlashInfer merge states docs: <https://docs.flashinfer.ai/generated/flashinfer.cascade.merge_states.html>.
- FlashInfer MLA decode docs: <https://docs.flashinfer.ai/generated/flashinfer.mla.trtllm_batch_decode_with_kv_cache_mla.html>, <https://docs.flashinfer.ai/generated/flashinfer.mla.xqa_batch_decode_with_kv_cache_mla.html>.
- Flash-Decoding algorithm note: <https://crfm.stanford.edu/2023/10/12/flashdecoding.html>.
- NVIDIA Hopper Tuning Guide: <https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html>.
