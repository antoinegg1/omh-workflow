# Round 3 Contract

## Round Type

**Review-phase round.** The fixed Stop-hook advanced the counter to round 3 and ran the
round-2 code review. Codex returned exactly one `[P1]` finding on the `dsa_prefill_attn`
candidate. Per the review-phase rules, code-review findings do NOT become the round
objective and no new `[mainline]` target is selected. **Target #5 is explicitly NOT
selected.**

## Mainline Objective (unchanged — carried from the completed round-2 cycle)

Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`), all
already landed with correct MFU/BW evidence and Codex-verified in the round-2 review. The
only work this round is to clear the round-2 code-review blocking finding so the loop can
proceed to finalize. The mainline objective is stable; this round adds no features and no
new targets.

## Blocking Side Issue (must fix this round)

| Issue | Tag | Owner | AC | Resolution |
|-------|-----|-------|----|-----------|
| `[P1]` DSA fast path unguarded on non-ROCm: `dsa_prefill_attn/candidate.py` takes the PyTorch fp32-QK sparse-MLA reimpl for every valid input, so under the default `cuda/cuda-b200` backend it replaces the fast CUDA `flash_mla_sparse_fwd` baseline with a much heavier PyTorch loop and regresses the default gate. | blocking | claude (coding) | AC-3, AC-4 | Add a platform guard (`torch.version.hip is None → raise → reference fallback`) so the fast path only engages on ROCm/HIP, where the reference dispatches to the slow TileLang kernel. No change to ROCm behavior (guard is a proven no-op there: `torch.version.hip == "7.0.51831"`). |

This is a genuine **unsafe-fallback** defect — the exact class the refined plan's task4 review
gate is meant to catch (plan line 187). It does not prove the round-2 mainline objective was
incomplete on ROCm (the persisted ROCm gate still passes), so it is a blocking *side* issue,
not a new mainline task.

## Queued Side Issues (documented, NOT this round's objective)

- ROCm runtime substrate missing under `/opt/devmachine/lichangye/repos/{sglang,aiter}` — cannot
  re-benchmark on GPU this round; the fix is a provable no-op on ROCm so a rerun is not required
  for correctness. Owner must restore the substrate before the next benchmark round.
- DSA fallback calls `sgl_kernel.flash_mla.flash_mla_sparse_fwd` directly rather than routing
  through `glm52_ops.reference('dsa_attn','prefill', inputs)` — a provider-alignment nit; the
  direct call still returns the reference kernel, so it does not affect correctness or the
  blocking finding. Left queued.
- Target #5 selection — deferred until this review completes and a new contract explicitly
  selects it. Do NOT self-declare.

## Acceptance for this round

- The `[P1]` finding is fixed with a minimal platform guard; no unrelated changes.
- The guard is a no-op on ROCm (fast path still taken → already-verified result.json path
  unchanged) and forces the reference on CUDA/B200.
- Change committed; `round-3-summary.md` written; `goal-tracker.md` blocking/queued lists
  reconciled.
- Next Stop-hook code review finds no `[P0-9]` issues → finalize.
