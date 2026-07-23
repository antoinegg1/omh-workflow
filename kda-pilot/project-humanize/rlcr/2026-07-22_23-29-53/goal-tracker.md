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
<!-- Do not modify after initialization -->

### Ultimate Goal

Start a second KDA-Pilot style Claude/Codex RLCR optimization loop for
`/home/lichangye/kernel-harness-amd`.

This loop treats the first KDA-Pilot result as the accepted baseline and tries to
increase performance as much as practical, while preserving the kernel-harness
standard:

- every evaluated shape must remain correct;
- no shape may regress under the conservative primary-util gate;
- taskset, workload, correctness thresholds, reference paths, cost model,
  deployment metadata, and scoring semantics must remain unchanged.

The objective is not merely to pass the official gate again. The objective is to
maximize the official ROCm/MI300X `roofline_mfu_bw` outcomes without losing any
accepted win.

### Accepted Baseline (first-loop, the numbers to beat)

| Task | Geomean primary-util ratio | Min conservative ratio | Geomean MFU | Geomean BW util | Worst calc_diff |
|------|----------------------------|------------------------|-------------|-----------------|-----------------|
| `moe_total_decode`    | 1.0655 | 1.0518 | 0.030953 | 0.340746 | 0 |
| `moe_total_prefill`   | 1.0809 | 1.0263 | 0.266527 | 0.061196 | 0 |
| `dsa_prefill_attn`    | 1.3044 | 1.2603 | 0.034010 | 0.005563 | 2.8841951178470993e-06 |
| `index_score_prefill` | 2.8371 | 1.5375 | 0.121637 | 0.030325 | 0 |

### Acceptance Criteria

**AC-1 — Preflight authority is frozen.** Working tree clean before impl; taskset
`tasksets/glm52_rocm_local.json`, `score_model.official_metrics` (the four tasks),
and hardware selection `rocm/amd-mi300x/aiter-torch-reference/event` unchanged;
`selftest.py` and `sync_glm52_tasks.py --check` pass. No change to taskset
membership, workload axes, correctness thresholds, reference functions, cost model,
device peaks, timing semantics, or deployment metadata. No branch switch (stay on
`codex/amd-glm52-rocm-evalbench-v2`).

**AC-2 — Correctness and no-regression are hard constraints.** Every modified task
passes pre- and post-timing correctness on every evaluated shape; every official
task keeps `shapes_regressed == 0`; accepted wins are not lost. A changed task must
improve at least one of `geomean_primary_util_ratio`,
`geomean_primary_util_ratio_conservative`, `min_primary_util_ratio_conservative`,
or `shapes_won`, with `shapes_regressed == 0`. Reference-only fallback on every
shape, or a single `--repeat 1` probe, is not acceptable.

**AC-3 — Maximize under constraints.** Primary: maximize
`geomean_primary_util_ratio` across the four official metrics with no conservative
regressions. Secondary: improve `min_primary_util_ratio_conservative`, raise
`shapes_won`, improve absolute MFU (compute-bound) / BW util (memory-bound). Prefer
small candidate-local changes.

**AC-4 — Evidence comparable to baseline.** Per claimed win report candidate+ref
latency, bound, MFU, BW util, TFLOP/s, GB/s, primary-util ratio, conservative
ratio, calc_diff per shape; persist result JSON; compare against the baseline
table. If the authoritative gate cannot run for a task, its status is
blocked / complete-with-caveats, never clean complete.

**AC-5 — Final diff reviewable.** Diff excludes `.humanize/`, traces, caches,
binaries, build outputs, scratch logs; changes documented per task/shape; every
no-go recorded with bottleneck + stop reason. No broad harness/metadata refactors
without owner authorization.

---

## MUTABLE SECTION
<!-- Update each round with justification for changes -->

### Plan Version: 7 (Updated: Round 5 review — resolved the single [P3] code-review finding; archived plot rebuild reads committed result.json)

#### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
|-------|--------|--------|--------------|
| 0 | Initial plan | - | - |
| 0 | Scope round-0 optimization to `dsa_prefill_attn` + `index_score_prefill` only; MoE tasks routed around, not modified | Restored env's aiter is incomplete (empty CK submodule → no `module_quant.so`), so the MoE fp8 **reference** cannot run → authoritative gate returns `incorrect` for both MoE tasks. Not fixable within frozen repo authority; needs env owner. See Blocking Side Issues. | AC-4 (MoE gate unavailable → MoE stays complete-with-caveats). AC-2/AC-3 pursued on the two gate-runnable tasks. MoE candidates left untouched so their accepted wins are not lost. |
| 0 | Chose dsa QK optimization direction = aiter `batched_gemm_bf16` + caller-preallocated **fp32 `YQ`** output (realizes bf16-in/fp32-out MFMA via a tuned lib), over a custom Triton QK kernel | Codex (task4 analyze) green-lit: the tuned lib is lower-risk than hand-written Triton and the fp32-YQ trick keeps logits bit-identical to the fp32 einsum (calc_diff unchanged), so it improves MFU with zero precision/correctness cost. Candidate-local only. | AC-2 (correctness preserved: calc_diff 2.884e-6 unchanged), AC-3 (MFU 0.034→0.055, geomean ratio 1.30→2.12), AC-5 (change confined to `candidate.py`). |
| 0 review | Clean completion rejected; keep dsa win, but original plan remains incomplete until MoE official tasks are gate-runnable and re-verified | Review confirmed the dsa improvement and index_score preservation, but `moe_total_decode`/`moe_total_prefill` still return authoritative `INCORRECT` due environment import/build failures. The original plan requires a final four-task check and says unavailable gates must be blocked/complete-with-caveats, not clean complete. | AC-2/AC-4 still blocked for MoE; AC-3 advanced via dsa but not complete across all four official metrics. |
| 1 | Restore the incomplete aiter reference env **within provisioning authority** so the MoE gates become runnable; run the four-task final check | `git submodule update --init 3rdparty/composable_kernel` pinned CK to aiter's OWN referenced commit `b67594561`; aiter JIT-built its own `module_quant.so` (2848344 B). Zero numeric drift, MoE candidates untouched, no harness/authority edit. This is the single lever that unblocks AC-2/AC-4 for MoE without violating the frozen authority. | AC-4 (MoE gates now runnable → status becomes completion-with-caveats, not blocked); AC-2 (both MoE `shapes_regressed==0`, calc_diff 0, candidates untouched). |
| 1 | Report MoE as **net-positive with softened tail-shape margins**, not a clean beat of every baseline number | The freshly-built pinned-CK reference runs slightly faster on tail shapes than whatever produced the stale baseline JSON, so the numerically-identical MoE candidate's margin softened (decode 1.0655→1.055, prefill 1.0809→1.0406; one tail shape each win→neutral; min_cons 0.9938/0.9714 into the neutral band). This is reference-attributable and harness-uncounted (`shapes_regressed==0`), NOT a candidate regression. Reported as a transparent caveat, not "fixed" by degrading the reference. | AC-4 (honest evidence: completion-with-caveats); AC-2 (hard constraints still hold: correct + `shapes_regressed==0` + ≥1 win). |
| 1 review | Completion claim rejected until MoE accepted-win preservation is restored or owner-authorized plan revision exists | Review verified the env restoration and MoE correctness, but the final check no longer preserves the accepted MoE win profile: `moe_total_decode` drops from 2/2 wins to 1/2 (M32 neutral, min_cons 1.0518→0.9938) and `moe_total_prefill` drops from 3/3 wins to 2/3 (M4096 neutral, min_cons 1.0263→0.9714). The original plan and Round-1 contract both require no accepted win lost, not just `shapes_regressed==0`. | AC-4 advanced (gates runnable/evidence available); AC-2/AC-3 remain active for MoE tail-shape margin recovery. |
| 2 | Recover both softened MoE tail-shape wins with candidate-local bit-exact scheduling sweeps under the FIXED pinned-CK reference | prefill M=4096: a `GROUP_SIZE_M ∈ {1,2,4,8,16,32}` sweep showed the optimum SHIFTED under the faster restored reference (old pick GM=4 → neutral; GM=16 wins, cons 1.0103→gated 1.0108/1.0105 at `--repeat 10` ×2, calc_diff 0.0) → changed `_pick_group_size_m` to return 16 for M≥4096 (commit `017bfdc`). decode M=32: a `BLOCK_SIZE_M ∈ {16,32,64,128}` sweep showed the current pick (BM=32) is already the widest-margin win; the R1 neutral was timing noise — re-gating the unchanged candidate at `--repeat 10` ×2 returned 2/2 wins → NO code change. `BLOCK_SIZE_K` left untouched, so calc_diff stays 0.0. | AC-2 (both MoE tasks back to full accepted-win profile: decode 2/2, prefill 3/3; `shapes_regressed==0`, calc_diff 0 on every official shape; dsa/index_score unlost). AC-3 (both tails neutral→win; margins at the bit-exact ceiling under the restored reference). AC-5 (one candidate-local file changed). |
| 2 review | Kernel result accepted, but clean closure rejected until the required append-only `testbench/knowledge` entry is added | Review verified the Round-2 MoE recovery artifacts, candidate hashes, clean tree, frozen authority, selftest, and sync check. However, the repo guide requires one structured `testbench/knowledge` entry per completed optimization session, and no new entry was appended after the Round-2 MoE tail-shape work; `.humanize/bitlesson.md` is not a substitute for the harness knowledge base. | AC-5/finalization remains active until the missing knowledge entry is drafted from `result.json` facts and installed with `python3 testbench/bin/knowledge.py add`. |
| 3 | Install the required append-only `testbench/knowledge` entry for the Round-2 `moe_total_prefill` recovery session (data-only; no kernel/gate change) | Entry `glm52--moe_total_prefill--mi300x--20260723a` drafted from persisted committed-candidate gate facts only (`kda_round2_moe_prefill_official_r10b.json`, run `20260723T043507Z-daddf4`; its `candidate.sha256` verified == committed `candidate.py` → describes commit `017bfdc`); records the `GROUP_SIZE_M` sweep (GM=16 winner at M≥4096) + companion decode `BLOCK_SIZE_M` preservation check. Installed via `knowledge.py add`; `lint` → 17 entries / 0 problems; committed `1a315c6` (one file, +79). add-only left generated `queries/*.md`/`distilled.*` stale. | AC-4 honored (every entry number traces to a persisted `result.json`). AC-5 entry-recording requirement addressed, but Round-3 review keeps finalization active until generated KB freshness checks pass. |
| 3 review | Clean closure rejected until generated KB bookkeeping matches the Round-3 contract's own definition of done | Round-3 contract explicitly required `knowledge.py index --check` and `knowledge.py distill --check` to be green, regenerated if needed. Review verified `lint`/`query` pass and the entry's result facts match the persisted gate, but `index --check` still reports 3 stale tracked `queries/*.md` files and `distill --check` reports stale `distilled.{json,md}`. | AC-5/task10 remains active until the generated KB outputs are regenerated and committed, then all four knowledge validators pass. |
| 4 | Regenerate the git-tracked generated KB bookkeeping so all four `knowledge.py` validators pass (data-only; no kernel/gate/authority change) | Round-3 left `queries/{by-op,by-bottleneck,by-technique}.md` and `distilled.{json,md}` stale under an "add-only" rationale that contradicted the Round-3 contract's own DoD (Codex ruled it an unjustified deferral). `knowledge.py index` + `distill` folded all five glm52 MI300X entries (`generated_from_entries` 12→17) into the views; diff bounded to exactly 5 generated files (+286/-2); `lint` 17/0, `query` returns the entry, `index --check` 0 stale, `distill --check` up to date; committed `7202073`. | AC-5 finalization satisfied (Round-3 DoD met, diff reviewable). AC-1 held (selftest 26/0, sync 24 in-sync; only generated KB docs changed). |
| 5 review | Fix the single [P3] code-review finding: archived plot-rebuild helper read a gitignored run cache (data-only; no kernel/gate/authority change) | `codex review --base kda-base/glm52-rocm-mfu-bw-20260722` found `build_token_perf.py:final_result()` read `runs/glm52/<task>/<run_id>/result.json`, but `runs/` is gitignored (`.gitignore:31`), so the documented rebuild command fails on a fresh checkout. Redirected the read to the committed `archive/0720-Best-GLM-52/lichangye/<task>/result.json` (cache fallback retained), added a `run_id` provenance assertion, and set `source` to the archived path. One file, `archive:` scope, committed `d5114877`. | AC-5 (committed rebuild helper now depends only on committed inputs; diff bounded to one archive file, documented). AC-1 held (no candidate/reference/taskset/metric/harness/knowledge change; selftest 26/0, all knowledge validators still green). |

