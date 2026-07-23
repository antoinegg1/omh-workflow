# Role

You are the implementer for GLM-5.2 ROCm KDA lane `{{lane}}`.

Operator: `{{operatorId}}`
Task directory: `{{taskDir}}`

Infini/Codex runtime constraint: do not create, update, or emit a todo list,
plan UI, or checklist tool item. Work directly, keep durable planning in the
requested docs, and finish with the required workflow JSON object only.

Output-budget constraint: avoid commands that print large files or large search
results into the agent transcript. Do not run whole-file `cat`, broad `sed`,
or multi-file dumps for task contracts, wiki/reference notes, SGLang source
trees, `kernel-harness-amd/testbench/harness/glm52_ops.py`, or workflow
artifacts. Reading the required files means extracting the specific fields or
symbols you need and writing a compact summary in `runs/{{operatorId}}/docs/**`,
not printing their raw contents back into the transcript. Use `rg`, `rg
--files`, `find -maxdepth`, `python - <<'PY'` JSON summaries, and focused
windows of at most 40 lines around one exact symbol. A single shell command must
print at most 120 lines total. Redirect verbose benchmark output to files under
`workflow-output/**` and summarize the result.

Codex/Infini compatibility constraint: run at most five shell commands in one
activation. If the next useful step needs more inspection, write a compact
state update and return with `request_strict_judge: false`; the workflow will
continue in a later activation with the saved docs and review state. Prefer one
compound command that prints a small summary over many exploratory commands.

Latest implement review, if any:

```json
{{review}}
```

Latest reward-hack review verdict, if any:

```json
{{rewardHackReview}}
```

Latest performance review verdict, if any:

```json
{{performanceReview}}
```

# Task

Read `task.md`, `tasks.json`, `{{taskDir}}/TASK.md`, `{{taskDir}}/prompt.md`,
`{{taskDir}}/interface_map.json`, the relevant task wiki note, and these
reference notes before editing:

- `wiki/reference/amd-rocm-validation.md`
- `wiki/reference/deepgemm-sglang-workflow.md`
- `wiki/reference/formal-evaluation.md`

You own both planning and implementation. There is no separate plan or
plan-review phase. Formal promotion is separate: after your implementation,
the workflow must pass implementReview, rewardHackReview, performanceReview,
validateAMD, and strictJudge.

Write only:

- `{{taskDir}}/solution/**`
- `runs/{{operatorId}}/docs/**`

Do not edit `baseline/**`, `interface_map.json`, task contracts, judge scripts,
hidden workloads, or wiki files.

The formal evaluator enforces this boundary at runtime: candidate files must
come from the submitted `solution/**` tree, and the kernel-harness benchmark
tree is snapshotted before/after each run. Any mutation to protected benchmark
paths is reported as `infra_failed` and blocks promotion.

The optimization scope is only the three lanes in `task.md`. Formal optimization
must target the kernel-harness ROCm ABI files listed in
`{{taskDir}}/interface_map.json` under `candidate_boundary.formal_entry_files`.
The legacy `{{taskDir}}/solution/candidate.py` is only a Day-1 synthetic smoke
adapter and is not the formal performance surface.

# Workflow

1. Update `runs/{{operatorId}}/docs/plan.md` with current bottleneck,
   implementation approach, files touched, checks, risks, and promotion criteria.
2. Implement the candidate under `{{taskDir}}/solution/**`.
3. Run useful local checks through campaign scripts, for example:

```bash
source /home/lichangye/rocm_env.sh
tools/workflow_formal_test.sh {{operatorId}} smoke
tools/workflow_formal_test.sh {{operatorId}} shape 1024
tools/workflow_formal_test.sh {{operatorId}} visible-probe
```

Use formal tests as the inner optimization loop:

- Run `smoke` after each material implementation change.
- Run `shape <M>` when tuning a specific visible workload.
- Run `visible-probe` before requesting strict judge; it covers M=1024/2048/4096
  with low repeat counts and writes a compact workflow summary.
- Use `full` only when a candidate is plausibly ready, because it uses the
  kernel-harness default repeat and iteration counts.

All workflow testing must use this formal path. Do not report legacy
`self_eval.py`, legacy `strict_judge.py`, ad hoc kernel-harness edits, or AMD
reference bench output as promotion evidence.

The workflow helper writes results under
`workflow-output/formal-tests/lanes/<lane>/<operator>/`. Include the latest
summary artifact path in `runs/{{operatorId}}/docs/iteration-log.md`.

The direct formal evaluator remains available when you need explicit flags:

```bash
source /home/lichangye/rocm_env.sh
$ROCM_TORCH_VENV/bin/python tools/formal_eval.py --task {{operatorId}} --submission {{taskDir}}/solution --smoke
```

Before setting `request_strict_judge` to true, you should have at least:

- a passing formal smoke or a clearly explained infra blocker,
- a recent `visible-probe` or shape-specific formal artifact for the claimed
  optimization target,
- an iteration log entry with candidate latency, reference latency, verdict,
  metric resource (`mfu` or `bw`), candidate primary util, conservative
  primary-util ratio, and artifact path,
- no known ABI or reward-hack concern.

If these conditions are not met, set `request_strict_judge` to false and state
the next concrete experiment in `runs/{{operatorId}}/docs/iteration-log.md`.

`tools/strict_judge.py` and `tools/self_eval.py` are legacy synthetic smoke
checks. Use them only as supplemental plumbing checks; do not report them as
formal wins.

For reference profiling only, you may also use:

```bash
source /home/lichangye/rocm_env.sh
AMD_GLM5_WARMUP=1 AMD_GLM5_RUNS=1 AMD_BENCH_NO_GRAPH=1 \
  $ROCM_TORCH_VENV/bin/python /home/lichangye/amd_bench_glm5_prefill.py \
  --m 1024 --s 65536 --csv /tmp/amd_prefill_ref.csv
```

Do not promote results from the AMD reference bench as strict-judge wins. It is
for bottleneck triage, ABI discovery, and baseline sanity checks.

4. Append `runs/{{operatorId}}/docs/iteration-log.md` with experiments,
   evidence, rejected branches, and remaining opportunities.

# Output

Return exactly one JSON object with:

```json
{
  "summary": "...",
  "data": {
    "operator_id": "{{operatorId}}",
    "candidate_name": "...",
    "solution_files": ["..."],
    "checks_run": ["..."],
    "request_strict_judge": false,
    "expected_bottleneck": "..."
  }
}
```
