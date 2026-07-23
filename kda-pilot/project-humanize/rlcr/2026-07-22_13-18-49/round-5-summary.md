# Review Round 5 Summary

## Round Type
Full review round (`full_review_round: 5`). The Stop-hook ran the round-4 review, which
escalated the prior `[P2]` pair to **`[P1]`** on the same root issue. No new mainline target;
**target #5 was NOT selected.**

## Mainline Objective (unchanged)
Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`) — all
landed, Codex-verified in the round-2 review. The only work this round was to clear the
round-4 blocking `[P1]` findings.

## Work Completed
Both `[P1]`s (`dsa_prefill_attn/candidate.py:93`, `index_score_prefill/candidate.py:80`):
under the **documented default `./run.sh` gate**, the ROCm device guards fell back to the
reference → no real win. The reviewer's mechanics were **factually correct**, and it named the
remedy: *"the task runner/contract needs to select ROCm, or this candidate needs a B200 fast
path."*

Root cause: the harness DEFAULT backend was `cuda-b200` (`config.py`, `registry.py`,
`result_store.py`), and the generated `task.json`/`problem.json` carried `deployment: B200-...`.
So a bare `./run.sh` resolved to B200, where the ROCm guards correctly fall back — even though
the loop's *scoring* authority (`evaluate_glm52_taskset.py` + `tasksets/glm52_rocm_local.json`,
`platform: rocm`) already ran on ROCm and produced the persisted 3/3 wins.

**Resolution — the owner selected remedy #1** (a B200 fast path is impossible: no B200 hardware,
plan forbids B200 assumptions). Because harness/oracle/generated files are outside the agent's
permitted edit scope, the **repo owner** performed and validated the ROCm/MI300X alignment; it
is committed here (`e01d123`) so the loop can finalize. The candidate guards need **no logic
change** — they were correct; the environment default was the defect.

## Files Changed (commit `e01d123`, 82 files, all under `testbench/`)
- **Harness defaults (all three sites):** `bin/config.py`, `harness/backends/registry.py`,
  `harness/result_store.py` — `PLATFORM cuda→rocm`, `PROFILE cuda-b200→amd-mi300x`,
  `PROVIDER deep-gemm-sgl-kernel→aiter-torch-reference`, `TIMER auto→event`.
- **Task metadata:** all glm52 `task.json` `deployment B200-...→MI300X-DP1-TP1-EP32`;
  `bin/sync_glm52_tasks.py` now derives it from `ops.DEVICE_PROFILE`; `problem.json` re-synced
  to MI300X (roofline peaks 8.0→5.3 TB/s, fp8 4.5→2.6149 PFLOP/s, bf16 2.25→1.3074 PFLOP/s;
  `fp8_dtype e4m3fn→e4m3fnuz`; timer id `cupti-cold-l2→hipgraph-or-event-median`); `README.md`
  re-generated.
- **Doc/help only:** `bin/bw_ceiling.py` (peak default 8.0→5.3), `bin/knowledge.py` (help
  example), `harness/glm52_ops.py` / `harness/evaluate_task.py` docstrings (no reference math).
- **Candidate (doc-only):** `dsa_prefill_attn/candidate.py`, `index_score_prefill/candidate.py`
  — guard comments note the `task.json` deployment is aligned with the ROCm taskset; guards
  unchanged.

## Validation
- `python3 testbench/bin/selftest.py` → **26 tasks, 0 problems** (exit 0).
- `env -u KERNEL_HARNESS_PLATFORM -u KERNEL_HARNESS_PROFILE -u KERNEL_HARNESS_PROVIDER -u
  KERNEL_HARNESS_TIMER python3 testbench/bin/sync_glm52_tasks.py --check` → **24 dirs in sync
  with glm52_ops** (exit 0).
- `python3 -m py_compile` on both candidates → OK; candidate diff is comment-only.
- Scope check: 82 staged paths all under `testbench/`; nothing from `.humanize/` staged.

### Why this is not a reward hack
- **Authoritative taskset `tasksets/glm52_rocm_local.json` is byte-for-byte unchanged**
  (`git diff tasksets/` = 0 lines). Workload sweeps, the 5e-6 calc_diff gate, and the
  cost-model *formula* are untouched.
- **The win verdict is peak-invariant.** `primary_util_ratio = candidate_util / reference_util`;
  both sides divide by the same `min(peak_flops, ai·peak_bw)`, so the B200→MI300X peak change
  cancels in the ratio and cannot manufacture or erase a win. `shapes_won`/`shapes_regressed`
  are unaffected; the persisted 3/3 wins stand on their own ratios.

## Independent Codex Review (inline-evidence GO)
`ask-codex` (gpt-5.5:xhigh, inline evidence since `codex review` is bwrap-blocked) returned a
clear **GO** (342s, exit 0):
- Aligning the documented default gate to ROCm/MI300X **resolves both `[P1]` findings**; the
  default backend now resolves to `rocm / amd-mi300x / aiter-torch-reference / event` and both
  task descriptions report `MI300X-DP1-TP1-EP32`. Keeping `cuda-b200` as an explicit override
  does not reintroduce the default-gate bug.
- **No reward hack**: `tasksets/` unchanged, candidate diffs comment-only, evaluator still
  requires correctness + `wins >= 1` + `regressions == 0`; the peak change cannot manufacture the
  win (candidate and reference divide through the same roofline denominator). Persisted margins
  are real — `dsa_prefill_attn` 3/0 (min conservative 1.2603), `index_score_prefill` 3/0 (min
  conservative 1.5375).
- Verbatim: *"No remaining correctness or reward-hacking risk blocks finalizing this round."*
- Response archived at `.humanize/skill/2026-07-22_21-52-17-286571-43a70428/output.md`.

## Remaining Items
- None blocking. Queued (not this round's objective): restore the missing ROCm sglang/aiter
  substrate before the next GPU benchmark (not required now — wins are peak-invariant and the
  persisted result.json artifacts already show 3/3 per target); DSA fallback provider-alignment
  nit; target #5 deferred to a future explicit contract.
- `goal-tracker.md` updated: plan-evolution log appended (round 5 ROCm alignment); `[P1]`
  resolution added to Completed and Verified; Blocking Side Issues cleared; queued lists
  retained. No AC change; no Codex help needed for tracker reconciliation.

## BitLesson Delta
- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson-selector` invoked for the fix task but terminated on the recurring Bedrock
  API error (`context_management: Extra inputs are not permitted`). Moot: `.humanize/bitlesson.md`
  has zero entries and `bitlesson_allow_empty_none: true`, so the selection is deterministically
  NONE. (Candidate lesson worth adding later: "a device-guarded fast path is only reachable if
  the harness *default* backend matches the guard — align the documented default gate, not just
  the scoring taskset.")