#### Active Tasks
<!-- Mainline tasks only -->
| Task | Target AC | Status | Tag | Owner | Notes |
|------|-----------|--------|-----|-------|-------|
| task1 Preflight verification | AC-1, AC-4 | completed | coding | claude | Tree clean, correct branch. Gate runs for dsa+index_score; MoE gate blocked by env (see below). |
| task2 Baseline headroom analysis | AC-3, AC-4 | completed | analyze | codex | dsa = only remaining lever (index_score at launch-config optimum; MoE env-blocked). |
| task3 Inspect task contract & candidate | AC-2, AC-4 | completed | coding | claude | dsa candidate = chunked torch sparse-attn; QK fp32 einsum ~60% of runtime, no MFMA. |
| task4 Decide optimization direction | AC-2, AC-3 | completed | analyze | codex | Codex green-lit aiter `batched_gemm_bf16` + fp32-YQ (realizes bf16-in/fp32-out MFMA via a tuned lib, lower risk than custom Triton). |
| task5 Implement candidate change | AC-2, AC-3, AC-5 | completed | coding | claude | candidate.py only: guarded aiter QK GEMM + import-time fp32-write probe + fp32-einsum fallback. sha 7698920e. |
| task6 Benchmark modified task | AC-2, AC-4 | completed | coding | claude | Authoritative gate, all 3 shapes, --repeat 10, AITER_TRITON_ONLY=0: CORRECT, calc_diff 2.884e-6, shapes_regressed 0. |
| task7 Compare against baseline | AC-2, AC-3, AC-4 | completed | analyze | codex | In-session baseline vs new: geomean ratio 1.29→2.12, no regression. Codex green-lit KEEP (no reward-hacking). |
| task8 Iterate or advance | AC-3 | completed | coding | claude | Profiled new kernel: QK MFMA lever closed; gather memory-bound, PV already MFMA, softmax precision-locked → advance. |
| task9 Final official-task check | AC-2, AC-4 | completed | coding | claude | Four-task check runs end-to-end; all four CORRECT with `shapes_regressed==0` and every accepted win preserved: decode 2/2, prefill 3/3, dsa 3/3 (~2.12), index_score 3/3 (~2.84). Round-2 recovery closed the R1 gap. |
| task10 Finalize report | AC-4, AC-5 | completed | coding | claude | Round 4 regenerated the tracked generated KB bookkeeping (`knowledge.py index` + `distill`); all four validators green (`lint` 17/0, `query` returns the entry, `index --check` 0 stale, `distill --check` up to date). Committed `7202073` (5 generated files, +286/-2). Finalization complete. |
| task11 Diagnose + restore MoE env (Round 1 mainline) | AC-2, AC-4 | completed | coding | claude | `git submodule update --init 3rdparty/composable_kernel` → CK pinned `b67594561`; aiter self-built `module_quant.so` (2848344 B). In-authority, zero numeric drift, candidates untouched. |
| task12 MoE gate re-check + 4-task check (Round 1 mainline) | AC-2, AC-4 | completed | coding | claude | Round 1 established availability/correctness; Round 2 completed accepted-win preservation (decode 2/2, prefill 3/3). |
| task14 Recover moe_total_decode M32 win (Round 2 mainline) | AC-2, AC-3 | completed | coding | claude | `BLOCK_SIZE_M` sweep {16,32,64,128}: BM=32 (current pick) is the widest-margin win. R1 neutral was noise — re-gated unchanged candidate at `--repeat 10` ×2 → 2/2 win, min_cons 1.0411/1.0454, calc_diff 0.0. NO code change. |
| task15 Recover moe_total_prefill M4096 win (Round 2 mainline) | AC-2, AC-3, AC-5 | completed | coding | claude | `GROUP_SIZE_M` sweep {1,2,4,8,16,32}: optimum shifted 4→16 under restored reference. `_pick_group_size_m`→16 at M≥4096 (commit `017bfdc`). Gated `--repeat 10` ×2 → 3/3 win, min_cons 1.0058/1.0038, calc_diff 0.0. |
| task16 Install + refresh harness knowledge entry (Round 3 blocking) | AC-4, AC-5 | completed | blocking | claude | Entry installed Round 3 (`1a315c6`); Round 4 regenerated the generated bookkeeping so `index --check` (0 stale) and `distill --check` (up to date) now pass alongside `lint`/`query`. Committed `7202073`. |

