# Round 0 Summary

**Outcome: CLEAN success** (per round-0 contract) on the #1-priority official task
`dsa_prefill_attn`, with the #2 task `index_score_prefill` re-verified and its
accepted win preserved. Both MoE official tasks are reported **blocked
(environment)**, never clean complete — consistent with AC-4 and the contract.

---

## What Was Implemented

A single, correctness-preserving, no-regression speedup to the **QK score matmul**
of `dsa_prefill_attn` (the chunked torch sparse-attention candidate). The QK matmul
was ~60% of kernel runtime and ran as an **fp32 einsum** on bf16 inputs upcast to
fp32 — correct, but with **no MFMA** (~40 TFLOP/s), because torch exposes no
bf16-in/fp32-out GEMM (a plain bf16 `bmm` rounds the logits to bf16 → calc_diff
drifts to ~6.5e-6, over the 5e-6 gate).

The fix routes QK through aiter's tuned `batched_gemm_bf16` while passing a
**caller-preallocated fp32 `YQ`** output tensor:

- `dtype=torch.bfloat16` is passed **only** to satisfy the wrapper's
  `assert dtype in [bf16, fp16]`; the kernel writes to `YQ`'s pointer, so the true
  output dtype is `YQ.dtype` = **fp32**.
- bf16×bf16 products are exact in fp32, so the logits are **bit-identical** to the
  fp32 einsum apart from fp32 accumulation-order noise (~1e-14 rel).
- Result: **MFMA throughput at unchanged precision** — calc_diff stays 2.884e-6
  (identical to baseline), while MFU rises 0.034 → 0.055 and the whole kernel
  speeds up ~1.62x.

Three guardrails are baked into `candidate.py` (do not remove):
1. **Import-time probe** `_probe_aiter_fp32_yq()` verifies the dtype=bf16+fp32-YQ
   path actually writes fp32 (rel < 1e-4 vs einsum) before enabling; disables the
   fast path on any mismatch.
2. `_qk_scores()` **falls back to the fp32 einsum** (never a bf16 path) on any
   exception.
3. **No env mutation and no probe inside `run()`** — import/probe happen at module
   load, outside the timed region.

## Files Changed

| File | Change | Notes |
|------|--------|-------|
| `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` | 140 → 222 lines | Added guarded aiter QK GEMM helper `_qk_scores()`, import-time fp32-write probe `_probe_aiter_fp32_yq()`, and fp32-einsum fallback. In-loop call changed to `scores = _qk_scores(q_chunk, gathered, sm_scale)`. `run()` still wraps `_fast_sparse_mla_prefill` in try/except → `flash_mla_sparse_fwd` reference fallback. sha256 `7698920ecb28617b7c9d0762a8f3cfee487b3a866fab1fb43512a5e51966c733`. |

No other repo files changed. Frozen authority untouched (taskset, official_metrics,
correctness thresholds, reference functions, cost model, device peaks, timing
semantics, deployment metadata). Branch unchanged
(`codex/amd-glm52-rocm-evalbench-v2`). `.humanize/`, traces, caches, and scratch
logs are excluded from the reviewable diff (AC-5).

## Validation

All gate runs use the authoritative harness
(`testbench/harness/evaluate_task.py`), full sweep M=1024/2048/4096, `--repeat 10`,
cold-L2, conservative q=0.9, under **`AITER_TRITON_ONLY=0`** (required or the
sglang TileLang reference silently degrades to a bf16 fallback). Baseline
(fp32-QK einsum @ git HEAD) and new candidate were run **sequentially in the same
session** to avoid GPU timing contention.

### `dsa_prefill_attn` — per-shape (persisted run `20260723T025835Z-4fc839`)

| Shape | cand µs | ref µs | MFU | primary-util ratio | conservative ratio | calc_diff |
|-------|---------|--------|-----|--------------------|--------------------|-----------|
| M=1024 | 4008.7 | 8432.0 | 0.0557 | 2.103 | 2.063 | 2.8837e-6 |
| M=2048 | 8068.2 | 17100.1 | 0.0554 | 2.119 | 2.096 | 2.8843e-6 |
| M=4096 | 16201.1 | 34535.0 | 0.0552 | 2.132 | 2.122 | 2.8833e-6 |

