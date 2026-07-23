# Round 0 Contract

## Mainline Objective

Complete one full KDA-Pilot pass over the GLM-5.2 ROCm MI300X taskset: verify the
environment/review-base, confirm the `roofline_mfu_bw` evaluator emits MFU/BW
fields, select the first official target, characterize its baseline, implement the
smallest plausible winning candidate (with reference fallback for losing shapes),
and produce MFU/BW-backed evidence for either an improvement or a named no-go blocker.

This satisfies the plan's Lower Bound: at least one official target attempt with
baseline numbers, a reasoned candidate attempt, correctness evidence, MFU/BW
benchmark evidence, and either an improvement or a named no-go blocker.

## Target ACs (this round)

- Primary: AC-3 (ABI/correctness contract preserved) and AC-4 (evidence-backed
  MFU/BW win or named no-go).
- Supporting (gating): AC-1 (valid env/base), AC-2 (evaluator MFU/BW fields),
  AC-5 (scoped/clean diff).

## Blocking Side Issues In Scope

- None known at round start. Any issue that prevents a correct, measurable
  candidate run (e.g. evaluator not emitting MFU/BW fields, ABI mismatch,
  reward-hack guard tripping) is in scope and will be logged as blocking.

## Queued Side Issues Out Of Scope

- Optimizing operators beyond the first official target (only if first target
  converges early per Upper Bound).
- Any refactor of the harness, evaluator, or `glm52_ops.py` reference (forbidden
  by AGENTS.md; oracle files must not change).
- Live `sglang serve` benchmarking (explicitly out of scope).

## Round Success Criteria

1. AC-1 verified: clean worktree, base ref resolves to
   `f60a69768b4172eabd7ddbc7ffacc2b621af50b4`, env + tools present, plugin lists skills.
2. AC-2 verified: smoke run has `infra_failed == 0`, `incorrect == 0`, and rows
   carry `metric_name == "roofline_mfu_bw"` plus MFU/BW fields.
3. First official target selected with a documented rationale and its full
   contract read (README, task.json, problem.json, workload.jsonl, candidate.py,
   glm52_ops reference path).
4. Baseline/probe recorded with per-shape latency, bound, MFU, BW util, TFLOP/s,
   GB/s, conservative primary-util ratio, and shape verdicts; JSON artifact path noted.
5. A candidate is implemented under the task-local `candidate.py` (or external
   candidate root) exposing `run(inputs) -> output`, keeping compile/setup outside
   the timed body, with reference fallback for shapes it cannot win.
6. Correctness passes pre- and post-timing; a gate-quality benchmark is run for any
   claimed win. Result is either a conservative primary-util win with zero shape
   regressions, or a clearly named no-go blocker with an active bound.
7. Final diff excludes `.humanize/`, caches, profiler dumps, build artifacts, and
   scratch logs; large artifacts live under `/opt/devmachine/lichangye`.

## Notes / Constraints

- `analyze` tasks (task2/4/6/8/10) MUST run via `/humanize:ask-codex` and integrate
  Codex output; `coding` tasks (task1/3/5/7/9/11) Claude executes directly.
- Do NOT edit oracle files: `glm52_ops.py`, `evaluate_task.py`, `timing.py`,
  `reward_hack.py`, generated task metadata, or anything under `legacy/`.
- Do NOT weaken tolerances, reseed/re-quantize inputs inside `run()`, change the
  cost model, or monkey-patch the reference.
- `--repeat 1` is a probe only; gate-quality (`--repeat 10 --iterations 30 --warmup 3`)
  is required before any final win claim.
