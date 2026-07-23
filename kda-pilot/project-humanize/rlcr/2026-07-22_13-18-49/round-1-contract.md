# Round 1 Contract

## Mainline Objective (exactly one)

Attempt a **correctness-preserving speedup on the next official target,
`moe_total_prefill`** (GLM-5.2 fused MoE, prefill phase, AMD MI300X / ROCm gfx942,
fp8_e4m3 w8a8; prefill_M ∈ {1024, 2048, 4096}). The only correctness-safe lever is
to drive the reference's OWN Triton kernels (`_fused_moe_kernel_sequence`) with a
**bit-exact but faster launch config** — sweeping `BLOCK_SIZE_N` / `GROUP_SIZE_M` /
`num_warps` / `num_stages` / `waves_per_eu` while keeping `BLOCK_SIZE_K` fixed (fp32
K-accumulation order unchanged → calc_diff must stay 0.0). Deliver either (a) a
conservative primary-util win on ≥1 prefill shape with 0 regressions / 0 incorrect,
or (b) a **named no-go blocker** with evidence that the resolver config is already at
the correctness-preserving frontier for these shapes.

Rationale for target choice: `moe_total_decode` (round 0) is at its
correctness-preserving frontier — its only lever (shrink `BLOCK_SIZE_M` to remove
dense-decode block padding) is exhausted, and the committed candidate already wins
5/6 shapes + 1 tie. Plan `task11` explicitly permits "begin the next target if the
first target is complete"; target-priority order is decode → prefill → dsa → index.

## Target ACs for this round

- **AC-4** (performance win is evidence-backed and reported in MFU/BW terms) — primary.
- **AC-3** (candidate preserves ABI + correctness contract; no reseed/re-quant/tolerance
  change/reference monkey-patch) — must hold for any candidate.
- Secondary: AC-2 (evaluator reports MFU/BW fields), AC-5 (clean diff).

## Blocking issues (truly block the mainline objective)

- None known at contract time. If a bit-exact config faster than the resolver default
  cannot be found at any prefill shape, that is not a blocker — it is outcome (b), a
  legitimate named no-go with evidence (satisfies the plan Lower Bound).

## Queued (explicitly out of scope this round)

- **Round-0 Codex review was infra-blocked** (`bwrap: Failed to make / slave:
  Permission denied` — Codex could not read any files). This is a review-sandbox
  failure, NOT a substantive rejection; the round-0 candidate (commit 7dc4959) is
  committed with official evaluator evidence. I cannot fix Codex's sandbox from the
  candidate side. Re-running the round-0 review is the loop harness's responsibility.
- `dsa_prefill_attn`, `index_score_prefill` (later targets).
- M=64 decode (~1.0 frontier; would need a different fused kernel).

## Concrete success criteria for this round

1. Baseline probe recorded for `moe_total_prefill` at M ∈ {1024, 2048, 4096} with
   per-shape latency / bound / MFU / BW-util / TFLOP/s / GB/s / primary-util.
2. A bit-exact config sweep (BLOCK_SIZE_K fixed) run standalone, with calc_diff==0.0
   verified for any config used.
3. EITHER: official evaluator (`evaluate_glm52_taskset.py --task moe_total_prefill`,
   metric `roofline_mfu_bw`) shows ≥1 prefill shape passed (correct + conservative
   primary-util win), 0 regressions, 0 incorrect, 0 infra_failed — candidate committed
   (candidate.py only);
   OR: a named no-go recorded with the sweep evidence showing the resolver config is
   already optimal, and no candidate change committed (reference fallback everywhere is
   explicitly NOT counted as a win per AC-4).
4. Codex review (task8/task10 analyze lanes) obtained via `/humanize:ask-codex`.
5. Final diff excludes `.humanize/`, caches, traces, build artifacts.
