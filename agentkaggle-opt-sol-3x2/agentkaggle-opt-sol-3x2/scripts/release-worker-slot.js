const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	normalizeTaskDir,
	releaseLock,
	taskLockDir,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const { normalizeFailureFingerprint } = await import(
	`file://${path.join(resourceRoot, "scripts", "campaign-controls.js")}`
);
const { readCampaignControls } = await import(
	`file://${path.join(resourceRoot, "scripts", "campaign-controls.js")}`
);

const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
// Prefer the selection guard's task_dir: when materialization fails right after
// lock acquisition, taskContext still holds the PREVIOUS task and releasing that
// would leak the newly-acquired lock.
const taskDir = normalizeTaskDir(
	localState.selectionGuard?.task_dir ?? localState.taskContext?.task_dir ?? localState.validation?.task_dir ?? "",
);
const lockDir = taskDir ? taskLockDir(path, root, taskDir) : "";
const released = lockDir ? await releaseLock(fs, lockDir, lane || "single") : false;
const validation = localState.validation ?? {};
const localLoop = localState.localLoop ?? {};
const promotion = localState.leaderboardUpdate?.promotion ?? {};
const planReviewMeta = localState.planReviewMeta ?? {};
const controls = await readCampaignControls(fs, path, root);
const planReviewExhausted = planReviewMeta.decision === "abandon" && planReviewMeta.review_budget_exhausted === true;
const validationFailed = !planReviewExhausted && Boolean(validation.status) && validation.status !== "passed";
const failureText = planReviewExhausted
	? `plan_review_exhausted: ${planReviewMeta.round ?? 0}/${planReviewMeta.max_rounds ?? 0} rejected reviews`
	: validationFailed
	? `${validation.status}: ${validation.reason ?? validation.summary ?? validation.error ?? "validation did not pass"}`
	: "";
const result = {
	event: "released",
	lane,
	task_dir: taskDir,
	status: released ? "released" : "not_locked",
	released,
	at: new Date().toISOString(),
	window_id: controls.window_id ?? "",
	stint_ts: planReviewExhausted ? localState.selectionGuard?.stint_started_at ?? "" : localLoop.stint_ts ?? "",
	local_loop_status: planReviewExhausted ? "plan_review_exhausted" : localLoop.status ?? "",
	improved_this_round: planReviewExhausted ? false : Boolean(localLoop.improved_this_round),
	window_no_improve_streak: planReviewExhausted ? 0 : Number(localLoop.window_no_improve_streak ?? 0) || 0,
	stalled: !planReviewExhausted && localLoop.status === "stalled_after_no_improvement",
	validation_status: planReviewExhausted ? "not_run" : validation.status ?? "",
	failure_fingerprint: normalizeFailureFingerprint(failureText),
	submission_status: promotion.submission_status ?? "",
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "release-worker-slot.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
const eventsPath = path.join(root, "workflow-output", "stint-events.jsonl");
if (taskDir) await fs.appendFile(eventsPath, JSON.stringify(result) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${result.status} ${taskDir || "no task"}`,
	data: result,
	statePatch: [
		lanePatch(lane, "release", result),
		{ op: "set", path: `/workerPool/activeTasks/${lane || "single"}`, value: { status: "released", lane: lane || "single", task_dir: taskDir, released_at: result.at } },
	],
	artifacts: [
		`local://${path.relative(root, outputPath)}`,
		...(taskDir ? ["local://workflow-output/stint-events.jsonl"] : []),
	],
};
