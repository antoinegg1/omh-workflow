# Round 2 Contract — Drift Recovery

## Root cause of the recent drift / stagnation

The last **two** round verdicts (round 0, round 1) were `STALLED`, but the cause is
**not** stalled mainline work — it is a **review-side infrastructure failure** that
makes the reviewer blind:

- The loop's round review runs `codex review` (see
  `humanize/hooks/loop-codex-stop-hook.sh:1266`). Unlike `codex exec` (which the
  script gives `--full-auto` / `--dangerously-bypass-approvals-and-sandbox`),
  `codex review` is invoked with **no sandbox-bypass flag** (`CODEX_REVIEW_ARGS`
  = only `-c model=… -c review_model=… -c model_reasoning_effort=…`).
- `codex review` therefore runs under Codex's **default OS sandbox**, which shells
  out to **bwrap**, which cannot create a mount namespace in this environment:
  `bwrap: Failed to make / slave: Permission denied`. Because `codex review` MUST
  read the git diff to function, it fails completely and returns `STALLED` with
  `ACs: unknown/unknown` — it never saw the plan, candidate, or artifacts.
- Independent proof the work itself is sound: the round-1 `codex exec` (ask-codex,
  inline evidence, `--full-auto`) DID complete and returned **GO** on the committed
  prefill diff. The `exec` path tolerates the bwrap failure (answers from the inline
  prompt); the `review` path cannot.

This is outside candidate scope. I will **NOT** modify the reviewer's sandbox/config
(`~/.codex/config.toml`), the humanize hooks, or any loop state file — altering the
verifier to make my own work pass would be tampering. The fix belongs to the owner
(recorded below).

## Recovered mainline objective (exactly one)

**Advance the plan to the third official target, `dsa_prefill_attn`** (GLM-5.2 DSA
sparse MLA attention, prefill; M ∈ {1024, 2048, 4096}; baseline
`sgl_kernel.flash_mla.flash_mla_sparse_fwd`). Produce a baseline characterization and
either (a) a correctness-preserving primary-util win on ≥1 shape (0 regressions, 0
incorrect), or (b) a **named no-go blocker with evidence** that no correctness-safe
lever exists for this monolithic compiled kernel. Both are valid per the plan Lower
Bound ("either an improvement or a named no-go blocker"). This is plan-aligned forward
progress (targets #1 and #2 converged with committed wins), not scope-broadening.

## Target ACs that prove mainline progress this round

- **AC-4** (evidence-backed MFU/BW outcome — win reported in MFU/BW terms, or a no-go
  substantiated with per-shape baseline metrics) — primary.
- **AC-3** (any candidate preserves ABI + correctness; no reseed/re-quant/tolerance
  change/reference monkey-patch) — must hold.
- Secondary: AC-2 (evaluator MFU/BW fields), AC-5 (clean diff).

## Blocking issues (truly block the recovered objective)

- **None on the mainline candidate work.** The bwrap review-sandbox failure blocks the
  *automated verdict*, not the mainline engineering. It is classified as a blocking
  **verdict/verification** issue with an owner-facing fix (below), and mitigated this
  round by an inline-evidence `codex exec` review of the produced work.

## Queued (explicitly out of scope this round)

- `index_score_prefill` (target #4) — after dsa.
- Re-running the round-0 and round-1 `codex review` once the sandbox is fixed
  (harness/owner responsibility).
- M=64 decode (~1.0 frontier); M=4096 prefill thin-but-positive margin.

## Owner-facing fix for the review sandbox (I will NOT apply it myself)

Any ONE of:
1. Set `sandbox_mode = "danger-full-access"` in `~/.codex/config.toml` so `codex
   review` skips the bwrap OS sandbox (consistent with the existing
   `hide_full_access_warning = true` + trusted-projects posture).
2. Patch `loop-codex-stop-hook.sh` to pass a sandbox-bypass to `codex review` (e.g.
   `-c sandbox_mode=danger-full-access`) as it already does for `codex exec`.
3. Enable unprivileged user namespaces / fix mount propagation so bwrap can run.
Also add `/home/lichangye/kernel-harness-amd` to the trusted `[projects]` list
(currently only the old `/home/lichangye/kernel-harness` is listed).

## Concrete success criteria (would flip the verdict to ADVANCED)

1. Baseline probe recorded for `dsa_prefill_attn` at M ∈ {1024,2048,4096}: per-shape
   latency / bound / MFU / BW-util / TFLOP/s / GB/s / primary-util.
2. A reasoned candidate attempt: either a bit-exact/correctness-preserving win
   (calc_diff verified, official gate ≥1 shape passed, 0 regress, 0 incorrect,
   candidate.py committed) OR a named no-go with the evidence that closed it.
3. An independent **inline-evidence `codex exec` review (GO/NO-GO)** of the produced
   work — the verification channel that demonstrably works despite the bwrap failure.
4. round-2-summary.md + goal-tracker mutable section updated; final diff excludes
   `.humanize/`, caches, traces, build artifacts.
