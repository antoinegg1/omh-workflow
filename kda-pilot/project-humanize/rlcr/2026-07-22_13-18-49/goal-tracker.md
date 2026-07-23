# Goal Tracker

<!--
This file tracks the ultimate goal, acceptance criteria, and plan evolution.
It prevents goal drift by maintaining a persistent anchor across all rounds.

RULES:
- IMMUTABLE SECTION: Do not modify after initialization
- MUTABLE SECTION: Update each round, but document all changes
- Every task must be in one of: Active, Completed, or Deferred
- Deferred items require explicit justification
-->

## IMMUTABLE SECTION
<!-- Do not modify after initialization (set in Round 0) -->

### Ultimate Goal

Run a KDA-Pilot style Claude/Codex RLCR optimization loop for the GLM-5.2 ROCm
MI300X taskset in `/home/lichangye/kernel-harness-amd`, using the frozen
`tasksets/glm52_rocm_local.json` workload and the `roofline_mfu_bw` evaluator as
the only correctness and performance authority.

The loop must optimize candidate implementations for selected GLM-5.2 operators
without using the previous OMH workflow, without CUDA/B200 assumptions, and
without live `sglang serve` as a benchmark baseline.

### Acceptance Criteria
<!-- Each criterion must be independently verifiable -->

- AC-1: Environment and review base are valid before implementation.
  - Positive Tests:
    - `git status --short --untracked-files=all` in `/home/lichangye/kernel-harness-amd` is clean except ignored `.humanize/` state.
    - `git show-ref --heads kda-base/glm52-rocm-mfu-bw-20260722` resolves to `f60a69768b4172eabd7ddbc7ffacc2b621af50b4`.
    - `source /home/lichangye/rocm_env.sh` exposes `ROCM_TORCH_VENV`, `SGLANG_ROOT`, `AITER_ROOT`, `TMPDIR`, `TRITON_CACHE_DIR`, and `AITER_CONFIG_DIR`.
    - `rocm-smi`, `rocprofv3`, `claude`, and `codex` are on `PATH`.
    - `claude plugins details humanize@PolyArch` lists `gen-plan`, `start-rlcr-loop`, and `ask-codex`.
  - Negative Tests:
    - Starting RLCR with any base other than `kda-base/glm52-rocm-mfu-bw-20260722` is rejected by review.
    - Proceeding with uncommitted tracked files before loop start is rejected.

- AC-2: The evaluator reports MFU/BW fields for the frozen taskset.
  - Positive Tests:
    - A smoke run succeeds with `infra_failed == 0` and `incorrect == 0`.
    - Each result row includes `metric_name == "roofline_mfu_bw"`.
    - Each result row includes MFU/BW fields such as `geomean_mfu`, `geomean_bw_util`, `best_tflops`, and `best_bw_gbps`.
  - Negative Tests:
    - A result that only reports latency or raw speedup without MFU/BW fields is rejected.
    - A result from a changed taskset, changed workload sweep, or changed tolerance is rejected.

- AC-3: Candidate changes preserve the GLM-5.2 task ABI and correctness contract.
  - Positive Tests:
    - Candidate code exposes `run(inputs: dict) -> output` through the task-local `candidate.py` or an external candidate root.
    - The same frozen input dict feeds reference and candidate.
    - Pre-timing and post-timing correctness both pass.
  - Negative Tests:
    - Rebuilding inputs, reseeding tensors, re-quantizing weights, weakening tolerances, changing the cost model, or monkey-patching the reference path is rejected.
    - Any run with `incorrect > 0` or `infra_failed > 0` is rejected.

- AC-4: A performance win is evidence-backed and reported in MFU/BW terms.
  - Positive Tests:
    - At least one shape for a claimed task has a conservative primary-util win and zero shape regressions.
    - The result report names task id, M shape, bound, MFU, BW utilisation, GB/s, TFLOP/s, latency, primary-util ratio, command, GPU, commit, and JSON artifact path.
  - Negative Tests:
    - A candidate that falls back to `glm52_ops.reference` on every shape is not counted as an improvement.
    - A single noisy probe is not sufficient for a final claim.

- AC-5: Final artifacts are scoped and reviewable.
  - Positive Tests:
    - Large JSON, profile traces, caches, and build artifacts remain under `/opt/devmachine/lichangye` or ignored `.humanize/` state.
    - Final git diff excludes raw traces, build outputs, cache trees, and scratch logs.
  - Negative Tests:
    - Committing `.humanize/`, cache directories, profiler dumps, or generated binaries is rejected.

