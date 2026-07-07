You are preparing a stall-recovery meeting for one H800 kernel-optimization lane.
The lane has made 2 consecutive local rounds with no improvement, so a meeting is
convened to break the impasse.

Meeting gate:

```json
{{meeting}}
```

Task context (includes latest wiki findings in `wiki_excerpt`):

```json
{{taskContext}}
```

Latest validation:

```json
{{validation}}
```

Latest performance review:

```json
{{performanceReview}}
```

Write a concise meeting brief the speakers will each respond to. Focus on WHY the
lane is stuck and WHAT decision is needed to move forward.

Return exactly one JSON object with OMH activation output fields:

- `summary`: one short line naming the meeting topic.
- `data`: object with:
  - `topic`: the impasse in one line.
  - `task_dir`, `operator`, `candidate`: from context.
  - `stall_evidence`: 2–4 bullet strings on what failed to improve.
  - `decision_needed`: the specific question speakers must help answer.
  - `constraints`: H800/SM90 constraints, protected-file rules, correctness bar.
  - `questions`: 3–5 concrete questions for the speakers.
- `statePatch`: a JSON array with one `set` op writing `{{briefStatePath}}`; its
  `value` must equal `data`.

Return raw JSON only. First char `{`, last char `}`. No Markdown fences.
