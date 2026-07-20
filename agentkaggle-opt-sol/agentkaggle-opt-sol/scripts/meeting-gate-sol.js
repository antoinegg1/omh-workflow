// Meeting gate (stall detection). Runs after taskLocalLoopGate on each worker lane.
// Convenes a meeting when the lane has made 2 consecutive local rounds with no
// improvement (improved_this_round == false) AND the lane is about to do another
// round (continueSameTask == true). The no-improvement streak is persisted per
// (lane, task_dir) in a small sidecar file so it survives across rounds.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneState, snapshotTree } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const loop = localState.localLoop ?? {};
const taskContext = localState.taskContext ?? {};

const taskDir = loop.task_dir || taskContext.task_dir || "";
const improved = Boolean(loop.improved_this_round);
const continueSameTask = Boolean(loop.continueSameTask);
const round = Number.isFinite(Number(loop.round)) ? Number(loop.round) : 0;

const THRESHOLD = 2; // consecutive no-improvement rounds -> convene meeting

// Persist streak per (lane, task_dir). Reset when task changes or on improvement.
const stateDir = path.join(root, "workflow-output", "meeting-streaks");
await fs.mkdir(stateDir, { recursive: true });
const streakFile = path.join(stateDir, `${lane || "X"}.json`);
let prior = { task_dir: "", noImproveStreak: 0, lastMeetingRound: -1 };
try {
	prior = JSON.parse(await fs.readFile(streakFile, "utf8"));
} catch {
	/* first time */
}

if (prior.task_dir !== taskDir) {
	prior = { task_dir: taskDir, noImproveStreak: 0, lastMeetingRound: -1 };
}

// Only count a round once validation passed (round advanced) and cost did not improve.
if (improved) {
	prior.noImproveStreak = 0;
} else if (loop.validation_status === "passed") {
	prior.noImproveStreak = (prior.noImproveStreak || 0) + 1;
}

// Convene when the streak reached the threshold, the lane will keep going on this
// task, and we haven't already held a meeting for this exact round.
const required =
	continueSameTask &&
	prior.noImproveStreak >= THRESHOLD &&
	prior.lastMeetingRound !== round;

if (required) {
	prior.lastMeetingRound = round;
	// Reset the streak so the next meeting only fires after another 2 stalls.
	prior.noImproveStreak = 0;
	// Baseline snapshot for the meeting read-only guard. The task run is locked
	// to this lane during the meeting, so changes here are attributable. The wiki
	// is intentionally excluded because its searchers continue concurrently.
	const taskName = taskDir ? path.basename(taskDir) : "";
	const meetingBaseline = {
		taken_at: new Date().toISOString(),
		task_dir: taskDir,
		runs: taskName ? await snapshotTree(fs, path, path.join(root, "runs", taskName), root) : {},
	};
	await fs.writeFile(
		path.join(root, "workflow-output", `meeting-snapshot-${lane || "X"}.json`),
		JSON.stringify(meetingBaseline) + "\n",
	);
}

await fs.writeFile(streakFile, JSON.stringify(prior, null, 2) + "\n");

const meeting = {
	required,
	reason: required
		? "2 consecutive rounds without improvement"
		: improved
			? "improved this round"
			: continueSameTask
				? `no-improvement streak ${prior.noImproveStreak}/${THRESHOLD}`
				: "lane not continuing this task",
	lane,
	task_dir: taskDir,
	operator: taskContext.operator || (taskDir ? path.basename(taskDir) : ""),
	candidate: loop.candidate || "",
	round,
	noImproveStreak: prior.noImproveStreak,
};

const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
	path.join(outDir, `meeting-gate-${lane || "X"}.json`),
	JSON.stringify(meeting, null, 2) + "\n",
);

return {
	summary: `meeting ${required ? "required" : "not required"} (${meeting.reason})`,
	data: meeting,
	statePatch: [{ op: "set", path: `/lanes/${lane}/meeting`, value: meeting }],
	artifacts: [`local://workflow-output/meeting-gate-${lane || "X"}.json`],
};
