# 001_flashinfer_002_fused_add_rmsnorm_h4096

- Status: unverified
- Target: local H800 P50 latency
- Promotion: official SOL-ExecBench correctness plus H800 latency evidence

## Notes

Scouts and coordinator should append sourced findings here.

## Search Findings

Last updated: 2026-07-07T02:48:50.288Z

### Public fused residual-add RMSNorm kernels

- **FlashInfer CUDA path — locally applicable pattern, status: unverified upstream / locally-tested analogue.** `FusedAddRMSNormKernel` maps `gridDim.x = batch_size`, i.e. one CTA per row. For BF16 and `d=4096`, `vec_size = gcd(16 / sizeof(T), d) = 8`, `block_size = min(1024, d / vec_size) = 512`, and `num_warps = 16`. The kernel loads 8 BF16 elements per vector, forms `x = float(input) + float(residual)`, accumulates `sum_sq += x * x` in FP32, writes the BF16 residual update, stores FP32 `x` in shared memory, does warp-shuffle reduction plus a shared-memory cross-warp reduction, then scales from cached FP32 `x` and BF16 weight before writing BF16 output. This is the closest public semantic match to the SOL oracle, except FlashInfer mutates input/residual in place while SOL returns only `output`. [FI-code] [FI-doc] [Task-def]
- **vLLM CUDA path — useful speed pattern, status: unverified for SOL precision.** vLLM `fused_add_rms_norm_kernel` maps one block per token/row, uses `width=8` packed FP16/BF16 vectors when input/residual/weight pointers and strides are 16-byte aligned, and falls back to scalar width 0 otherwise. It uses `CUB::BlockReduce<float, 1024>` and chooses `block = min(hidden_size, 1024)` for `num_tokens < 256`, else `block = min(hidden_size, 256)` for larger batches. Its vector type uses `__nv_bfloat162` pairs and 16-byte aligned POD vectors. Precision differs from SOL/FlashInfer: packed `temp += residual` occurs in BF16 pairs before `sum_squares()`, and scaling/weight multiplication can round through packed BF16 operations. [vLLM-code] [vLLM-types] [Task-def]
- **Apex — not a fused residual-add source, status: unverified absence.** Apex documents/builds `apex.normalization.FusedRMSNorm`, but inspection of the public tree found layer/group norm and `multihead_attn_norm_add` files, not a public fused residual-add RMSNorm kernel/API matching this operator. Treat Apex as a precision-reference family, not an implementation template for this fused op. [Apex-tree] [Apex-repo]

### H800 / SM90 scheduling evidence for this operator

- **Observed workload:** SOL task is BF16 `hidden_size=4096`, `eps=1e-5`, with public batches `{1, 7, 15, 16, 34, 63, 64, 79, 170, 8804, 10827, 11832, 14418, 14509}`. The reference computes `hidden_states.float() + residual.float()`, FP32 mean square, FP32 `rsqrt`, FP32 weight multiply, then casts once to BF16. [Task-def] [Workload]
- **Local H800 candidates:** initial `cuda_persistent_row_rmsnorm_bf16_h4096` passed 14/14 at median `0.009688 ms`; later vector/register-cached row kernels repeatedly passed 14/14 around median `0.00692-0.00728 ms`, with best listed median `0.006920 ms`. These are local H800 evaluator measurements, not public web benchmark claims. [Benchmark]
- **NCU for large public rows:** the profiled reward-safe cap-6 single-path candidate used `grid 792 x block 256`, 38 regs/thread, ~72-73% achieved occupancy, DRAM throughput 85.64-88.06%, L2 hit ~34%, and long-scoreboard stalls ~65-66% for `B=8804,10827,11832,14418,14509`. The report concludes the kernel is memory/L1TEX-scoreboard dominated and does **not** support reducing to 128 threads; it proposes staging the invariant 8 KiB BF16 weight in CTA shared memory for the row loop. [NCU]
- **Row scheduling decision:** for `h=4096`, public FlashInfer and vLLM both use one row per CTA/block. Local H800 data also favors the row-grid family over the earlier persistent-row candidate. Split-row or cluster reductions are not directly supported for this row size by observed local evidence; they target hidden sizes exceeding a single CTA's comfortable capacity or much larger reductions. [FI-code] [vLLM-code] [Benchmark] [NCU] [QuACK]

### Hopper tuning implications

