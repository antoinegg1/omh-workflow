# Review Round 3 Summary

## Round Type
Review-phase round. The fixed Stop-hook advanced the counter to round 3 and ran the round-2
code review, which returned exactly one `[P1]` finding. No new mainline target was selected;
**target #5 was NOT selected.**

## Mainline Objective (unchanged)
Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`) — all
landed and Codex-verified in the round-2 review. The only work this round was to clear the
round-2 code-review blocking finding. Mainline objective stayed stable; no features, no new
targets.

## Work Completed
Fixed the single `[P1]` (blocking) code-review finding: the DSA fast path was unguarded on
non-ROCm platforms.

- **Finding** (`testbench/tasks/glm52/dsa_prefill_attn/candidate.py:66`): `_fast_sparse_mla_prefill`
  took the PyTorch fp32-QK sparse-MLA reimplementation for every valid input regardless of
  platform. Under the default `cuda/cuda-b200` backend the reference `flash_mla_sparse_fwd` is
  the fast CUDA FlashMLA kernel, so the unconditional PyTorch path would replace it with a much
  heavier gather/einsum loop and regress the default gate rather than fall back — an
  "unsafe fallback" (the class the plan's task4 review gate guards against, refined-plan line 187).
- **Fix:** added a platform guard at the top of the fast path:
  `if torch.version.hip is None: raise RuntimeError("non-ROCm platform; use reference ...")`.
  The raise is caught by `run()`'s existing `try/except`, which returns the reference kernel, so
  the fast path engages only on ROCm/HIP (where the reference dispatches to the slow TileLang
  kernel because CUDA `sparse_prefill_fwd` is not compiled).

## Files Changed
- `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` — +9 lines (guard + comment only; no
  change to the ROCm fast-path math or the fallback). Commit `4597e91`.

## Validation
- `python3 -m py_compile testbench/tasks/glm52/dsa_prefill_attn/candidate.py` → OK.
- Guard predicate on this shell's CUDA torch (`2.9.1+cu128`, `torch.version.hip=None` — a
  faithful B200 stand-in): evaluates `True` → fast path skipped → reference (fast CUDA FlashMLA)
  used. This is the desired B200 behavior the finding asked for.
- On the ROCm MI300X box `torch.version.hip == "7.0.51831"` → guard `False` → fast path taken,
  unchanged. The fix is therefore a proven no-op on ROCm: the already-verified persisted result
  `runs/glm52/dsa_prefill_attn/20260722T083802Z-1b233d/result.json` (3/3 shapes won, worst
  calc_diff 2.884e-6 ≤ 5e-6, 0 regress) still holds.
- GPU re-benchmark not run: the ROCm sglang/aiter substrate under `/opt/devmachine/lichangye`
  is currently missing (queued side issue). Not required for correctness because the ROCm branch
  is unchanged by this guard.

## Remaining Items
- None blocking. No `[P0-9]` issues remain from this review.
- Queued (not this round's objective): DSA fallback provider-alignment nit (direct
  `flash_mla_sparse_fwd` call still returns the reference); restore missing ROCm substrate before
  next benchmark round; target #5 selection deferred to a future explicit contract.

## Goal Tracker Update
`goal-tracker.md` updated: `[P1]` fix added to Completed and Verified (this round), Blocking Side
Issues list left empty (no open blockers), queued lists retained, plan-evolution log appended.
No AC change. No Codex help needed for tracker reconciliation.

## BitLesson Delta
- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson-selector` was run for the fix task; the project BitLesson KB has zero entries
  and `bitlesson_allow_empty_none: true`, so the selection is NONE. (A candidate lesson —
  "platform-guard reference-dispatch-dependent fast paths so they fall back where the reference
  is already the fast kernel" — is worth adding later, but adding KB entries is out of scope for
  this fix-only review round.)