**Aggregate:** geomean_primary_util_ratio **2.1181**, geomean_cons **2.0935**,
min_cons **2.0626**, shapes_won **3**, shapes_regressed **0**, timing_unstable
False, post_timing_correct True.

### `dsa_prefill_attn` — baseline vs new (Δ against accepted baseline table)

| Metric | Accepted baseline | New | Δ |
|--------|-------------------|-----|---|
| geomean_primary_util_ratio | 1.3044 | **2.1181** | +62% |
| min_primary_util_ratio_conservative | 1.2603 | **2.0626** | +64% |
| geomean MFU | 0.034010 | **0.0552** | +62% |
| worst calc_diff | 2.8842e-6 | 2.8843e-6 | **unchanged** (margin 1.73x under 5e-6) |
| shapes_regressed | — | **0** | no regression |

### `index_score_prefill` — accepted win preserved (untouched, re-gated)

| Metric | Accepted baseline | Re-gate | Status |
|--------|-------------------|---------|--------|
| geomean_primary_util_ratio | 2.8371 | 2.8361 | within noise |
| min_primary_util_ratio_conservative | 1.5375 | 1.5382 | within noise |
| calc_diff | 0 | 0 | CORRECT |
| shapes_regressed | — | 0 | preserved |

No candidate edit; the small deltas are run-to-run timing noise, not regression.

### Advance decision (why no further dsa iteration)

New per-256-chunk component profile at M=1024 (`/tmp/prof_new.py`): gather **303µs**
(memory-bound, ~114µs HBM floor), QK-aiter **438µs** (MFMA-bound, fp32 output is the
floor; was ~975µs), softmax **122µs** (fp32, precision-locked), PV **212µs** (already
bf16→bf16 MFMA). The only MFMA-headroom lever (QK) is now closed; remaining
components have no clean low-risk lever. → **advance**, not iterate.

## Remaining Items

- **`moe_total_decode` / `moe_total_prefill` — BLOCKED (environment), not clean
  complete.** The restored env's aiter is incomplete: `module_quant.so` absent +
  CK submodule `3rdparty/composable_kernel` uninitialized (no `ck_tile` headers),
  so the fp8 MoE **reference** cannot run (`AITER_TRITON_ONLY=1` →
  `gemm_a16w16_asm` ImportError; `=0` → `module_quant` JIT build fails). The
  authoritative gate returns `incorrect` for both. Not fixable within frozen repo
  authority — needs the **env owner** to restore a prebuilt `module_quant*.so` or
  `git submodule update --init 3rdparty/composable_kernel` + rebuild (the latter
  risks numeric drift vs the accepted baseline). Round 0 routes around it: both MoE
  candidates left **untouched** so their accepted wins are preserved. Deferred in
  goal-tracker with revisit trigger = env restored.

- No other candidate-local dsa/index_score levers remain low-risk this round (see
  profile above and the `index_score` launch-config optimum established in task2).

## BitLesson Delta

Action: add
Lesson ID(s): BL-20260723-aiter-fp32yq-mfma-qk
Applied this round: NONE (KB was empty at round start — bitlesson-selector could
not run due to a transient Bedrock infra API error, but with an empty KB the
selection is deterministically NONE regardless).
Notes: This round solved a non-trivial, reusable problem — getting fp32-precision
matmul output at MFMA speed on MI300X via aiter `batched_gemm_bf16` + a
caller-preallocated fp32 `YQ`, when torch exposes no bf16-in/fp32-out GEMM. Added
one new entry to `.humanize/bitlesson.md` documenting the trigger (fp32-output
matmul stuck as a slow einsum for a correctness gate), the exact fix, the aiter
dtype/YQ-dtype contract fragility, the mandatory `AITER_TRITON_ONLY=0`, and the
reward-hack warning (never accept a bf16-QK candidate that scores calc_diff 0
against a degraded reference). Validation evidence recorded inline in the entry.
