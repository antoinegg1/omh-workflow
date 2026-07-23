CORE_RISKS:
- The draft assumes “official MoE rollups” can be optimized like normal candidate tasks. If rollups are aggregate metrics, not direct candidate ABI targets, claiming a rollup win from diagnostic split rows could produce an invalid win.
- Fallback safety is underspecified: shape dispatch must be exact, deterministic, and must not fall back on every shape while still reporting improvement.
- Correctness can be invalidated by hidden state: import-time autotune, cached tensors, reused output buffers, mutation of frozen inputs, or stale compiled extensions can make post-timing correctness diverge from timing behavior.
- Roofline claims can be misleading if MFU/BW are averaged across mixed compute-bound and memory-bound shapes instead of reported per shape with the evaluator’s primary resource.
- Target ranking could waste iterations by chasing low-latency launch-bound decode shapes where roofline headroom looks large but the active blocker is dispatch overhead or fusion opportunity outside the candidate ABI.
- The draft correctly rejects CUDA assumptions, but it should explicitly reject stale B200/deep_gemm assumptions from older repo guidance when operating under the ROCm MI300X frozen taskset.

MISSING_REQUIREMENTS:
- Require the exact evaluator command, taskset path, candidate root, commit SHA, ROCm env, and artifact directory to be recorded before any benchmark claim.
- Require a clean distinction between `selected_task`, `official_task`, `diagnostic_component`, and `official_total` in every table and final statement.
- Require baseline and candidate runs to use the same frozen taskset, same workload sweep, same env vars, same repeat policy, and same GPU identity.
- Require post-timing correctness on fresh inputs for every claimed task, not only a preflight or smoke shape.
- Require “zero regressions” to mean all measured shapes in the task scope, including fallback shapes, not only shapes with custom kernels.
- Require explicit handling of NaN-poisoned `out` buffers, tuple/list outputs, dtype expectations, strides/layout, and scale tensors.
- Require noise handling: no final win from a single `repeat=1` probe; use the authoritative repeat setting or rerun borderline wins.
- Require no-go decisions to include at least one credible alternate candidate direction or why the candidate ABI blocks the needed optimization.

TECHNICAL_GAPS:
- The plan does not say how candidates are organized for 11 operators plus MoE rollups without cross-contaminating imports, build caches, or compiled extension names.
- It does not specify how to prevent stale `.so` reuse after source edits, especially under `/opt/devmachine/lichangye/tmp`.
- It lacks a policy for shape-specific fallback tables: which M values use custom code, which call reference, and why each fallback is neutral.
- It does not define how official MoE totals are recomputed after changing a diagnostic component, or how attribution is assigned between gate/up/down pieces.
- Profiling discipline is directionally right but incomplete: each rocprof run needs a named hypothesis, exact shape/task, candidate artifact, profiler overhead caveat, and the specific counters or trace fields expected to answer it.
- Target ranking should combine latency contribution, primary-util headroom, correctness risk, implementation complexity, and whether the active bound is addressable inside `run(inputs)`.
- The plan should guard against optimizing diagnostic split rows that improve local latency but do not move official totals because the rollup is dominated by another component.

ALTERNATIVE_DIRECTIONS:
- Start with a full frozen-taskset baseline inventory, then rank only official metrics by weighted latency contribution and primary-util gap. Tradeoff: slower upfront, but avoids optimizing irrelevant diagnostic rows.
- Use a two-stage candidate loop: first PyTorch/AITER/SGLang library-kernel dispatch experiments, then custom HIP/Triton only where library coverage cannot win. Tradeoff: less bespoke control, faster evidence generation.
- Pick one official task per iteration and allow diagnostic profiling only to explain it. Tradeoff: lower parallelism, but cleaner attribution and lower risk of false MoE rollup claims.
- For decode tasks, prioritize launch/fusion feasibility before kernel micro-optimization. Tradeoff: may reveal the candidate ABI cannot express the needed fusion, but avoids roofline-chasing low-BW artifacts.
- For prefill compute-bound tasks, prioritize tile shape, datatype path, and AITER kernel selection experiments. Tradeoff: more build/profile overhead, but more likely to affect MFU.
- Keep a mandatory fallback matrix in the plan artifact. Tradeoff: extra bookkeeping, but it makes “wins one shape, regresses none” auditable.

QUESTIONS_FOR_USER:
- Should the loop optimize only direct candidate ABI tasks, or may it modify shared candidate infrastructure under an external `--candidate-root` for multiple operators?
- Are MoE rollups acceptance targets, reporting-only targets, or both?
- What is the minimum rerun policy for borderline wins: one authoritative run, two matching runs, or median of several?
- Should target ranking privilege official end-to-end latency contribution over local roofline headroom when they disagree?
- Are custom compiled HIP extensions allowed, or should first-pass candidates stay within Python/Torch/Triton/AITER dispatch?
- What exact artifact schema should the Humanize plan require for benchmark JSON, profiler output, and final summary tables?

CANDIDATE_CRITERIA:
- AC1: A claimed candidate run has `infra_failed == 0` and `incorrect == 0` in the authoritative evaluator JSON.
- AC2: A claimed task win has at least one winning shape and zero regressed shapes over the full frozen workload sweep.
- AC3: Every performance claim cites an artifact path containing task id, M, latency, speedup, MFU, BW util, GB/s, TFLOP/s, primary resource, and primary-util ratio.
- AC4: Every shape-specific custom path has an explicit fallback entry or custom-kernel entry, with no unreported shapes.
- AC5: No official MoE rollup win is claimed solely from diagnostic split rows unless the official rollup metric was recomputed and cited.
- AC6: No final no-go is accepted without baseline numbers, candidate attempt evidence, correctness state, roofline/profile evidence, and a named active bound or ABI blocker.
- AC7: ROCm profiling artifacts are used only to answer a named hypothesis and are never substituted for evaluator correctness or gate results.
- AC8: Final reporting separates official metrics, diagnostic components, and official totals, with no averaged MFU/BW across incompatible primary resources.
