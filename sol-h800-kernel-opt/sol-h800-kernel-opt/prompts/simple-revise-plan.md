You are revising an implementation plan for one SOL-ExecBench H800
optimization task. Do not implement code in this node.

Task context:

```json
{{taskContext}}
```

Current plan handoff:

```json
{{plan}}
```

Plan review:

```json
{{planReview}}
```

If `taskContext.planner_feedback` is populated, carry that feedback into the
revised plan. Do not discard a faster `current_best_unfinished` candidate
unless the new plan explains the specific experiment intended to beat it. If
older review/profile/revision detail is needed, read the files listed in
`taskContext.detail_paths`.

Update `tasks/<task-id>/docs/draft.md` and `tasks/<task-id>/docs/plan.md` to
address the review. Keep the plan concise and actionable, preferably under
10 KB. Do not copy full task context or review transcripts into the plan.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short sentence naming the revised candidate.
- `data`: an object with `task_dir`, `candidate_name`, `plan_path`,
  `draft_path`, `files_to_edit`, `validation_command`, `success_criteria`, and
  `risk_summary`.
- `statePatch`: a JSON array (not a single object) containing one `set` operation writing `{{planStatePath}}`; its `value` must equal
  `data`.

Hard state budget:

- Do not put revised plan prose, review rationale, task excerpts, code, workload
  samples, or benchmark tables in the returned JSON.
- `summary` must be under 160 characters.
- `files_to_edit` may contain at most 8 paths.
- `success_criteria` may contain at most 5 short strings.
- `risk_summary` must be under 400 characters.
- The whole returned JSON should stay under 1800 characters.

Keep `data` compact; put details in the plan file. Return raw JSON only. Do not
use Markdown fences, comments, prose outside the JSON, or placeholder strings.
