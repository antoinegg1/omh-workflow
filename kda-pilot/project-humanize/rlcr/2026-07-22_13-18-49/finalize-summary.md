# Finalize Phase Summary

## Round context
Finalize Phase after the round-6 Codex review passed (GO). The four plan-prioritized GLM-5.2
ROCm/MI300X targets (`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`,
`index_score_prefill`) were already landed and independently Codex-verified; the round-6 `[P1]` A
fix (`index_score_prefill` fallback → harness reference, commit `baea0bc`) was in place. This phase
was a functionality-equivalent simplification pass only.

## Simplifier scope (and why it was tight)
The `code-simplifier:code-simplifier` agent is not installed in this environment, so the pass was
run via the `general-purpose` agent under identical, strict guardrails, and every resulting hunk was
re-reviewed by hand against `git diff` before acceptance.

Scope was restricted to the **four sanctioned candidate files only**. Everything else in the
`kda-base/glm52-rocm-mfu-bw-20260722...codex/amd-glm52-rocm-evalbench-v2` range
(`config.py`, `registry.py`, `glm52_ops.py`, `result_store.py`, `sync_glm52_tasks.py`,
`bw_ceiling.py`, `knowledge.py`, all `task.json`/`problem.json`/`README.md`, knowledge entries) is
owner/harness-owned and was **not** touched.

These candidates are **bit-exact correctness-critical**: each drives the reference's OWN
Triton/aiter kernels with a numerically-identical but faster launch config, and the gate is DeepGEMM
`calc_diff ≤ 5e-6` on an fp8/bf16 saturation cliff. Any change to executable logic (kernel-launch
args, numeric constants, guards, dtype/precision ops, config overrides, control flow) risks silently
breaking correctness, and the live ROCm gate cannot be run in this shell (hardware/substrate absent).
So only provably behavior-preserving cleanups were eligible.

## Simplifications made
Exactly one class of change, applied to two files — remove the unused `N` from the `w1.shape`
unpack:

- `testbench/tasks/glm52/moe_total_decode/candidate.py` (in `_fast_moe_total_decode`):
  `E, N, _ = w1.shape` → `E, _, _ = w1.shape`
- `testbench/tasks/glm52/moe_total_prefill/candidate.py` (in `_fast_moe_total_prefill`):
  `E, N, _ = w1.shape` → `E, _, _ = w1.shape`

**Proof it is functionally-equivalent:** `N` (= `w1.shape[1]`) is never read in either function
(verified by grep + the subagent's AST store-vs-load pass; the only remaining `N` token is a
docstring `BLOCK_SIZE_M/N/K` mention). Renaming the unused middle target to `_` keeps the unpack
arity at exactly 3, so the implicit shape validation is intact — a non-3-element `w1.shape` still
raises `ValueError`, which `run()`'s `try/except` still catches and routes to
`glm52_ops.reference(...)`. `E` remains bound and used (`topk != E`, `moe_align_block_size(..., E)`).
No kernel-launch argument, numeric constant, guard, dtype/precision op, config-override, or
control-flow element is affected. Because the change is a pure unused-variable rename, the computed
output tensors and timings are unchanged, so the persisted per-task wins still apply and no re-gate
is required.

## Files modified during Finalize Phase
- `testbench/tasks/glm52/moe_total_decode/candidate.py` (1 line)
- `testbench/tasks/glm52/moe_total_prefill/candidate.py` (1 line)

Committed as **`5efb3cf`** — "moe_total_{decode,prefill}: drop unused N from w1.shape unpack
(finalize cleanup)".

## Considered but deliberately NOT changed
- **`dsa_prefill_attn/candidate.py` and `index_score_prefill/candidate.py`:** left entirely
  untouched. AST analysis found zero assigned-but-unused locals; every binding (`kv2`, `idx`,
  `sm_scale`, `d_v`, `s_q`, `n_heads`, `topk`, `seq_len_kv`, the stride tuples, `scale_mul`, …) is
  read downstream.
- **Cross-file dedup of the two `moe_total_*` files** (they share the ~40-line
  `_fused_moe_kernel_sequence(...)` call and input-unpacking boilerplate): rejected. The harness
  contract loads each `candidate.py` standalone (`./run.sh --candidate PATH`), so a candidate must be
  self-contained; a shared helper module would be an out-of-scope harness file and would break that
  contract.
- **`E = w1.shape[0]` form:** rejected — it would drop the 3-element arity check that currently
  forces a correctness fallback on a malformed `w1`.
- **All bit-exactness-carrying logic** — the lazy in-function `import sglang…`/`from aiter…`
  (intentionally kept import-safe), the `try/except` fallback bodies, every `_fused_moe_kernel_sequence`
  / `_fp8_mqa_logits_kernel` / `flash_mla_sparse_fwd` kwarg, numeric constants (`M > 32`, `m <= 1024`,
  `BLOCK_KV=256`, `num_stages=1`, `matrix_instr_nonkdim` 16/32, the fnuz `0.5`/`2.0` scale
  compensation, `chunk=256`), guards (`topk != E`, `arch != "gfx942"`, gluon check,
  `_gfx942_tile_fits_lds`, `torch.version.hip is None`, `GROUP_SIZE_M already optimal`),
  config-override logic, and all rationale comments/docstrings — frozen verbatim.

## Test / validation status
- `python3 -m py_compile` on all four candidates → **OK**.
- `python3 testbench/bin/selftest.py` → **26 tasks, 0 problems** (exit 0) — every candidate still
  imports cleanly and defines `run(inputs)`.
- Working tree after commit is clean; the only changed files were the two moe candidates.
- Live ROCm/MI300X gate not run (hardware/substrate absent in this shell) and not required: the sole
  change is a provable no-op, so the persisted per-task wins
  (`moe_total_decode` 2/2, `moe_total_prefill` 3/3, `dsa_prefill_attn` 3/3, `index_score_prefill`
  3/3) stand unchanged.

## Non-blocking follow-up (owner-owned; outside finalize scope)
- `[P1]` B remains open and owner-owned: under the ROCm/MI300X default (`e01d123`), **17 of 26**
  shipped default candidates (all **non-target**) still `import deep_gemm` at module level, so a bare
  `./run.sh` for those tasks fails at import on a DeepGEMM-less ROCm runner. The durable fix is to
  repoint the four `sync_glm52_tasks.py` templates at `glm52_ops.reference(op, phase, inputs)` and
  `--force-candidate` regenerate. This does not affect the four optimized targets (their fast paths
  engage on the ROCm scoring runner; `index_score`'s fallback is now backend-agnostic). Documented in
  `round-6-contract.md` / `round-6-summary.md` and surfaced to the owner.

## Notes
- No new features; no target #5 selected. Simplification only.
- The honest outcome for these tightly-written, already-reviewed bit-exact files is that the single
  correctness-neutral cleanup available (the `N` → `_` rename) is the whole of the finalize delta.