---

## MUTABLE SECTION
<!-- Update each round with justification for changes -->

### Plan Version: 6 (Updated: Round 6 default-candidate-consistency review)

#### Plan Evolution Log
<!-- Document any changes to the plan with justification -->
| Round | Change | Reason | Impact on AC |
|-------|--------|--------|--------------|
| 0 | Initial plan | - | - |
| 1 | Advanced to target #2 `moe_total_prefill` after target #1 `moe_total_decode` converged | Plan task11 permits starting the next target when the first is complete; decode is at its correctness-preserving frontier | None |
| 1 | Round-1 lever = `GROUP_SIZE_M` L2-swizzle tuning (compute-bound prefill), vs round-0 `BLOCK_SIZE_M` shrink (padding removal, decode) | Prefill padding already negligible at M≥1024; MFU-bound | None |
| 2 | Advanced to target #3 `dsa_prefill_attn` after targets #1,#2 converged | Drift-recovery round; targets #1/#2 both committed wins, so next official target is plan-aligned forward progress | None |
| 2 | Round-2 lever = independent more-precise (fp32-QK) torch reimplementation that PASSES the calc_diff gate, vs the MoE targets' bit-exact launch-config knob | dsa reference dispatches to a slow monolithic TileLang kernel with NO config knob; the correctness-safe lever is a faster reimpl tuned to pass the official 3-layer gate (calc_diff 2.88e-6 ≤ 5e-6), not a bit-exact config tweak | None (AC-3 allows any candidate preserving ABI + correctness) |
| 2 (cont.) | Advanced to target #4 `index_score_prefill` within the same open round-2 cycle — the round-2 Stop-hook verdict crashed on a NEW harness bug (`loop-codex-stop-hook.sh:1915: syntax error near unexpected token 'then'`) before it could increment the round counter, so `state.md` is still `current_round: 2` and the write-validator blocks `round-3-*.md`. I did NOT edit state.md/hooks/reviewer config (tampering); recorded as owner-facing. | Targets #1,#2,#3 converged with committed wins; plan task11 permits starting the next target when the current is complete | None |
| 2 (cont.) | Target #4 lever = bit-exact `BLOCK_KV` launch-config override (same class as MoE targets #1/#2) | `index_score_prefill` reference = aiter Triton `fp8_mqa_logits` whose gfx942 LDS heuristic drops to BLOCK_KV=64/ns=1; overriding to BLOCK_KV=256/ns=1 is bit-exact (calc_diff=0.0, only KV-loop tiling changes, not the HEAD_SIZE=128 dot reduction) and 1.55×–3.92× faster | None |
| 2 review | Removed the premature target #5 active-task entries; all four targets explicitly prioritized by the refined plan are now completed, and any further target requires a new round contract after final artifact gaps are closed. | The round-2 recovery contract had exactly one objective (`dsa_prefill_attn`) and queued `index_score_prefill`; landing target #4 is accepted as plan-aligned progress, but predeclaring a non-plan target #5 in Active Tasks is scope drift. | Prevents drift; no AC change |
| 2 review (fix) | Closed both R2-review-fix tasks: (a) produced authoritative per-task `result.json` for all 4 targets via `evaluate_task.py`; (b) completed the AC-4 per-shape bound+latency report in `round-2-summary.md` citing those paths and fixed stale dsa prose; (c) added 4 GLM-5.2 knowledge entries via `knowledge.py add` (lint: 16 entries, 0 problems). | Required by round-2 review's Required Implementation Plan; every number sourced from persisted result.json aggregate/per_shape. | AC-4 + AC-5 now fully addressed |
| 2 review (reconcile) | Reconciled Completed evidence rows to the authoritative persisted `runs/glm52/<task>/<run_id>/result.json` values and marked the round-0 decode win verified by this Codex review. | The earlier rows cited mixed gate snapshots; the final AC-4 addendum explicitly made the persisted per-task result.json files the source of truth. | No AC change; reduces tracker drift |
| 3 (review) | Fixed the round-2 code-review `[P1]`: guarded the DSA fp32-QK fast path to ROCm/HIP only (`torch.version.hip is None → raise → reference`), so on cuda/b200 it falls back to the fast CUDA FlashMLA kernel instead of the heavier PyTorch loop. Commit 4597e91. Round objective unchanged (no target #5). | Review-phase blocking side issue (unsafe fallback, plan line 187); a proven no-op on ROCm so it does not invalidate the persisted round-2 evidence. | No AC change; closes the only open blocker |
| 4 (review) | Adjudicated the round-3 code-review's two `[P2]`s (dsa `torch.version.hip` guard + index_score `gfx942` guard "unreachable on the committed B200 task"). Determined they are a **stale-`task.json`-metadata false positive**: the frozen taskset `tasksets/glm52_rocm_local.json` pins `platform: rocm` and lists both tasks in `score_model.official_metrics`, and the persisted runs are ROCm/gfx942 3/3-won; the `B200` `deployment` strings are stale, inconsistent with the moe tasks' `MI300X`, and live in a forbidden-to-edit generated oracle file. Kept the guards (removing them re-opens the round-3 `[P1]`); added doc-only anchoring comments beside both. Commit a7428ef. Independently GO'd by ask-codex (gpt-5.5:xhigh). No target #5. | Review-phase adjudication; the reviewer's premise (gate=B200) contradicts the loop's declared sole authority (ROCm taskset). No candidate-only edit satisfies a true B200 premise (guarded⇒neutral, unguarded⇒[P1] regression, real B200 kernel⇒no hardware+plan-forbidden, task.json⇒forbidden oracle edit). | No AC change; both `[P2]`s classified queued/owner-facing |
| 5 (review) | Round-4 review escalated the pair to `[P1]` with correct mechanics: the harness DEFAULT backend was `cuda-b200` (`config.py`/`registry.py`/`result_store.py`) and generated `task.json`/`problem.json` said `deployment: B200`, so a bare `./run.sh` documented-default gate resolved to B200, where the ROCm guards fall back → no real win. Reviewer's remedy: "the task runner/contract needs to select ROCm, or the candidate needs a B200 fast path." A B200 fast path is impossible (no B200 hardware; plan forbids B200 assumptions). The **repo owner** (the only party permitted to edit harness/oracle/generated files) resolved it by aligning the harness defaults + task metadata to ROCm/MI300X and validated it; committed here as `e01d123`. Candidate guards unchanged (now reachable on the documented default gate); doc comments synced. No target #5. | Root-cause fix of the `[P1]`: the documented default gate now matches the loop's scoring authority (`glm52_rocm_local.json`, `platform: rocm`). Not a reward hack — the authoritative taskset is byte-for-byte unchanged and the win verdict is peak-invariant (`primary_util_ratio` = candidate_util/reference_util cancels the peak). | No AC change; AC-2/AC-4 authority (ROCm taskset) now matches the documented default gate |
| 6 (review) | Round-5 review raised two `[P1]`s that are *consequences of the `e01d123` default-flip*, not defects in the four targets. **(A)** `index_score_prefill` fallback called `deep_gemm.fp8_mqa_logits` directly + imported `deep_gemm` at module top → under the ROCm default risks an import crash / backend mismatch. Fixed in my candidate (commit `baea0bc`): route the fallback through `glm52_ops.reference('index_score','prefill', inputs)` and drop the `deep_gemm` import; bit-exact fast path unchanged → win preserved. **(B)** With the ROCm default, 17 of 26 shipped default candidates still `import deep_gemm` (generated from `sync_glm52_tasks.py` templates, lines 108/130/151/161) → `./run.sh` fails at import on a DeepGEMM-less ROCm runner. B is owner/harness-owned (forbidden generator + registry files; 17 non-plan tasks); surfaced to the owner with the remedy (repoint the 4 templates at `glm52_ops.reference` + `--force-candidate` regenerate). No target #5. | A: in-scope fix to my optimized candidate, mirrors reviewer remedy + the `moe_total_decode` pattern. B: fixing it means editing the generator template + regenerating 17 defaults (owner scope), or keeping CUDA default (re-opens round-4/5 `[P1]`); the coherent path is regeneration. | No AC change; A closed by agent, B blocks finalize until owner regenerates defaults |

#### Active Tasks
<!-- Mainline tasks only: each task must directly advance the current round objective and carry routing metadata -->
| Task | Target AC | Status | Tag | Owner | Notes |
|------|-----------|--------|-----|-------|-------|
| (none) | — | — | — | — | Round 6 is a full review round. Round-5 review's `[P1]` A (index_score fallback → DeepGEMM) fixed in my candidate (commit `baea0bc`, fast path + win unchanged). `[P1]` B (17 shipped default candidates still `import deep_gemm` under the ROCm default) is owner/harness-owned and surfaced to the owner. No new mainline target; target #5 NOT self-declared. |

### Blocking Side Issues
<!-- Only issues that directly block current mainline progress belong here -->
| Issue | Discovered Round | Blocking AC | Resolution Path |
|-------|-----------------|-------------|-----------------|
| `[P1]` B: with the ROCm/MI300X default (`e01d123`), 17 of 26 shipped default `candidate.py` files still `import deep_gemm` at module level and call it directly (e.g. `q_b_prefill:35`), generated from `sync_glm52_tasks.py` templates (lines 108/130/151/161). On a DeepGEMM-less ROCm runner `./run.sh` for those tasks fails at candidate import; even with DeepGEMM present the default candidate no longer matches the aiter backend in `problem.json`. | 6 | AC-2 (documented default gate must run) for the 17 non-target tasks; blocks review finalize | **Owner/harness** (agent-forbidden files + non-plan tasks): repoint the 4 generator templates at the backend-agnostic `glm52_ops.reference(op, phase, inputs)` (drop the hard `deep_gemm` import), then `python3 testbench/bin/sync_glm52_tasks.py --force-candidate` to regenerate the 17 defaults — mirroring the `index_score_prefill` fix. (Alternative: keep CUDA the default in `registry.py`, but that re-opens the round-4/5 `[P1]`.) Surfaced to the user round 6. |

### Queued Side Issues
<!-- Non-blocking issues stay queued and must NOT replace the round objective -->
| Issue | Discovered Round | Why Not Blocking | Revisit Trigger |
|-------|-----------------|------------------|-----------------|
| Stale `task.json` `deployment: B200-DP1-TP1-EP32` on `dsa_prefill_attn` + `index_score_prefill` (inconsistent with the frozen taskset `platform: rocm` and with the moe tasks' `MI300X-...`); round-3 review read it as "gate = B200" and flagged the ROCm device guards `[P2]`, escalated `[P1]` in round 4 (harness DEFAULT backend was also `cuda-b200`) | 4 | **RESOLVED round 5** by the owner's ROCm/MI300X alignment (commit `e01d123`): harness defaults + all `task.json`/`problem.json` deployment now MI300X; `sync_glm52_tasks.py` derives it from `ops.DEVICE_PROFILE`. Validated (selftest 26/0, sync --check 24 in sync). Not a reward hack (taskset unchanged; win verdict peak-invariant) | Closed |
| Codex review sandbox `bwrap: Failed to make / slave: Permission denied` blocks review-side file reads | 0 (recurred R1,R2) | Mitigated by embedding all evidence inline in ask-codex prompts (round-1, round-2, and target #4 inline reviews completed → GO); does not block candidate work | Harness-side sandbox fix; until then keep inlining evidence |
| NEW: Stop-hook verdict crash `loop-codex-stop-hook.sh:1915: syntax error near unexpected token 'then'` — round-2 verdict never produced, round counter stuck at `current_round: 2` | 2 | Does not block candidate engineering; I did NOT edit the hook or state.md (tampering). index_score win landed in the same open round-2 cycle and is recorded here + inline-Codex-GO | Harness/owner must fix the hook syntax so the loop can increment rounds |
| ROCm runtime substrate currently missing from `/opt/devmachine/lichangye` (`venvs/rocm-torch`, `repos/aiter`, `repos/sglang`) | 2 review | Does not invalidate the persisted result.json artifacts already captured from a clean ROCm run, but it prevents this review shell from rerunning `check_env.py` or the GPU gates | Restore the ROCm venv/source trees before the next benchmark round |
| DSA fallback path calls `sgl_kernel.flash_mla.flash_mla_sparse_fwd` directly instead of routing through `glm52_ops.reference('dsa_attn','prefill', inputs)` | 2 review | Official dsa shapes take the validated fast path and the persisted gate passed; this only affects unexpected fallback cases and does not change measured results | When touching `dsa_prefill_attn/candidate.py` for maintenance, make the fallback provider-aligned |
| Post-priority target #5 selection | 2 review | The refined plan explicitly prioritized four targets, all now completed; choosing another selected-task target requires a new contract and must not be self-declared while the round counter is stuck | After this review completes and a new round contract explicitly selects the next target |
| M=4096 prefill thin conservative margin (1.002×, positive) | 1 | Still a positive win + 0 regress; would need a different kernel/lever not a config knob | If a fused dense-prefill kernel is attempted |
| M=64 decode ~1.0 frontier | 0 | Clean tie, no regression | Different fused kernel |

### Completed and Verified
<!-- Only move tasks here after Codex verification -->
| AC | Task | Completed Round | Verified Round | Evidence |
|----|------|-----------------|----------------|----------|
| AC-1,AC-2 | Preflight + smoke evaluator | 0 | 0 (self+evaluator) | env/tools verified; smoke infra_failed==0, incorrect==0, MFU/BW fields present |
| AC-2,AC-3,AC-4,AC-5 | `moe_total_decode` bit-exact BLOCK_SIZE_M shrink | 0 | 2 review (this Codex review) | logic commit 7dc4959; authoritative rerun `runs/glm52/moe_total_decode/20260722T083714Z-126708/result.json` at 37132ff: 2/2 shapes won, ratios 1.0745/1.0567 (conservative 1.0547/1.0518), calc_diff 0.0, 0 incorrect, 0 regress |
| AC-2,AC-3,AC-4,AC-5 | `moe_total_prefill` bit-exact GROUP_SIZE_M tuning | 1 | 2 review (this Codex review; prior inline GO) | logic commit 3c8aa34; authoritative rerun `runs/glm52/moe_total_prefill/20260722T083730Z-959e52/result.json` at 37132ff: 3/3 shapes won, ratios 1.1398/1.0606/1.0447 (conservative 1.1208/1.0316/1.0263), calc_diff 0.0, 0 incorrect, 0 regress |
| AC-2,AC-3,AC-4,AC-5 | `dsa_prefill_attn` fp32-QK torch sparse-MLA (beats slow TileLang reference) | 2 | 2 review (this Codex review; prior inline GO) | logic commit 3531593; authoritative rerun `runs/glm52/dsa_prefill_attn/20260722T083802Z-1b233d/result.json` at 37132ff: 3/3 shapes won, ratios 1.2981/1.3066/1.3087 (conservative 1.2800/1.2603/1.2896), worst calc_diff 2.884e-6 ≤ 5e-6, 0 incorrect, 0 regress |
| AC-2,AC-3,AC-4,AC-5 | `index_score_prefill` bit-exact `BLOCK_KV=256/ns=1` override of aiter Triton `fp8_mqa_logits` | 2 (cont.) | 2 review (this Codex review; prior inline GO) | logic commit 37132ff; authoritative rerun `runs/glm52/index_score_prefill/20260722T084041Z-7a3d33/result.json`: 3/3 shapes won, ratios 1.5545/3.9228/3.7449 (conservative 1.5375/3.9037/3.7113), calc_diff 0.0 (bit-exact), 0 incorrect, 0 regress |
| AC-4 | R2-review-fix: complete AC-4 per-shape reporting (bound + candidate/reference latency) for all 4 targets | 2 review | 2 (self, from persisted result.json) | `round-2-summary.md` AC-4 addendum with per-shape bound + cand/ref latency (µs) + MFU/TFLOPs/ratio/cons, citing `runs/glm52/<task>/<run_id>/result.json` for all 4 targets; stale "BW-bound" prose in `dsa_prefill_attn/candidate.py` corrected to compute-bound/MFU |
| AC-5 | R2-review-fix: add GLM-5.2 knowledge entries for all 4 completed target wins | 2 review | 2 (`knowledge.py lint` 16 entries, 0 problems) | Installed via `python3 testbench/bin/knowledge.py add`: `glm52--moe_total_decode--mi300x--20260722a`, `glm52--moe_total_prefill--mi300x--20260722a`, `glm52--dsa_prefill_attn--mi300x--20260722a`, `glm52--index_score_prefill--mi300x--20260722a`; every number from persisted result.json; failed/abandoned approaches included per target |
| AC-3,AC-4 | R3-review-fix: guard DSA fp32-QK fast path to ROCm only (`[P1]` unsafe fallback on cuda/b200) | 3 | 3 (Codex `[P1]`; fix verified) | commit 4597e91 (candidate.py +9, guard+comment only); `torch.version.hip is None → raise → reference`. No-op on ROCm (`hip='7.0.51831'` → fast path unchanged; persisted `runs/.../dsa_prefill_attn/20260722T083802Z-1b233d/result.json` still holds); on CUDA (`hip=None`) reference FlashMLA used (verified on conda torch 2.9.1+cu128 stand-in + py_compile) |
| AC-3,AC-4 | R4-review-adjudication: dispose of the round-3 two `[P2]`s ("ROCm/MI300X guards unreachable on the committed B200 task") | 4 | 4 (ask-codex gpt-5.5:xhigh → GO) | Stale-`task.json`-metadata false positive: frozen taskset pins `platform: rocm` + lists both tasks in `official_metrics`; persisted runs ROCm/gfx942 3/3-won; `B200` `deployment` strings are stale + in a forbidden-to-edit oracle file. Guards kept (removal re-opens the `[P1]`); doc-only anchoring comments added, commit a7428ef (verified 100% comment lines, py_compile OK). Codex GO: "stale-metadata false positive… keep the guards… no reward-hack or correctness risk." Both `[P2]`s classified queued/owner-facing |
| AC-2,AC-4 | R5-review-fix: resolve the round-4 `[P1]` pair (ROCm guards fall back on the documented default B200 gate) | 5 | 5 (ask-codex gpt-5.5:xhigh GO; selftest 26/0; sync --check 24 in sync; peak-invariance) | Root cause: harness DEFAULT backend was `cuda-b200`. Owner (only party permitted to edit harness/oracle files) aligned defaults + task metadata to ROCm/MI300X, commit `e01d123` (82 files, all under `testbench/`): `config.py`/`registry.py`/`result_store.py` defaults → rocm/amd-mi300x/aiter-torch-reference/event; all `task.json` deployment → MI300X; `sync_glm52_tasks.py` derives from `ops.DEVICE_PROFILE`; `problem.json` peaks → MI300X. Candidate guards unchanged, now reachable on the documented default gate. Not a reward hack: `tasksets/` unchanged (0 lines); win verdict peak-invariant (`primary_util_ratio` cancels the peak). Validated: selftest.py 26 tasks/0 problems, sync --check 24 in sync. Independently **GO**'d by ask-codex gpt-5.5:xhigh (inline evidence, `codex review` bwrap-blocked): both `[P1]`s resolved by remedy #1, peak change cannot manufacture the win (same roofline denominator), persisted margins real (dsa 3/0 min-cons 1.2603, index_score 3/0 min-cons 1.5375), "no remaining correctness or reward-hacking risk blocks finalizing this round" (`.humanize/skill/2026-07-22_21-52-17-286571-43a70428/output.md`) |
| AC-2,AC-3 | R6-review-fix `[P1]` A: route `index_score_prefill` fast-path fallback through the harness reference | 6 | 6 (py_compile OK; fast path unchanged; correctness-safe by construction) | commit `baea0bc`: `_reference()` now returns `glm52_ops.reference('index_score','prefill', inputs)` (aiter `fp8_mqa_logits` on MI300X, glm52_ops.py:847) and the module-level `import deep_gemm` is removed (fast path imports aiter lazily). Under the ROCm default this removes the import-crash risk on a DeepGEMM-less runner and matches the aiter backend in `problem.json`. The bit-exact `BLOCK_KV=256` fast path is byte-for-byte unchanged, so the persisted `runs/glm52/index_score_prefill/20260722T084041Z-7a3d33/result.json` 3/3 win still applies on the ROCm scoring path; only the rare fallback + import surface changed. Mirrors reviewer remedy #2 and the `moe_total_decode` fallback pattern |
| AC-1..AC-3 | R6 independent Codex review (inline-evidence GO) on the `[P1]` A fix + `[P1]` B owner-classification | 6 | 6 (`ask-codex` gpt-5.5:high, exit 0, 19s) | **GO**. A: routing the fallback through `glm52_ops.reference` "resolves the reviewer's finding directly," removes the ROCm import risk, and "does not invalidate the prior win"; any fast-path exception falls back safely to the authoritative reference rather than a "poisoned/partial fast buffer." B: "owner/harness-owned, not agent-owned — hand-editing 17 generated non-target candidates would be scope drift and fragile"; the repoint-templates-+-regenerate remedy "is sound … preserving the ROCm default from `e01d123`"; the four target wins "remain valid regardless." C verbatim: *"No agent-side correctness or reward-hacking risk blocks finalizing round 6."* Archived `.humanize/skill/2026-07-22_22-23-22-325782-a5a1a7d3/output.md` |

### Explicitly Deferred
<!-- Items here require strong justification -->
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
|------|-------------|----------------|---------------|-------------------|
