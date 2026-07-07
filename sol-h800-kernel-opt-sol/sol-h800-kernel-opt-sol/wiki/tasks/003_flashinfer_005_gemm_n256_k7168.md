# 003_flashinfer_005_gemm_n256_k7168

- Status: unverified
- Target: local H800 P50 latency
- Promotion: official SOL-ExecBench correctness plus H800 latency evidence

## Notes

Scouts and coordinator should append sourced findings here.

## Search Findings

Last updated: 2026-07-07T05:33:43.542Z

## Search Findings

### Synthesis

- [locally-tested] Task contract is FP16 `C = A @ B.T` with `A[M,7168]`, `B[256,7168]`, and `C[M,256]`. Public workload rows are `M={1,4,14,15,16,32,53,54,55,56,57,58,63,80,901,11948,14104}`. [T1]
- [locally-tested] Clean direct cuBLAS tensor-op GEMM is the production baseline to beat. Local direct/strict/integrity cuBLAS rows pass `17/17` and sit around median `0.0132-0.0137 ms`, p90 about `0.0420-0.0428 ms`, max about `0.090 ms`. [T2]
- [locally-tested] NCU splits the H800 behavior into two real regimes. Observed `M<=901` underfills 132 SMs: `M=1/4/32` launch 20 CTAs, `M=56/80/901` launch 80-96 CTAs, all below one full wave/SM; `M=901` reaches about `24%` SM/tensor-pipe activity but remains scoreboard/grid limited. Observed large rows `M=11948/14104` use nvjet coopA kernels with 130-132 CTAs and about `84-85%` SM/tensor activity, so launch overhead is not the large-row limiter. [T3][T4][T5]
- [rejected] Local CUDA-graph, warmup, persistent-workspace, broad WMMA, split-K WMMA, and CUTLASS large-M attempts did not beat the clean cuBLAS family across full-workload median/p90/max. Some CUTLASS workspace-tail attempts also showed correctness or max-latency failures. [T2]

### Actionable H800 strategy

1. [locally-tested] Keep direct `cublasGemmEx` / cuBLAS tensor-op GEMM as the default path for all `M` until a full-workload H800 run beats it. The profiled harness uses fp32 compute and the row-major task layout through cuBLAS `CUBLAS_OP_T`/`CUBLAS_OP_N`; preserve this layout mapping exactly. [T3]
2. [locally-tested + inference] If custom work resumes, target only a broad small/medium regime, roughly observed `M<=901`, where NCU shows 20-96 CTAs and long-scoreboard/grid underfill. Acceptance must be full `17/17` correctness plus median below the cuBLAS family and no p90/max regression; single-row wins do not matter. [T3][T4]
3. [unverified inference] Candidate custom shapes should start from `N` tile 256 or 128, `M` tile 64/128, and `K` tile 64/128. `K=7168` is divisible by both 64 and 128, so K-tail logic is avoidable; M-tail masking is mandatory for single-digit and 53-63 rows. This is a design direction, not proven faster than cuBLAS. [T1][W3]
4. [locally-tested] Keep observed large rows `M=11948/14104` on cuBLAS unless a profile proves a replacement can match about `84-85%` SM/tensor activity and improve full-workload p90/max. A broad large-M gate such as `M>=2048` is only a shape-derived policy inference; local direct evidence covers the two public large rows. [T4][T5]
5. [unverified] cuBLASLt is useful only if its setup overhead is controlled: NVIDIA documents querying heuristics once and reusing the result; the heuristics cache exists because host heuristic work can cost tens of microseconds. For this operator, local evidence did not show graph/workspace/warmup variants beating clean direct cuBLAS. [W1][T2]
6. [unverified] CUTLASS public guidance supports split-K/sliced-K for small `M,N` with large `K`, and Hopper warp-specialized persistent cooperative/ping-pong kernels can amortize prologue/epilogue overhead. CUTLASS also warns that SM90 profiler instantiation space is huge, so use targeted `f16/f16/f32` SM90 kernels rather than exhaustive generation. [W2][W3]

### Runtime thresholds supported by evidence

- [locally-tested] Safe threshold today: no custom threshold; use direct cuBLAS for every `M`. [T2]
- [locally-tested] Only evidence-backed experiment gate: a broad small/medium path covering observed `M<=901`; this is where NCU shows underfilled H800 grids. [T3][T4]
- [locally-tested] Do not replace observed large rows `11948` and `14104` without new NCU evidence; cuBLAS already reaches near-one-wave grids and high SM/tensor activity there. [T4][T5]
- [rejected] Exact dispatch on the 17 workload `M` values is not an acceptable thresholding strategy. It is overfit to `workload.jsonl` and should be treated as reward-hack risk, even if the rows are public. [T1]

