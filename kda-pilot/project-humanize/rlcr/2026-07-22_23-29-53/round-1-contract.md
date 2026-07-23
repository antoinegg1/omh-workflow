# Round 1 Contract

## Mainline Objective (exactly one)

Resolve MoE gate **availability** so the original plan's four-task final check can
be honestly completed. Concretely: restore the incomplete aiter reference
environment (missing `module_quant*.so` + empty `3rdparty/composable_kernel`) **to
the extent that is within provisioning authority**, then run gate-quality
authoritative checks for `moe_total_decode` and `moe_total_prefill` against the
accepted baseline and confirm `correct == true` with `shapes_regressed == 0`.

If restoration is genuinely **outside my authority** (requires rebuilding or
mutating the external aiter checkout in ways I cannot safely do, or needs network
/ owner action), stop at that boundary and report both MoE tasks as
**blocked / complete-with-caveats** with concrete evidence — never *clean
complete*. Under no circumstance bypass the reference, loosen correctness, rewrite
harness code, or edit frozen authority to make MoE "pass".

This is the single lever left: the dsa win is already landed+committed
(`26bdb84`) and `index_score_prefill` is preserved; both are out of scope to
re-open this round except as a final no-regression re-confirmation.

## Target ACs (1–2)

- **AC-4** — evidence/gate-availability honesty: if the authoritative MoE gate
  cannot run, final status is blocked / complete-with-caveats, not clean complete.
  Primary target this round.
- **AC-2** — correctness + no-regression for the MoE official tasks: if the gate
  *can* run, both must be `correct` pre- and post-timing with
  `shapes_regressed == 0` and no lost accepted win.

## Truly Blocking Issues (in scope, they block the mainline)

- **Incomplete aiter reference environment.** `AITER_TRITON_ONLY=1` →
  `gemm_a16w16_asm` ImportError; `=0` → `module_quant` JIT build failure; the aiter
  checkout has an empty `3rdparty/composable_kernel` and no `module_quant*.so`
  under `aiter/jit`. This blocks the fp8 MoE **reference**, hence both MoE
  authoritative gates. Round-1 work = diagnose + attempt in-authority restoration
  (locate a prebuilt `module_quant*.so` to restore; check whether CK can be
  populated offline; identify the exact failing include/build step). Investigation
  and provisioning-level restore are in scope; mutating repo authority or the
  candidate numerics is NOT.

## Queued Issues (explicitly OUT of scope this round)

- **Gate-artifact env capture** (Codex queued): dsa result JSON doesn't record
  `AITER_TRITON_ONLY`. Reproducibility nit; note the exact command/env in the
  summary instead of changing harness output schema. Not a blocker.
- **Review-boundary / diff-base statement** (Codex queued): state the intended
  diff base (`3ddb2ea..HEAD` / candidate-local) explicitly in the final report.
  Documentation, not code.
- **Further dsa / index_score optimization**: dsa is at its profiled MFMA ceiling
  (QK lever closed); index_score is at its launch-config optimum. Re-touching
  either risks the accepted wins for no expected gain. Only a final no-regression
  re-confirmation is in scope.

## Concrete Success Criteria

**Clean completion (both MoE gates become runnable):**
- `module_quant` reference imports/builds; both MoE gates run gate-quality
  (`--repeat 10 --iterations 30 --warmup 3`), CORRECT pre- and post-timing,
  complete sweep, `shapes_regressed == 0`, ratios ≥ accepted baseline (or at least
  not regressed) with per-shape MFU/BW/ratio/calc_diff persisted JSON.
- Four-task official check assembled (dsa + index_score retained, both MoE fresh),
  no accepted win lost.
- `round-1-summary.md` reports honest full completion across all four tasks.

**Complete-with-caveats (restoration outside authority):**
- Concrete evidence that restoration cannot be done safely within my authority
  (no prebuilt `.so` present; CK requires network/rebuild I cannot perform; or
  rebuild would risk numeric drift vs the accepted baseline).
- MoE candidates left **untouched** (accepted first-loop wins preserved).
- `round-1-summary.md` revised from "CLEAN success" to **blocked /
  complete-with-caveats**: dsa win + index_score preservation stand on their own
  authoritative evidence; MoE explicitly reported as environment-blocked, not
  clean complete.

In **either** outcome, the summary's completion claim is corrected to match the
plan's stop conditions (AC-4): clean complete is disallowed while any of the four
authoritative gates is unavailable.
