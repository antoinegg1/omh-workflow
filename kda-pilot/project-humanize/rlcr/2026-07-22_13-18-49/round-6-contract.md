# Round 6 Contract

## Round Type

**Full review round** (`full_review_round: 6`). The Stop-hook ran the round-5 code review of the
committed ROCm/MI300X alignment (`e01d123`) and raised **two `[P1]`s** that are *consequences of
that default-backend flip*, not defects in the four optimized targets. No new mainline target is
selected; **target #5 is explicitly NOT selected.**

## Mainline Objective (unchanged)

Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`). The only
work this round is to clear the round-5 blocking findings. Objective is stable; no features.

## The two `[P1]` findings, verified

Both stem from the same root: `e01d123` flipped the harness **default** backend from `cuda-b200`
to `rocm/amd-mi300x` (to fix rounds 4–5), but the harness's shipped **default candidates** still
call CUDA DeepGEMM directly.

### `[P1]` A — index_score_prefill fallback calls DeepGEMM (candidate.py:72-73) — **MINE, FIXED**

- **Finding**: when the fast path is skipped (non-gfx942, gluon active, heuristic already large,
  shape/dtype surprise), the fallback `_reference()` called `deep_gemm.fp8_mqa_logits(...)`
  directly, and the module imported `deep_gemm` at top level. Under the ROCm default that risks an
  import crash on a DeepGEMM-less MI300X runner and does not match the aiter backend in
  `problem.json`.
- **Lane**: `[blocking]`. This is one of my four optimized candidates → in-scope to fix.
- **Fix** (commit `baea0bc`): route the fallback through `glm52_ops.reference(OP, PHASE, inputs)`
  (`OP='index_score'`, `PHASE='prefill'`) — the selected backend's authoritative oracle, which on
  MI300X dispatches to aiter `fp8_mqa_logits` (glm52_ops.py:847) — and drop the module-level
  `deep_gemm` import (now unused; the bit-exact fast path imports aiter lazily). The
  `BLOCK_KV=256` fast path is byte-for-byte unchanged, so the persisted 3/3 win holds; only the
  rare fallback + import surface changed. `py_compile` OK; `deep_gemm` now appears only in
  docstring prose.

### `[P1]` B — default backend selects ROCm while default candidates are CUDA (registry.py:48) — **OWNER / HARNESS**

- **Finding**: with no `KERNEL_HARNESS_*` env, the default now selects ROCm/MI300X for every task,
  but **17 of 26** task-local default `candidate.py` files still `import deep_gemm` at module level
  and call it directly (e.g. `q_b_prefill:35` → `deep_gemm.fp8_gemm_nt`). On a ROCm runner without
  DeepGEMM, `./run.sh` for those tasks fails at candidate import. Remedy named by the reviewer:
  *"either keep CUDA as the default until the candidates are ported, or regenerate the default
  candidates to call the selected backend reference."*
- **Lane**: `[blocking]` but **owner/harness-owned — cannot be fixed by the agent**:
  - The 17 defaults are **generated** by `testbench/bin/sync_glm52_tasks.py` from per-family
    templates that hardcode `import deep_gemm` (lines 108 `gemm`, 130 `moe`, 151 `score_prefill`,
    161 `score_decode`). The generator is a harness file outside the agent's permitted edit scope;
    candidate.py is "NEVER overwritten if it already exists" (sync line 12), so regeneration needs
    the owner's `--force-candidate`.
  - `registry.py:48` (the default backend) is likewise a forbidden-to-agent harness file.
  - Those 20 tasks are **outside the refined plan's four targets**; hand-editing them would be
    scope drift and would diverge from the generator template.
- **Resolution path (owner)**: update the four `sync_glm52_tasks.py` templates to call the
  backend-agnostic `glm52_ops.reference(op, phase, inputs)` instead of `deep_gemm.*` (and drop the
  hard import), then `sync_glm52_tasks.py --force-candidate` to regenerate the 17 defaults. This
  mirrors the fix just applied to `index_score_prefill` and matches the reviewer's remedy #2.
  Surfaced to the user/owner for the decision (regenerate vs. keep CUDA default).

## Why the four target wins are unaffected

- On the ROCm scoring runner all four fast paths engage; `index_score_prefill`'s fast path is
  unchanged by `baea0bc`, and the other three never touched `deep_gemm`.
- `[P1]` B is about the *other 17 default candidates'* import-safety on a DeepGEMM-less runner, not
  about the four targets' correctness or measured ratios. `tasksets/` remains byte-for-byte
  unchanged; the persisted per-task result.json artifacts stand.

## Acceptance for this round

- `[P1]` A fixed at root in the agent's candidate (commit `baea0bc`), fast path + win preserved.
- `[P1]` B correctly classified as an owner/harness action (generator templates + registry default
  + `--force-candidate` regenerate), surfaced to the user; no agent edit to forbidden harness files
  or non-target candidates.
- `goal-tracker.md` reconciled; `round-6-summary.md` written.