1. **Keep 16-byte BF16 vectorization for contiguous aligned h4096.** Use 8 BF16 elements per vector (`uint4`/16 B equivalent). Keep scalar or narrower fallback only for misalignment, stride, or non-contiguity legality. Expected H800 benefit: preserves coalesced memory transactions on a memory-bound operator. Correctness risk: alignment assumptions without fallback can read invalid data. Reward-hack risk: low if branching only on dtype/shape/contiguity/alignment. [FI-code] [vLLM-code] [QuACK]
2. **Prefer one-row-per-CTA for h4096; tune block width and active CTAs, not split-row.** Public kernels use one row per CTA/block. Local H800 results show row kernels beating the earlier persistent-row candidate and NCU shows the cap-6/block-256 large-row path already near high DRAM utilization with scoreboard stalls. Expected H800 benefit: avoids inter-CTA reduction and launch complexity. Correctness risk: low. Reward-hack risk: low if thresholds are semantic and not tied to UUID/public rows. [Benchmark] [NCU]
3. **Reduction pattern: thread-local FP32 sum, warp shuffle, tiny shared-memory cross-warp reduce.** This matches FlashInfer and the Hopper memory-bound reduction guidance. CUB BlockReduce as in vLLM is a valid baseline, but FlashInfer's explicit shuffle + small smem path avoids broad shared-memory traffic. Expected H800 benefit: lower reduction overhead for one CTA per row. Correctness risk: FP32 reduction order changes last-bit results; verify all rows. [FI-code] [vLLM-code] [QuACK]
4. **Register/occupancy target: avoid changes that reduce memory-level parallelism unless NCU proves it.** The local NCU row uses 38 regs/thread, ~75% theoretical and ~72-73% achieved occupancy, with only ~0.54-0.57 eligible warps/scheduler due to long scoreboard. The observed issue is memory latency/scoreboard, not arithmetic throughput. Expected H800 benefit: prevents overfitting a lower-occupancy microkernel. Correctness risk: none. Reward-hack risk: medium if routing on exact public batch sizes instead of semantic batch ranges. [NCU]
5. **Consider shared weight staging for large-row CTAs.** Weight is invariant across rows and only 4096 BF16 = 8 KiB. The local NCU report specifically selected staging 512 vectorized weight elements into CTA shared memory while keeping `kThreads=256`, cap-6, h4096, vec8, and EPS. Expected H800 benefit: reduce repeated global weight reads and L1TEX scoreboard pressure when each CTA loops over multiple rows. Correctness risk: low if weight is converted to FP32 at multiply and no BF16 pre-rounding is introduced. Reward-hack risk: low if applied uniformly to contiguous aligned h4096. [NCU]
6. **PDL is only a secondary experiment.** FlashInfer exposes `enable_pdl`; vLLM benchmark PR shows PDL/graphs can matter for low-latency small batches, but this SOL op is a standalone memory-bound row kernel and local promotion still needs H800 evaluator evidence. Expected H800 benefit: possible launch/dependency benefit for tiny batches, not proven here. Correctness risk: low. Reward-hack risk: low. [FI-doc] [vLLM-PR]

### Precision and SOL correctness constraints

- SOL oracle requires FP32 residual add, FP32 sum of squares, FP32 normalization/weight multiply, then one BF16 output cast. FlashInfer's CUDA fused-add path preserves FP32 `x` for sumsq and scale via shared-memory `smem_x`; vLLM's vector path intentionally trades precision for speed by doing packed BF16 vector add and packed scaling/multiply steps. [Task-def] [FI-code] [vLLM-code] [vLLM-types]
- Do not re-read a BF16-rounded residual for scaling if matching SOL semantics matters. Writing residual in BF16 is compatible with public fused in-place APIs, but SOL's observable output must come from FP32 `x`. [Task-def] [FI-code]
- Weight is BF16 in inputs but used as FP32 by the reference. Multiply after converting weight to FP32; avoid BF16/bfloat162 multiply as the last mathematical operation before cast unless correctness is revalidated across all workload rows and adversarial values. [Task-def] [vLLM-types]

### Not directly applicable to H800 h4096 unless revalidated

- **Blackwell/B200-only performance data and NVFP4/TMEM-style techniques:** FlashInfer PR 2777 includes B200 data and SM100-adjacent improvements; record as inspiration only, not H800 evidence. [FI-PR2777]
- **SM90 cluster reductions for very large hidden dimensions:** Hopper supports DSMEM/cluster reductions and FlashInfer CuTe DSL adds cluster splitting for large `H`, but `h4096` fits a single CTA/vectorized row kernel. Use cluster/split-row only after NCU shows one-row CTA underutilization or for hidden sizes beyond this task. [FI-PR2777] [QuACK]

### Sources

- [Task-def] `tasks/001_flashinfer_002_fused_add_rmsnorm_h4096/definition.json`
- [Workload] `tasks/001_flashinfer_002_fused_add_rmsnorm_h4096/workload.jsonl`
- [Benchmark] `tasks/001_flashinfer_002_fused_add_rmsnorm_h4096/benchmark.csv`
- [NCU] `tasks/001_flashinfer_002_fused_add_rmsnorm_h4096/profile/cuda_profilefirst_singlepath_h4096/20260702T015317Z/REPORT.md`
- [FI-doc] https://docs.flashinfer.ai/generated/flashinfer.norm.fused_add_rmsnorm.html
- [FI-code] https://raw.githubusercontent.com/flashinfer-ai/flashinfer/main/include/flashinfer/norm.cuh
- [FI-PR2777] https://github.com/flashinfer-ai/flashinfer/pull/2777
- [vLLM-code] https://raw.githubusercontent.com/vllm-project/vllm/v0.10.0/csrc/layernorm_kernels.cu
- [vLLM-types] https://raw.githubusercontent.com/vllm-project/vllm/v0.10.0/csrc/type_convert.cuh
- [vLLM-PR] https://github.com/vllm-project/vllm/pull/36899
- [QuACK] https://github.com/Dao-AILab/quack/blob/main/media/2025-07-10-membound-sol.md
- [Apex-tree] https://api.github.com/repos/NVIDIA/apex/git/trees/master?recursive=1
- [Apex-repo] https://github.com/NVIDIA/apex
