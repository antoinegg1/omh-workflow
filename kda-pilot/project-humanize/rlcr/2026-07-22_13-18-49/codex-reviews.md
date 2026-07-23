# Round 0 — Codex Reviews (analyze tasks)

## task2 — Preflight + smoke evidence review
Verdict: **PASS**. No blocker in evidence. Notes: `passed:0` expected (candidate==reference);
smoke settings valid for infra only, not stable benchmarking; taskset scopes to 13 rows
(the frozen authority). Content-only verification (Codex sandbox cannot read FS).

## task4 — Target contract + reward-hacking risk review
Verdict: **APPROVE** with guardrails. `moe_total_decode` is a sound Round 0 target:
dense routing (top_k==num_experts==8, topk_ids==arange) makes generic MoE overhead
removable — real work elimination, not evaluator gaming. Ceiling narrower than
compute-bound prefill, but valid.

### Must-do guardrails (to encode in candidate)
1. Runtime guards → fall back to `glm52_ops.reference` unless ALL hold: M in {16,32};
   `topk_ids` is dense identity (== arange(E) per row); `top_k==num_experts==E`;
   w1_scale/w2_scale/a1_scale/a2_scale all ones; expected dtypes/layout/expert dims.
   Do NOT hard-code the dense/scale assumptions without these checks.
2. Apply `topk_weights` exactly once, after each expert's second (down) projection.
   Dense experts != averaging/summing; weighting must match reference.
3. Verify gate/up interleave order EMPIRICALLY against reference: w1 is `[E, 2I, H]`;
   confirm gate=[0:I], up=[I:2I] (or reverse) before optimizing.
4. Operation order: gate = hidden@w1_gate, up = hidden@w1_up, act = silu(gate)*up,
   y = act@w2, then top-k weighted sum. fp32 accumulation where reference effectively does
   (before SiLU and final weighted sum).
5. AMD `float8_e4m3fnuz` semantics must match ROCm/AITER (not CUDA e4m3fn) — scale/sign/zero.
6. Fully write `inputs["out"]` if used (NaN-poisoned); no uninitialized regions.
7. Real reference fallback for losing/non-matching shapes only — not fallback everywhere.
8. Benchmark BOTH M=16 and M=32 at repeat=10; keep custom path only for shapes with no regression.

### Correctness traps flagged
- calc_diff <= 1e-5 is scale-sensitive: uniform fp8 scale mistakes, missing topk weights,
  or fn/fnuz mismatch fail even with cosine ~1.
- Reference consumes `topk_output`, not `router_logits` (which are zeros) — don't rely on logits.
- NaN/inf position check runs first.

## task6 — Baseline review + candidate direction
Verdict: **APPROVE** the guarded dense-expert candidate BEFORE profiling. Baseline
already isolates the only plausible win (remove MoE routing/padding/scatter overhead while
streaming the same dense expert weights); an A/B direct-path attempt is more decisive than
profiling first.
- First primitive: **`aiter.batched_gemm_a8w8`** — case is exactly 8 same-shape skinny
  GEMMs at M=16/32; a per-expert `gemm_a8w8` loop risks 16 launches (works against the win);
  a fused Triton kernel is too much first-surface-area unless batched GEMM is slower/unsupported.
- **Decisive cheap measurement (do FIRST):** GEMM-only dense lower bound at M=16,32,
  repeat=10 — preallocate intermediates, call only `batched_gemm_a8w8(w1)` and
  `batched_gemm_a8w8(w2)` with minimal intermediate quant, NO routing/topk/sort/scatter.
  If that floor is NOT at least ~8–10% faster than reference latency ⇒ likely NO-GO for
  wrapper removal. If it is faster ⇒ finish the correctness-preserving dense candidate.

# Round 2 (cont.) — target #4 `index_score_prefill` (analyze/review)

## Candidate + official-evidence GO/NO-GO review (gpt-5.5:xhigh, inline evidence)
Verdict: **GO**. No blocking correctness or reward-hacking issue.
- **Legitimate, not a reward hack.** Same frozen inputs, same reference math, same aiter
  Triton kernel body, same fnuz recast/scale compensation, same output-buffer semantics;
  overrides ONLY the launch tiling (`BLOCK_KV=256, num_stages=1`). No oracle/taskset/
  tolerance/timer/input-generation path touched.
- **Correctness durable.** Upstream kernel masks tails with `kv_col_offsets < end_ind`;
  `65536 % 256 == 0` so the official shapes have no partial KV tail. `ks=0, ke=65536`
  ⇒ the `clean_logits=False` empty buffer has no ignored in-range holes. Official gate
  reports `correct=True` on all 3 (includes the calc_diff layer); standalone calc_diff=0.0.
- **`weights.squeeze(-1)` safe** — mirrors what the ROCm provider does before calling
  aiter (a view, not a changed problem).
- **Fallback safe** — broad try/except is a performance-risk, not correctness-risk pattern:
  if the launch computes wrong data the gate catches it; if setup raises, the untouched
  reference is returned. Explicitly allowed by the harness (same pattern as R0/R1/R2).
- Non-blocking note (declined): the long docstring documents env-specific internals and is
  slightly brittle; not a commit blocker.
- Codex's own evaluator rerun was GPU-blocked in the review sandbox (`ERROR: GPU runtime
  required`); GO relies on the supplied official ROCm benchmark evidence (static + compile
  review passed). This is the same review-sandbox limitation documented for the loop.
