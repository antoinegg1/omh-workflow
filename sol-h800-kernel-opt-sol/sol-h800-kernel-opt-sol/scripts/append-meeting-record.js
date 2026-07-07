// Append the moderator's meeting decision to wiki/meetings/, expose it in state at
// /lanes/{L}/meetingDecision, and drop a per-task sidecar file the next
// compactTaskContext round folds into planner guidance so reviseStrategy/draftPlan
// act on the meeting outcome.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt-sol");
const { laneFromContext, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);

const decision = localState.meetingDecision ?? {};
const brief = localState.meetingBrief ?? {};
const meeting = localState.meeting ?? {};
const taskContext = localState.taskContext ?? {};

const taskDir = meeting.task_dir || brief.task_dir || taskContext.task_dir || "";
const operator = meeting.operator || brief.operator || (taskDir ? path.basename(taskDir) : "unknown");
const stamp = new Date().toISOString();
const safeStamp = stamp.replace(/[:.]/gu, "-");

// 1. Archive the meeting to wiki/meetings/<stamp>-<lane>-<operator>.md
const meetingsDir = path.join(root, "wiki", "meetings");
await fs.mkdir(meetingsDir, { recursive: true });
const recordPath = path.join(meetingsDir, `${safeStamp}-${lane}-${operator}.md`);
const record = [
	`# Meeting — ${operator} (lane ${lane})`,
	"",
	`- When: ${stamp}`,
	`- Task: ${taskDir}`,
	`- Trigger: ${meeting.reason || "stall"}`,
	`- Decision: **${decision.decision || "(none)"}**`,
	"",
	"## Rationale",
	"",
	String(decision.rationale || "(none)"),
	"",
	"## Next candidate direction",
	"",
	String(decision.next_candidate_direction || "(none)"),
	"",
	"## Must do next",
	"",
	...(Array.isArray(decision.must_do_next) ? decision.must_do_next.map((s) => `- ${s}`) : ["- (none)"]),
	"",
	"## Full decision",
	"",
	"```json",
	JSON.stringify(decision, null, 2),
	"```",
	"",
].join("\n");
await fs.writeFile(recordPath, record);

// 2. Per-task sidecar so the next compactTaskContext round can surface it.
// Written under workflow-output/ (git-ignored scratch) so it never trips the
// read-only workspace guard of nodes running in parallel on other lanes.
let guidancePath = "";
if (taskDir) {
	const guidanceDir = path.join(root, "workflow-output", "meeting-guidance");
	await fs.mkdir(guidanceDir, { recursive: true });
	guidancePath = path.join(guidanceDir, `${path.basename(taskDir)}.json`);
	await fs.writeFile(
		guidancePath,
		JSON.stringify(
			{
				lane,
				operator,
				when: stamp,
				decision: decision.decision || "",
				next_candidate_direction: decision.next_candidate_direction || "",
				must_do_next: decision.must_do_next || [],
				risks_to_watch: decision.risks_to_watch || [],
				record: path.relative(root, recordPath),
			},
			null,
			2,
		) + "\n",
	);
}

const report = {
	lane,
	operator,
	task_dir: taskDir,
	decision: decision.decision || "",
	record: path.relative(root, recordPath),
	guidance: guidancePath ? path.relative(root, guidancePath) : "",
	when: stamp,
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", `meeting-record-${lane}.json`),
	JSON.stringify(report, null, 2) + "\n",
);

const artifacts = [
	`local://workflow-output/meeting-record-${lane}.json`,
	`local://${path.relative(root, recordPath)}`,
];
if (guidancePath) artifacts.push(`local://${path.relative(root, guidancePath)}`);

return {
	summary: `meeting recorded for ${operator} (lane ${lane}): ${report.decision || "no decision"}`,
	data: report,
	statePatch: [{ op: "set", path: `/lanes/${lane}/meetingRecord`, value: report }],
	artifacts,
};
