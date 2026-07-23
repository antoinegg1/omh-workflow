**APPROVE**, with guardrails. `moe_total_decode` is a reasonable Round 0 target because dense routing makes generic MoE overhead removable, and M=16/32 decode is exactly where routing, padding, scatter, launch count, and small-GEMM overhead can dominate. The ceiling is narrower than compute-bound prefill, but the contract-specific dense route is real work elimination, not evaluator gaming.

**Risks**

- `topk_ids == arange(8)` is only safe if guarded at runtime. If not exactly dense identity, fall back.
- `top_k == num_experts == 8` is a valid specialization for this task, but hard-coding it without shape/value checks risks silent wrong answers.
- `topk_weights` must still be applied. Dense experts are not equivalent to averaging or summing experts.
- Do not rely on `router_logits == 0`; reference consumes `topk_output`, not logits.
- `w1_scale/w2_scale/a*_scale == 1` may be assumed only with guards or fallback. Ignoring non-unit scales would be a contract violation if inputs change.
- AMD `float8_e4m3fnuz` handling must match ROCm/AITER semantics. Treating it like CUDA `e4m3fn` can introduce scale/sign/zero differences.
- `inputs["out"]` must be fully written before return. No partial accumulation into poisoned output unless every element is overwritten.
- Fallback must be real reference fallback for losing/non-matching cases, not fallback everywhere.

**Correctness Traps**

- `w1` shape is `[E, 2I, H]`; confirm whether gate/up are `[0:I]` and `[I:2I]` or the opposite. Getting this reversed can produce plausible-looking but wrong cosine/calc_diff.
- Operation order matters: first `gate = hidden @ w1_gate`, `up = hidden @ w1_up`, then `silu(gate) * up`, then expert `w2`, then top-k weighted sum.
- Accumulation dtype matters. Use fp32 accumulation where reference effectively does, especially before SiLU and final weighted sum.
- `calc_diff <= 1e-5` is scale-sensitive, so uniform fp8 scale mistakes, missing topk weights, or fn/fnuz mismatch will fail even with high cosine.
- Dense masked correctness still checks NaN/inf positions first; no uninitialized regions.

**Must-Do Guardrails**

- Check `M in {16,32}`, dtype/layout expectations, `topk_ids` dense identity, scale tensors all ones, and expected expert dimensions; otherwise call reference.
- Apply `topk_weights` exactly once, after each expert’s second projection.
- Verify gate/up order empirically against reference before optimizing.
- Benchmark both M=16 and M=32 with default repeat=10; only keep custom path for shapes with no regressions.
