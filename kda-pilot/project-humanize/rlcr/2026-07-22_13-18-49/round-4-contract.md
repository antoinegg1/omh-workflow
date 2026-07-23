# Round 4 Contract

## Round Type

**Review-phase round.** The Stop-hook advanced the counter to round 4 and ran the
round-3 code review. Codex returned two `[P2]` findings (no `[P0]`/`[P1]`). Per the
review-phase rules, code-review findings do NOT become the round objective and no new
`[mainline]` target is selected. **Target #5 is explicitly NOT selected.**

## Mainline Objective (unchanged — carried from the completed round-2 cycle)

Finalize the GLM-5.2 ROCm/MI300X optimization work for the four plan-prioritized targets
(`moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, `index_score_prefill`), all
already landed with correct MFU/BW evidence and Codex-verified in the round-2 review, and
the round-3 `[P1]` platform guard already fixed. The only work this round is to adjudicate
and dispose of the round-3 code-review findings so the loop can proceed to finalize. The
mainline objective is stable; this round adds no features and no new targets.

## Review Findings — Classification

Both round-3 findings are the SAME root issue seen from two sides, and it is a
**stale-`task.json`-metadata false positive**, not a candidate defect:

| Finding | File:line | Classification | Why |
|---------|-----------|----------------|-----|
| `[P2]` "guard always raises on the committed B200 task" | `dsa_prefill_attn/candidate.py:84` | **queued** (owner-facing) | Premise (gate = B200) contradicts the frozen authority |
| `[P2]` "gfx942-only fast path leaves B200 shapes neutral" | `index_score_prefill/candidate.py:85` | **queued** (owner-facing) | Same premise; same contradiction |

### Why the premise is wrong (evidence)

- The loop's declared ONLY authority is the frozen taskset `tasksets/glm52_rocm_local.json`.
  It pins `hardware = {platform: rocm, profile: amd-mi300x, provider: aiter-torch-reference,
  timer: event}` and its `score_model.official_metrics` **enumerates both**
  `dsa_prefill_attn` and `index_score_prefill`. So both tasks ARE scored, on ROCm/MI300X.
- The per-task `task.json` `deployment` strings are **internally inconsistent**:
  `moe_total_{decode,prefill}` read `MI300X-DP1-TP1-EP32`, but `dsa_prefill_attn` and
  `index_score_prefill` still read `B200-DP1-TP1-EP32` — stale leftovers from pre-ROCm
  authoring by `testbench/bin/sync_glm52_tasks.py`. `task.json` is a **generated oracle
  file I am forbidden to edit**.
- The persisted authoritative runs confirm ROCm: `runs/glm52/dsa_prefill_attn/...` and
  `runs/glm52/index_score_prefill/...` both have `backend.platform = rocm`,
  `accelerator = AMD MI300X`, `environment.gpu_arch = gfx942...`, `shapes_won = 3`,
  `shapes_regressed = 0` (dsa worst `calc_diff` 2.884e-6 ≤ 5e-6; index_score `calc_diff` 0.0).
- The runtime guards key off the **actual device** (`torch.version.hip` set on the ROCm run;
  `_mqa_mod.arch == "gfx942"` on MI300X), NOT off the stale `task.json` string, so on the
  authoritative ROCm gate BOTH guards pass and the fast paths engage and win.

### Why no candidate-only edit satisfies the B200 premise

If the gate were truly B200: guarded ⇒ neutral fallback (this round's complaint);
unguarded ⇒ the round-3 `[P1]` regression (the PyTorch loop is slower than the fast CUDA
FlashMLA reference). Winning on B200 would require a genuinely faster-than-FlashMLA B200
kernel — which needs B200 hardware I do not have and which the plan explicitly forbids
("without CUDA/B200 assumptions"). And I may not edit `task.json` deployment metadata
(forbidden oracle file). Therefore the ONLY correct, permitted candidate-side action is to
keep the device guards and anchor them to the authoritative taskset.

## Blocking Side Issues (must fix this round)

| Issue | Tag | Owner | AC | Resolution |
|-------|-----|-------|----|-----------|
| (none) | — | — | — | Neither `[P2]` is blocking: the mainline objective (four ROCm targets) already succeeds on the authoritative gate, and the reviewer's requested remedies (win on B200, or change task/backend metadata) are respectively out-of-scope and a forbidden oracle edit. |

## This round's action (permitted, minimal, doc-only)

- Added anchoring comments beside BOTH guards citing `tasksets/glm52_rocm_local.json`
  (`platform: rocm`; both tasks in `official_metrics`) and noting the `task.json` `B200`
  string is stale metadata this candidate must not edit. **No control-flow or math change**
  — the ROCm fast paths are byte-for-byte unchanged, so the persisted 3/3 ROCm wins hold.
- Independent adjudication via `/humanize:ask-codex` (gpt-5.5:xhigh) returned **GO**: the
  `[P2]` is a stale-metadata false positive, keeping the guards is the correct engineering
  choice, and there is no reward-hack/correctness risk in the doc-only change.

## Queued Side Issues (documented, NOT this round's objective)

- **Stale `task.json` `deployment: B200-...` on `dsa_prefill_attn` and `index_score_prefill`**
  (owner-facing): inconsistent with the frozen taskset (`platform: rocm`) and with the moe
  tasks' `MI300X-...`. Fix belongs in the oracle generator `sync_glm52_tasks.py`, which I am
  forbidden to edit. Revisit: owner re-syncs the task metadata to ROCm.
- ROCm runtime substrate missing under `/opt/devmachine/lichangye/repos/{sglang,aiter}` —
  cannot re-benchmark on GPU this round; the doc-only change is a provable no-op so a rerun is
  not required for correctness. Owner must restore the substrate before the next benchmark round.
- DSA fallback calls `sgl_kernel.flash_mla.flash_mla_sparse_fwd` directly rather than routing
  through `glm52_ops.reference('dsa_attn','prefill', inputs)` — a provider-alignment nit; the
  direct call still returns the reference kernel. Left queued.
- Target #5 selection — deferred until this review completes and a new contract explicitly
  selects it. Do NOT self-declare.

## Acceptance for this round

- Both `[P2]` findings are adjudicated and classified (queued, owner-facing stale-metadata),
  with the permitted candidate-side action (doc anchoring) taken and independently GO'd by Codex.
- No logic change; the guards are kept (removing them re-opens the round-3 `[P1]`).
- Change committed; `round-4-summary.md` written; `goal-tracker.md` blocking/queued lists
  reconciled.
- Next Stop-hook code review has the anchoring context to see the fast paths are reachable and
  winning on the authoritative ROCm gate → finalize.
