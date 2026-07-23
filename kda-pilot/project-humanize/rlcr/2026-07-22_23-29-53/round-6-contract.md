# Round 6 Contract (Review Phase)

Written BEFORE touching code, per the RLCR loop rule. Review-phase round:
`codex review --base kda-base/glm52-rocm-mfu-bw-20260722` returned three findings
(`[P1]`, `[P2]`, `[P2]`). A code-review finding does NOT replace the mainline
objective.

## Mainline Objective (unchanged, already complete)

Maximize official ROCm/MI300X `roofline_mfu_bw` across the four official tasks
(`dsa_prefill_attn`, `index_score_prefill`, `moe_total_prefill`,
`moe_total_decode`) without regressing any accepted win or touching frozen
authority, and record the session in both knowledge bases. Achieved Rounds 0–5.
**This round changes no kernel/candidate and re-runs no gate.**

## Review-range context (critical for classification)

The review base `kda-base/glm52-rocm-mfu-bw-20260722` predates BOTH KDA-Pilot
loops, so `base..HEAD` is 118 files / +11854-1368 — most of it a broad ROCm
suite-migration from the PRIOR loop (commit `e01d123 align task metadata + harness
defaults to ROCm/MI300X` plus mass `problem.json`/`task.json`/`README.md` churn
across ~20 non-official tasks). My current loop produced only the top commits
(`26bdb84`, `017bfdc`, the knowledge/archive commits). Two of the three findings
target that prior broad migration, not my four official candidates.

## Findings — classification (evidence-based)

### [P2] Archive candidate bytes don't match result hashes → **BLOCKING (fix now)**

`archive/0720-Best-GLM-52/lichangye/<task>/result.json` records a `candidate.sha256`
that matches neither the archived `candidate/candidate.py` NOR the live task
candidate — for ALL FOUR tasks (verified by hashing). Root cause: the accepted
baseline `result.json` files were measured at the FIRST-loop candidate commits,
then candidates were edited by later "finalize cleanup" commits, so the archived
snapshot (taken at `ebfadea`) is newer than the measured bytes. The measured bytes
ARE recoverable from git history (each recorded sha equals the candidate blob at:
decode `7dc4959`, prefill `3c8aa34`, dsa `3531593`, index `37132ff`). This is in
my domain (the archive), bounded, and honestly fixable WITHOUT re-running (which
would change the plan-cited baseline numbers) or touching any live candidate.

### [P1] Registry ROCm default vs stale non-official candidates → **QUEUED (owner/infra)**

`registry.py:48` defaults to ROCm/MI300X when `KERNEL_HARNESS_*` is unset; many
NON-official suite candidates (`index_score_decode`, GEMM/MoE splits) are still
CUDA-shaped and fail on that path. Real, but **neither suggested remedy is within
this loop's authority**:
- "Keep the default CUDA" REVERTS the ROCm default — but AC-1 *requires* hardware
  selection to remain `rocm/amd-mi300x/...` and requires `sync_glm52_tasks.py
  --check` to pass under the DEFAULT ROCm environment (my preflight runs it with
  `KERNEL_HARNESS_*` unset). Reverting breaks AC-1 and my own preflight.
- "Regenerate candidates for the selected backend" is a broad NON-TARGET task
  rewrite across ~20 tasks — AC-5 negative test rejects it "unless the owner
  explicitly authorizes."
The four OFFICIAL tasks are unaffected (they have working ROCm candidates and pass
their own gates; `official_metrics` = exactly those four). → queued with owner
escalation.

### [P2] `index_score_decode/problem.json` stale tensor table → **QUEUED (owner/infra)**

Non-official task's `contract.tensors` still describes the CUDA paged ABI while its
ROCm `build_inputs` returns the ks-range form. Fixing it is non-target metadata
work (AC-5), and it is part of the same ~20-task migration; a hand-edit would also
diverge from the `sync_glm52_tasks.py` generator, which currently passes `--check`.
The correct fix is an owner pass over the generator/sync, not a one-off hand-edit.
Not an official task (official index task is `index_score_prefill`). → queued.

## Target Acceptance Criteria

- **AC-5 (reviewable / self-contained artifacts) — primary.** The archived result
  and candidate must be mutually consistent (archived candidate hash ==
  `result.json` `candidate.sha256`), proving the committed bytes produced the
  archived result.
- **AC-1 (authority frozen) — guardrail.** No live candidate, reference, taskset,
  `official_metrics`, threshold, cost model, peak, timing, deploy metadata, task
  `run.sh`, harness (`registry.py`), or `testbench/knowledge` change. No re-run
  that would alter the plan-cited baseline numbers.

## Fix (blocking finding only)

For each of the four archived tasks, replace
`archive/0720-Best-GLM-52/lichangye/<task>/candidate/candidate.py` with the exact
measured bytes from its matching first-loop commit (`git show <commit>:testbench/
tasks/glm52/<task>/candidate.py`), so the archived candidate's sha256 equals the
`candidate.sha256` recorded in that task's archived `result.json`. Change nothing
else. Do NOT re-run the gate, do NOT touch live candidates, do NOT edit any
`result.json`.

## Task lanes

- `[blocking]` task22 — restore measured candidate bytes into all four archived
  `candidate/candidate.py`; verify each hash == recorded `result.json` sha; commit
  `archive:`-scoped (no `.humanize/`, no live-candidate/authority change). (coding, claude)
- `[queued]` task23 — [P1] registry ROCm default vs non-official candidates (owner
  authorization required: either owner-approved candidate regeneration, or a
  harness-owner decision on the default). Documented, NOT executed.
- `[queued]` task24 — [P2] regenerate ROCm contract tables for non-official tasks
  via the generator/sync (owner/infra). Documented, NOT executed.

## Definition of Done

1. All four archived `candidate/candidate.py` hash exactly to their `result.json`
   `candidate.sha256`.
2. `git status --porcelain` shows exactly those four files — no `.humanize/`, no
   live candidate, no harness, no `result.json`, no knowledge churn.
3. Committed with an `archive:`-scoped message; no AI-authorship trailer.
4. Frozen-authority preflight still green (`selftest`, knowledge
   `lint`/`index --check`/`distill --check`).
5. `goal-tracker.md` records the archive [P2] as a resolved blocking side issue and
   the [P1]/[P2] non-official-migration items as queued owner escalations;
   `round-6-summary.md` written with a `## BitLesson Delta`.
