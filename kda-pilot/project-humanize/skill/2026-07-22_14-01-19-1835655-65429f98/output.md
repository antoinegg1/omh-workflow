APPROVE the guarded dense-expert candidate before profiling. The baseline already isolates the only plausible win: remove MoE routing/padding/scatter overhead while streaming the same dense expert weights. Profiling first is less decisive than an A/B direct-path attempt.

Primitive first: **`aiter.batched_gemm_a8w8`**.

Reason: the target case is exactly 8 same-shape skinny GEMMs at `M=16/32`. A per-expert `aiter.gemm_a8w8` loop risks 16 GEMM launches across `w1/w2`, which works against the suspected win. A fused Triton kernel is too much first-surface-area unless AITER batched GEMM is clearly slower or unsupported for the required fp8/block-scale layout.

Cheap decisive measurement: measure a **GEMM-only dense lower bound** for `M=16,32`: preallocate all intermediates, call only `batched_gemm_a8w8(w1)` and `batched_gemm_a8w8(w2)` with the required quantized intermediate path as minimally as possible, no routing/topk/sort/scatter, repeat=10. If that floor is not at least ~8-10% faster than reference latency, this is probably a NO-GO for wrapper removal; if it is, finish the correctness-preserving dense candidate.