### Correctness and reward-hack pitfalls

- [locally-tested] Layout is the first correctness trap: math is `A[M,K] @ B[N,K].T`, while cuBLAS is column-major. The local profiled cuBLAS contract used `CUBLAS_OP_T`/`CUBLAS_OP_N`; wrong op flags or leading dimensions can silently compute a transposed variant. [T3]
- [unverified] Split-K changes reduction structure. NVIDIA documents that split-K chunks are summed into the result and warns about side effects when compute type is wider than output type; recheck fp32-accumulate-to-fp16 tolerance on all rows. [W1]
- [locally-tested] M tails are central: validate `M=1,4,14,15,16,32,53-58,63,80,901,11948,14104`, not only a large row. K tail is absent for 64/128 K tiles because `7168` is divisible by both. [T1]
- [rejected] CUDA graph replay, persistent workspace, or caches must not capture stale A/B/C pointers or outputs. Local reward reviews accepted only paths that recompute from current tensors and avoid UUID/order/timing/path/value dispatch. [T3][T4]
- [rejected] Runtime reads of `benchmark.csv`, traces, candidates, UUIDs, paths, random seeds, call stacks, or evaluator timing are implementation evidence leaks and are not valid optimization signals. [T2]

### Adjacent public examples and non-applicable material

- [unverified] Triton’s matmul tutorial gives generic FP16 configs including `128x256x64` and `64x256x32`, L2 grouped ordering, and autotuning. It is useful as a template for a masked small/medium experiment, but it is not evidence of beating cuBLAS on H800 for `N=256,K=7168`. [W4]
- [unverified] DeepGEMM is architecturally close to DeepSeek/MoE GEMMs and documents SM90 support plus NT layout `D=C+A@B.T`; its grouped GEMM keeps fixed `N,K` and groups the `M` axis. However, public DeepGEMM material is mostly FP8/FP4/BF16 and layout-transform-heavy, not an exact FP16 dense gate GEMM for this task. [W5]
- [unverified] DeepGEMM PR #323 is close by hidden size (`hidden=7168`) and Hopper/SM90 MegaMoE context, but it is an FP8 MegaMoE path with H20/H200 reports, not direct H800 FP16 `Mx7168 by 256` evidence. [W6]
- [not-directly-applicable-to-H800] CUTLASS Blackwell SM100 Stream-K, FP4/blockscaled, and SM100 CuTe DSL examples are not direct H800 evidence. Use them only as inspiration after identifying an SM90 analogue and validating locally. [W7]

### Sources

- [T1] `tasks/003_flashinfer_005_gemm_n256_k7168/definition.json`; `tasks/003_flashinfer_005_gemm_n256_k7168/workload.jsonl`.
- [T2] `tasks/003_flashinfer_005_gemm_n256_k7168/benchmark.csv`.
- [T3] `tasks/003_flashinfer_005_gemm_n256_k7168/profile/cublas_profile_review_gemm_n256_k7168/20260702_0508_cublas_review/REPORT.md`.
- [T4] `tasks/003_flashinfer_005_gemm_n256_k7168/profile/profile_tail_splitk_probe/20260701T221907Z/REPORT.md`.
- [T5] `tasks/003_flashinfer_005_gemm_n256_k7168/profile/cutlass_large_m_profiled/20260702_161917/REPORT.md`.
- [W1] NVIDIA cuBLAS docs: https://docs.nvidia.com/cuda/cublas/ .
- [W2] CUTLASS Efficient GEMM: https://docs.nvidia.com/cutlass/latest/media/docs/cpp/efficient_gemm.html .
- [W3] CUTLASS Profiler docs: https://docs.nvidia.com/cutlass/latest/media/docs/cpp/profiler.html .
- [W4] Triton matmul tutorial: https://triton-lang.org/main/getting-started/tutorials/03-matrix-multiplication.html .
- [W5] DeepGEMM README: https://github.com/deepseek-ai/DeepGEMM .
- [W6] DeepGEMM PR #323: https://github.com/deepseek-ai/DeepGEMM/pull/323 .
- [W7] CUTLASS changelog / examples: https://docs.nvidia.com/cutlass/4.3.2/CHANGELOG.html and https://github.com/NVIDIA/cutlass/tree/main/examples/67_hopper_fp8_warp_specialized_gemm_with_blockwise_scaling .