### Blocking Side Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
|-------|-----------------|-------------|-----------------|
| ~~Incomplete aiter in restored env blocks BOTH MoE official tasks~~: `module_quant.so` absent + CK submodule `3rdparty/composable_kernel` uninitialized (no `ck_tile` headers) → fp8 MoE **reference** cannot run (`=1`→`gemm_a16w16_asm` ImportError; `=0`→`module_quant` build fails). **RESOLVED Round 1.** | 0 | AC-4 for MoE (gate unavailable), AC-2/AC-3 for MoE (cannot re-verify no-regression) | **RESOLVED (in-authority, Round 1):** `git submodule update --init 3rdparty/composable_kernel` pinned CK to aiter's OWN referenced commit `b67594561`; aiter JIT-built its own `module_quant.so` (2848344 B). Zero numeric drift (pinned commit, not arbitrary newer CK), MoE candidates untouched, no harness/authority edit. Both MoE gates now run: `shapes_regressed==0`, calc_diff 0, net-positive. NOTE: this touched only the EXTERNAL aiter env, never the harness repo. |
| MoE accepted-win preservation is not yet restored under the runnable pinned-CK reference: `moe_total_decode` M32 and `moe_total_prefill` M4096 moved from accepted wins to neutral tail shapes. **RESOLVED Round 2.** | 1 review | AC-2 (accepted wins are not lost), AC-3 (maximize/preserve official metrics), task9 | **RESOLVED (candidate-local, bit-exact, Round 2):** prefill M4096 — `GROUP_SIZE_M` sweep {1,2,4,8,16,32} showed the optimum shifted 4→16 under the faster restored reference; set `_pick_group_size_m`→16 at M≥4096 (commit `017bfdc`), gated `--repeat 10` ×2 → 3/3 win, min_cons 1.0058/1.0038, calc_diff 0.0. decode M32 — `BLOCK_SIZE_M` sweep {16,32,64,128} showed BM=32 (current pick) is already the widest-margin win; the R1 neutral was timing noise, re-gated unchanged at `--repeat 10` ×2 → 2/2 win, min_cons 1.0411/1.0454, calc_diff 0.0 (no code change). `BLOCK_SIZE_K` untouched throughout. Reference not degraded/loosened. |
| ~~Missing required Round-2 `testbench/knowledge` entry blocks clean session closure~~ **RESOLVED Round 3.** | 2 review | AC-5 / task10 finalization | **RESOLVED (Round 3, data-only):** installed append-only entry `glm52--moe_total_prefill--mi300x--20260723a` using only persisted committed-candidate gate facts (`kda_round2_moe_prefill_official_r10b.json`, run `20260723T043507Z-daddf4`; `candidate.sha256` verified == committed `candidate.py`): win, geomean 1.0459, min_cons 1.0038, shapes_won 3, shapes_regressed 0, calc_diff 0, repeat 10. `approaches` = prefill `GROUP_SIZE_M` sweep (GM=16 winner at M≥4096) + companion decode `BLOCK_SIZE_M` preservation check (BM=32 already optimal, no code change). `knowledge.py add` → installed; `knowledge.py lint` → 17 entries / 0 problems; `query` returns it newest-first. Committed `1a315c6` (one file, +79, `knowledge:` scope, no `.humanize/` staged, no AI-authorship trailer). add-only: `queries/*.md`/`distilled.*` were already stale pre-add and no gate enforces them, so left untouched to keep the diff reviewable (AC-5). |
| ~~Generated knowledge cross-reference/distill files are stale after the Round-3 entry install~~ **RESOLVED Round 4.** | 3 review | AC-5 / task10 finalization | **RESOLVED (Round 4, data-only):** ran `knowledge.py index` + `distill` from HEAD; folded all five glm52 MI300X entries (`generated_from_entries` 12→17) into `queries/{by-op,by-bottleneck,by-technique}.md` + `distilled.{json,md}`. `git status --porcelain` confirmed exactly 5 generated files changed (+286/-2, no `.humanize/`/scratch). All four validators green: `lint` 17/0, `query` returns `glm52--moe_total_prefill--mi300x--20260723a` newest-first, `index --check` 0 stale, `distill --check` up to date. selftest 26/0 + sync 24-in-sync confirm no authority drift. Committed `7202073` (`knowledge:` scope, no AI-authorship trailer). No kernel candidate, task metadata, harness scoring, or prior entry changed. |
| ~~[P3] Archived `build_token_perf.py` rebuild depends on a gitignored run cache~~ **RESOLVED Round 5.** | 5 review | AC-5 (committed rebuild helper must depend only on committed inputs) | **RESOLVED (Round 5, data-only, one archive file):** `codex review --base kda-base/glm52-rocm-mfu-bw-20260722` flagged `archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105` — `final_result()` read `runs/glm52/<task>/<run_id>/result.json`, but `runs/` is gitignored (`.gitignore:31`), so the README-documented rebuild command fails on a fresh archive checkout. Verified the committed copies exist at `archive/0720-Best-GLM-52/lichangye/<task>/result.json` for all four tasks with `run.run_id` matching the four hardcoded ids and every consumed aggregate field present (perf 1.0655/1.0809/1.3044/2.8371). Fix: read the archived path first (cache fallback retained only if archive absent), assert `run.run_id == run_id`, and report the archived path in `source`. `py_compile` clean; a functional check confirmed all four archived files resolve from the ARCHIVE path with matching run_ids. `git status --porcelain` = exactly one file (no `.humanize/`, no CSV/plot churn). Committed `d5114877` (`archive:` scope, no AI-authorship trailer). No candidate/reference/taskset/metric/harness/knowledge change; selftest 26/0 and all four knowledge validators still green. Committed plots/CSV were NOT regenerated (they need the local transcript + matplotlib; the finding did not ask for it). |

