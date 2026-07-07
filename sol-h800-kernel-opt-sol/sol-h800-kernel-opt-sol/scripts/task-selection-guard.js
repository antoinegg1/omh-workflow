const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const {
	activeTaskEntries,
	extractTaskDir,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	taskLockDir,
	tryAcquireLock,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);

const state = workflowContext.state ?? {};
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const selection = local.selection ?? state.selection ?? {};
const taskDir = extractTaskDir(selection);
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });

const result = {
	lane,
	task_dir: taskDir,
	status: "idle",
	reason: "",
	active_tasks: activeTaskEntries(state),
};

if (!taskDir) {
	result.status = "idle";
	result.reason = "selection did not name a task";
} else if (!(await exists(path.join(root, taskDir)))) {
	result.status = "invalid";
	result.reason = `selected task does not exist: ${taskDir}`;
} else {
	const lockDir = taskLockDir(path, root, taskDir);
	const acquired = await tryAcquireLock(fs, lockDir, {
		lane,
		task_dir: taskDir,
		node_id: workflowContext.node?.id ?? "",
		activation_id: workflowContext.activation?.id ?? "",
	});
	const owner = acquired ? null : await readLockOwner(lockDir);
	const ownPreReservation = Boolean(owner?.lane && owner.lane === (lane || "single"));
	result.status = acquired || ownPreReservation ? "acquired" : "duplicate";
	result.reason = acquired
		? `slot ${lane || "single"} acquired ${taskDir}`
		: ownPreReservation
			? `slot ${lane || "single"} confirmed pre-reserved ${taskDir}`
			: `slot ${lane || "single"} rejected duplicate active task ${taskDir}`;
}

const outputPath = path.join(outputDir, "task-selection-guard.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

const patches = [lanePatch(lane, "selectionGuard", result)];
if (result.status === "acquired") {
	patches.push({
		op: "set",
		path: `/workerPool/activeTasks/${lane || "single"}`,
		value: { status: "active", lane: lane || "single", task_dir: taskDir, since: new Date().toISOString() },
	});
}

return {
	summary: result.reason || result.status,
	data: result,
	statePatch: patches,
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readLockOwner(lockDir) {
	try {
		return JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"));
	} catch {
		return null;
	}
}
