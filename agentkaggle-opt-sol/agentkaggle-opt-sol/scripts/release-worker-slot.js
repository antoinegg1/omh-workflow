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
const result = {
	lane,
	task_dir: taskDir,
	status: released ? "released" : "not_locked",
	released,
	at: new Date().toISOString(),
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "release-worker-slot.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${result.status} ${taskDir || "no task"}`,
	data: result,
	statePatch: [
		lanePatch(lane, "release", result),
		{ op: "set", path: `/workerPool/activeTasks/${lane || "single"}`, value: { status: "released", lane: lane || "single", task_dir: taskDir, released_at: result.at } },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};
