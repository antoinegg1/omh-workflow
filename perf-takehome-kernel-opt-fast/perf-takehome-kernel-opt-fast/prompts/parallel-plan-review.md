You are reviewing planner {{plannerLane}}'s plan for one SOL-ExecBench H800
optimization task.

Do not edit files. Review the selected task context and the plan handoff. Use
the handoff JSON only; lane-specific plan files are materialized later by the
workflow after both planner reviews finish.

Task context:

```json
{{taskContext}}
```

Plan handoff:

```json
{{plan}}
```

Return `approve` only if the plan is specific enough for implementation, is
semantically correct for the task, preserves full-workload correctness, and
does not rely on reward-hacking behavior. Return `revise` if the plan is vague,
unsafe, likely incorrect, missing validation evidence, or gives implementers
too much discretion.

Do not run benchmarks, compile code, inspect unrelated files, or do broad
repository searches from this review node.

If the task context includes `planner_feedback`, reject plans that do not
directly address `planner_feedback.must_do_next`,
`planner_feedback.blocking_reason`, or `planner_feedback.next_experiments`. In
particular, if `planner_feedback.profile_required=true`, approve only a plan
that explicitly obtains or uses profile evidence before another speculative
rewrite. If older details are needed for review, read the files listed in
`taskContext.detail_paths`.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short review decision naming planner {{plannerLane}}.
- `data`: an object with `planner_lane`, `verdict` (`approve` or `revise`),
  `required_changes`, `rationale`, and `confidence`.
- `statePatch`: a JSON array containing one `set` operation writing
  `{{reviewStatePath}}`; its `value` must equal `data`.

Keep `required_changes` to at most 6 concise items and `rationale` under 1200
characters. Return raw JSON only. Do not use Markdown fences, comments, prose
outside the JSON, or placeholder strings.
