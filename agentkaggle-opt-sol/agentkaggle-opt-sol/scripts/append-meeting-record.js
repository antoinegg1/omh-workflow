// Meeting archiver:
//   1. FULL transcript (brief + every speaker's complete statement + moderator
//      decision) -> runs/<task>/meetings/<stamp>-<lane>.md  (the meeting log)
//   2. Conclusions/consensus -> wiki/meetings/<stamp>-<lane>-<task>.md
//   3. Per-task guidance sidecar for the next compactTaskContext round
//   4. Read-only verification: meeting agents must not have written any files
//      (diff against the snapshot meeting-gate-sol took when convening).
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { diffTree, laneFromContext, laneState, readJsonSafe, snapshotTree, taskArtifactDir } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);

const decision = localState.meetingDecision ?? {};
const brief = localState.meetingBrief ?? {};
const speakers = localState.meetingSpeakers ?? {};
const meeting = localState.meeting ?? {};
const taskContext = localState.taskContext ?? {};

const taskDir = meeting.task_dir || brief.task_dir || taskContext.task_dir || "";
const taskName = taskDir ? path.basename(taskDir) : "unknown";
const stamp = new Date().toISOString();
const safeStamp = stamp.replace(/[:.]/gu, "-");

// 4 first: read-only verification BEFORE this script writes anything.
const gateSnapshot = await readJsonSafe(fs, path.join(root, "workflow-output", `meeting-snapshot-${lane || "X"}.json`), null);
let readOnlyCheck = { checked: false, ok: true, changes: [] };
if (gateSnapshot && taskDir) {
	const currentRuns = await snapshotTree(fs, path, path.join(root, "runs", taskName), root);
	const currentWiki = await snapshotTree(fs, path, path.join(root, "wiki"), root);
	const changes = diffTree({ ...(gateSnapshot.runs ?? {}), ...(gateSnapshot.wiki ?? {}) }, { ...currentRuns, ...currentWiki });
	readOnlyCheck = { checked: true, ok: changes.length === 0, changes: changes.slice(0, 20) };
}

// 1. Full meeting transcript log (every speaker, complete statements).
const artifactDir = taskArtifactDir(path, root, taskDir || "unknown");
const meetingsLogDir = path.join(artifactDir, "meetings");
await fs.mkdir(meetingsLogDir, { recursive: true });
const logPath = path.join(meetingsLogDir, `${safeStamp}-${lane || "X"}.md`);
const speakerOrder = ["coordinator", "planner", "reviewer", "searchA", "searchB"];
const transcript = [
	`# Meeting Transcript — ${taskName} (lane ${lane || "X"})`,
	"",
	`- When: ${stamp}`,
	`- Task: ${taskDir}`,
	`- Trigger: ${meeting.reason || "stall"}`,
	`- Round: ${meeting.round ?? ""}, no-improvement streak: ${meeting.noImproveStreak ?? ""}`,
	`- Read-only check: ${readOnlyCheck.checked ? (readOnlyCheck.ok ? "ok (no files written by meeting agents)" : `VIOLATION: ${readOnlyCheck.changes.map((c) => c.path).join(", ")}`) : "no baseline"}`,
	"",
	"## Brief",
	"",
	"```json",
	JSON.stringify(brief, null, 2),
	"```",
	"",
	...speakerOrder.flatMap((name) => {
		const statement = speakers?.[name] ?? null;
		return [
			`## Speaker: ${name}`,
			"",
			statement ? "```json" : "(no statement recorded)",
			...(statement ? [JSON.stringify(statement, null, 2), "```"] : []),
			"",
		];
	}),
	"## Moderator decision",
	"",
	"```json",
	JSON.stringify(decision, null, 2),
	"```",
	"",
].join("\n");
await fs.writeFile(logPath, transcript);

// 2. Conclusions/consensus into the shared wiki.
const wikiRoot = process.env.SOL_H800_FLOW_WIKI_DIR || path.join(root, "wiki");
const meetingsWikiDir = path.join(wikiRoot, "meetings");
await fs.mkdir(meetingsWikiDir, { recursive: true });
const wikiRecordPath = path.join(meetingsWikiDir, `${safeStamp}-${lane || "X"}-${taskName}.md`);
const consensusList = Array.isArray(decision.consensus) ? decision.consensus : [];
const wikiRecord = [
	`# Meeting Conclusion — ${taskName} (lane ${lane || "X"})`,
	"",
	`- When: ${stamp}`,
	`- Task: ${taskDir}`,
	`- Trigger: ${meeting.reason || "stall"}`,
	`- Decision: **${decision.decision || "(none)"}**`,
	`- Full transcript: \`${path.relative(root, logPath)}\``,
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
	...(Array.isArray(decision.must_do_next) && decision.must_do_next.length
		? decision.must_do_next.map((item) => `- ${item}`)
		: ["- (none)"]),
	"",
	"## Consensus / dissent",
	"",
	...(consensusList.length
		? consensusList.map((item) =>
				typeof item === "object"
					? `- ${item.point ?? ""} (support: ${item.support ?? ""}; dissent: ${item.dissent ?? ""})`
					: `- ${item}`,
			)
		: ["- (none recorded)"]),
	"",
	"## Risks to watch",
	"",
	...(Array.isArray(decision.risks_to_watch) && decision.risks_to_watch.length
		? decision.risks_to_watch.map((item) => `- ${item}`)
		: ["- (none)"]),
	"",
].join("\n");
await fs.writeFile(wikiRecordPath, wikiRecord);

// 3. Guidance sidecar for the next round's task context.
let guidancePath = "";
if (taskDir) {
	const guidanceDir = path.join(root, "workflow-output", "meeting-guidance");
	await fs.mkdir(guidanceDir, { recursive: true });
	guidancePath = path.join(guidanceDir, `${taskName}.json`);
	await fs.writeFile(
		guidancePath,
		JSON.stringify(
			{
				lane,
				task_dir: taskDir,
				when: stamp,
				decision: decision.decision || "",
				next_candidate_direction: decision.next_candidate_direction || "",
				must_do_next: decision.must_do_next || [],
				risks_to_watch: decision.risks_to_watch || [],
				transcript: path.relative(root, logPath),
				wiki_record: path.relative(root, wikiRecordPath),
			},
			null,
			2,
		) + "\n",
	);
}

const report = {
	lane,
	task_dir: taskDir,
	decision: decision.decision || "",
	transcript: path.relative(root, logPath),
	wiki_record: path.relative(root, wikiRecordPath),
	guidance: guidancePath ? path.relative(root, guidancePath) : "",
	read_only_check: readOnlyCheck,
	when: stamp,
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", `meeting-record-${lane || "X"}.json`),
	JSON.stringify(report, null, 2) + "\n",
);

return {
	summary: `meeting archived for ${taskName} (lane ${lane}): ${report.decision || "no decision"}${readOnlyCheck.checked && !readOnlyCheck.ok ? " [read-only VIOLATION]" : ""}`,
	data: report,
	statePatch: [{ op: "set", path: `/lanes/${lane}/meetingRecord`, value: report }],
	artifacts: [
		`local://workflow-output/meeting-record-${lane || "X"}.json`,
		`local://${path.relative(root, logPath)}`,
		`local://${path.relative(root, wikiRecordPath)}`,
	],
};
