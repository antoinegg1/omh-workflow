# Round 0 Summary

## What Was Implemented

Target: `moe_total_decode` (GLM-5.2 fused MoE, decode phase, AMD MI300X / ROCm gfx942,
fp8_e4m3 w8a8). Metric: `roofline_mfu_bw` (primary_util = HBM bandwidth utilization).

A **correctness-preserving Triton launch-config optimization**. The reference is sglang's
Triton `fused_moe(..., use_fp8_w8a8=True)`. I first proved (by monkeypatch-capturing the
reference's own internal tensors) that no *reimplementation* of the fp8 MoE can pass the
gate: the intermediate activation saturates hard in fp8 (act amax ~76288 vs FP8_MAX 224,
~45% of values clamp at ±224), so even feeding the reference's EXACT `intermediate_cache2`
into an independent a2-quant+gemm2 yields calc_diff 3.15e-2 — ~3000× over the 5e-6 gate.
Bit-exact reproduction of the reference Triton kernels is mandatory.

The dense-degenerate decode routing (top_k==num_experts==8, topk_ids==arange(8): every
token → every expert) lets us keep the reference's *own* kernels but cut wasted work:
the reference uses BLOCK_SIZE_M=128 (or 64), yet at decode M≤64 each expert owns only M
rows, so `moe_align_block_size` pads each expert block up to BLOCK_SIZE_M (up to ~8×
padded-row work in both fp8 GEMMs). The candidate reuses the reference's resolved config
(`try_get_optimal_moe_config`), overrides **only** BLOCK_SIZE_M (both gemm1 and down
configs) to `clamp(next_pow2(M),16,128)`, recomputes `moe_align_block_size`, and calls
sglang's own `_fused_moe_kernel_sequence`. BLOCK_SIZE_M changes only the tile grid, not
the per-output-element fp32 K-accumulation order (BLOCK_SIZE_K untouched) → bit-exact
(measured calc_diff == 0.0 for M in {1,4,8,16,32,64}). `run()` falls back to the untouched
reference on any surprise, and deliberately for M>32 (shrinking there measured a 0.7% loss).

## Files Changed

- `testbench/tasks/glm52/moe_total_decode/candidate.py` (modified) — the sanctioned
  candidate file, only file changed. No oracle / harness / reference / taskset files touched.

## Validation

Official evaluator `evaluate_glm52_taskset.py --task moe_total_decode` (metric
`roofline_mfu_bw`); ratio = candidate/reference primary_util (BW utilization):

| M  | status              | ratio  | conservative | correct | bw_util |
|----|---------------------|--------|--------------|---------|---------|
| 1  | passed              | 1.0683 | 1.0581       | True    | 0.4928  |
| 4  | passed              | 1.0700 | 1.0544       | True    | 0.4877  |
| 8  | passed              | 1.0757 | 1.0659       | True    | 0.4845  |
| 16 | passed              | 1.0757 | 1.0568       | True    | 0.3462  |
| 32 | passed              | 1.0566 | 1.0428       | True    | 0.3308  |
| 64 | correct_not_faster  | ~1.0   | (ref fallback)| True   | 0.2895  |

Summary: **passed=5, correct_not_faster=1, incorrect=0, infra_failed=0** — all 6 shapes
correct, 5 wins, 0 regressions. Satisfies "≥1 win, 0 regress, 0 incorrect".

Codex review (gpt-5.5:xhigh): **GO**, no required changes. Confirmed legitimate optimization
(not a reward hack — reuses reference kernels, no input rebuild/re-quant, no tolerance
change, no oracle edits), correctness-durable (BLOCK_SIZE_K untouched; GROUP_SIZE_M is
scheduling-only; down_moe_use_tma=False fine for this target), and the broad try/except
cannot mask a wrong fast-path result (numerically-wrong output raises no exception and is
caught by the evaluator). Non-blocking polish suggested: a narrower exception / debug log.

## Remaining Items

- (Optional, future round) M=64 sits at the reference efficiency frontier for this config
  family (~1.0×); a different lever (e.g. a fused dense-path kernel) would be needed to win it.
- (Optional polish, non-blocking) narrow the fallback exception / add a skip-reason debug log.

## BitLesson Delta

Action: none
Lesson ID(s): NONE
Notes: No new BitLesson promoted this round. The round reinforced two existing project facts
(saved to memory): fp8-saturation makes calc_diff≤5e-6 require bit-exact kernel reproduction,
and the only correctness-preserving decode speedup is shrinking Triton BLOCK_SIZE_M to remove
dense-decode block padding.