### Queued Side Issues
| Issue | Discovered Round | Why Not Blocking | Revisit Trigger |
|-------|-----------------|------------------|-----------------|
| `rocm_env.sh` defaults `AITER_TRITON_ONLY=1`, which hides `gemm_a16w16_asm` needed by the MoE reference import chain. | 0 | dsa+index_score run fine under `=1`; only MoE needs `=0`. Round-2 artifacts are valid because the successful MoE runs necessarily used the working path and the summary records `AITER_TRITON_ONLY=0`. | Still operationally open: current sourced env reports `AITER_TRITON_ONLY=1`, and result JSON does not record the override. Future MoE gates must explicitly export `AITER_TRITON_ONLY=0` until the schema/default environment is fixed by the owner. |
| `/tmp/aiter_configs` was created root-owned (blocks aiter's hardcoded config-lock write). | 0 | Already worked around (moved aside, recreated user-writable, preserved `bf16_tuned_gemm.csv`). `/tmp` has no sticky bit. | If env re-restored and dir reverts to root-owned. |
| Round-1 summary's review-boundary statement names `5efb3cf..HEAD` as candidate-local even though that range includes `archive/**` commits `ebfadea` and `3ddb2ea`. **APPLIED Round 2.** | 1 review | Non-blocking documentation issue; the actual candidate-local diff is still one file via `3ddb2ea..HEAD`. | **APPLIED (Round 2):** round-2-summary.md states the boundary as `3ddb2ea..HEAD` == `fork/codex/amd-glm52-rocm-evalbench-v2..HEAD` (fork ref verified to resolve to `3ddb2ea`); contents = exactly two candidate files (`dsa` `26bdb84`, `moe_total_prefill` `017bfdc`). `5efb3cf..HEAD` framing superseded. |
| Non-MoE task `run.sh` wrappers still ignore `ROCM_TORCH_VENV` and fall back to `/opt/conda/bin/python3` when repo `.venv` is absent | 2 review | Does not invalidate the Round-2 dsa/index evidence because those official checks were run through `evaluate_task.py` with the ROCm Python, matching the taskset driver and producing candidate-hash-matched result JSON. Editing generated `run.sh` files is frozen authority. | Owner should regenerate/fix task wrappers in a separate infrastructure pass. Until then, direct dsa/index `run.sh` gates on this machine can return rc3 unless the expected repo-local `.venv` exists; use the taskset/evaluate_task ROCm-Python command for review evidence. |
| Archived `build_token_perf.py` still loads its per-message token series from a hardcoded `~/.claude/projects/.../*.jsonl` Claude transcript at module import | 5 review | Separate from the [P3] the reviewer flagged (that was the `result.json` source, now fixed); the token_perf README already discloses the transcript dependency, and the committed CSV/plots already embed the derived token counts, so the archived artifacts are self-describing without a re-run. Fixing it would need archiving a transcript or refactoring token loading — out of scope for a bounded [P3] fix. | Owner should archive a redacted transcript slice (or persist the derived token series) and switch `token_series()`/`SESSION` to read it, so a full plot rebuild is reproducible from archive contents alone. |

### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
|----|------|-----------------|----------------|----------|
| AC-1 | Preflight authority frozen (working tree clean, correct branch `codex/amd-glm52-rocm-evalbench-v2`, taskset/official_metrics/hardware selection unchanged) | 0 | 0 | Only `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` changed; no taskset/metric/reference/cost-model/peak/timing/deploy edits. |
| AC-2 | `dsa_prefill_attn` correct pre- and post-timing on every shape; `shapes_regressed == 0`; accepted wins preserved | 0 | 0 | Persisted run 20260723T025835Z-4fc839: calc_diff 2.8837e-6/2.8843e-6/2.8833e-6 (margin 1.73x under 5e-6), post_timing_correct True, timing_unstable False, shapes_regressed 0. calc_diff **unchanged** from baseline (2.884e-6). |
| AC-3 | `dsa_prefill_attn` improves the primary metric with no conservative regression | 0 | 0 | geomean_primary_util_ratio 1.3044→**2.1181**; geomean_cons 2.0935; min_cons 1.2603→**2.0626**; MFU 0.034010→**0.0552**; shapes_won 0→**3**. Baseline vs new run in same session (`/tmp/gate_baseline.out` vs run 4fc839). |
| AC-4 | Baseline-comparable evidence for the dsa win (per-shape latency/MFU/ratio/calc_diff, --repeat 10, persisted JSON) | 0 | 0 | Per-shape M=1024 cand 4008.7us/ref 8432.0us/MFU 0.0557/ratio 2.103/cons 2.063; M=2048 8068.2/17100.1/0.0554/2.119/2.096; M=4096 16201.1/34535.0/0.0552/2.132/2.122. `runs/glm52/dsa_prefill_attn/latest.json`. |
| AC-2, AC-3 | `index_score_prefill` accepted win **not lost** (untouched, re-verified CORRECT) | 0 | 0 | Re-gate (--repeat 10): geomean_ratio 2.8361 / min_cons 1.5382 / calc_diff 0, matches accepted baseline 2.8371/1.5375 within noise; shapes_regressed 0. No candidate edit. |
| AC-4; AC-2 partial | `moe_total_decode` gate availability restored; correctness and `shapes_regressed == 0` verified, but accepted-win preservation unresolved | 1 | 1 | Single-task authoritative (evaluate_task.py, --repeat 10, AITER_TRITON_ONLY=0): shapes_regressed **0**, shapes_won 1 vs accepted 2, geomean 1.055 vs accepted 1.0655, M32 neutral with cons 0.9938 vs accepted min_cons 1.0518. Taskset: 6 correct / 0 incorrect / 0 infra_failed. Persisted `kda_round2_moe_total_decode_{final4,singletask_recheck}.json`. |
| AC-4; AC-2 partial | `moe_total_prefill` gate availability restored; correctness and `shapes_regressed == 0` verified, but accepted-win preservation unresolved | 1 | 1 | Single-task authoritative: shapes_regressed **0**, shapes_won 2 vs accepted 3, geomean 1.0406 vs accepted 1.0809, M4096 neutral with cons 0.9714 vs accepted min_cons 1.0263. Taskset: 3 correct / 0 incorrect / 0 infra_failed. Persisted `kda_round2_moe_total_prefill_{final4,singletask_recheck}.json`. |
| AC-2, AC-3 | `dsa_prefill_attn` + `index_score_prefill` wins **held under restored (CK-populated) env** (same-env re-confirmation) | 1 | 1 | Four-task check, AITER_TRITON_ONLY=0: dsa 3/3 passed (ratio 2.1040/2.1142/2.1300), index_score 3/3 passed (1.5462/3.9357/3.7794, min_cons 1.5365 vs baseline 1.5375). 0 incorrect / 0 infra_failed. CK restore did not perturb either headline task. |
| AC-2, AC-3 | `moe_total_decode` accepted win **fully restored** (2/2) — R1 M32 neutral was timing noise | 2 | 2 | `BLOCK_SIZE_M` sweep {16,32,64,128} at M32: BM=32 (current pick) widest-margin win (cons 1.0370). Unchanged candidate re-gated official `[16,32]` `--repeat 10` ×2: 2/2 win, min_cons 1.0411/1.0454, shapes_regressed 0, calc_diff 0.0. No code change. Persisted `kda_round2_moe_decode_official_r10{a,b}.json`. |
| AC-2, AC-3, AC-5 | `moe_total_prefill` accepted win **fully restored** (3/3) via candidate-local `GROUP_SIZE_M` re-shift | 2 | 2 | Sweep {1,2,4,8,16,32} at M4096: GM=16 the widest-margin win (regress at {1,8}, neutral {2,4}, win {16,32}). `_pick_group_size_m`→16 at M≥4096 (commit `017bfdc`). Gated official `[1024,2048,4096]` `--repeat 10` ×2: 3/3 win, min_cons 1.0058/1.0038, shapes_regressed 0, calc_diff 0.0. Persisted `kda_round2_moe_prefill_official_r10{a,b}.json`. |
| AC-2, AC-3 | `dsa_prefill_attn` + `index_score_prefill` re-confirmed unlost in the Round-2 four-task check | 2 | 2 | Authoritative evaluate_task.py (ROCm python), `--repeat 10`, AITER_TRITON_ONLY=0: dsa 3/3 win (geomean 2.1213, min_cons 2.0691, calc_diff 2.884e-6), index_score 3/3 win (2.8416, 1.5321, calc_diff 0). shapes_regressed 0 both. Persisted `kda_round2_{dsa_prefill_attn,index_score_prefill}_official_r10.json`. |
| AC-5, AC-4 | Required append-only `testbench/knowledge` entry recorded for the Round-2 `moe_total_prefill` recovery session | 3 | 3 | `glm52--moe_total_prefill--mi300x--20260723a` installed via `knowledge.py add`; `lint` 17 entries / 0 problems; `query` returns it newest-first `[win geo=1.0459 minc=1.0038]`. Every number from persisted `kda_round2_moe_prefill_official_r10b.json` (candidate sha256 == committed `candidate.py`). Committed `1a315c6` (one file, +79; `knowledge:` scope; no AI-authorship trailer). Round-3 review separately reopened task10 because generated KB freshness checks still fail. |
| AC-5 | Generated KB bookkeeping regenerated so all four `knowledge.py` validators pass (Round-3 DoD met) | 4 | 4 | `knowledge.py index` + `distill` folded the 5 glm52 MI300X entries into the tracked views (`generated_from_entries` 12→17); diff bounded to exactly 5 generated files (+286/-2); `lint` 17/0, `query` returns the entry, `index --check` 0 stale, `distill --check` up to date; selftest 26/0, sync 24-in-sync (no authority drift). Committed `7202073` (`knowledge:` scope, no AI-authorship trailer, tree clean). |
| AC-5 | [P3] archived `build_token_perf.py` reads committed `result.json` (rebuild helper self-contained) | 5 | 5 | `final_result()` now reads `archive/0720-Best-GLM-52/lichangye/<task>/result.json` (cache fallback), asserts `run.run_id == run_id`, reports the archived `source`. Functional check: all 4 archived files resolve from ARCHIVE, run_ids match, perf 1.0655/1.0809/1.3044/2.8371, `py_compile` clean. `git status --porcelain` = one file (no `.humanize/`, no CSV/plot churn); selftest 26/0, knowledge `lint` 17/0 + `index --check` 0 stale + `distill --check` up to date all unaffected. Committed `d5114877` (`archive:` scope, no AI-authorship trailer). |

### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
|------|-------------|----------------|---------------|-------------------|
| None currently | - | - | The prior MoE availability deferral is closed because the gate now runs, and MoE accepted-win preservation was restored in Round 2. The remaining knowledge-entry closure item is active/blocking for task10 finalization, not deferred. | - |
