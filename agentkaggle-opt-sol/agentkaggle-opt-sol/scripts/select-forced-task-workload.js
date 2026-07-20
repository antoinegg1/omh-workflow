// Script task selector for forced/batch/ordered modes (the non-LLM alternative
// to the coordinator agent). Emits the same selection shape the guard expects.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	activeTaskDirs,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	normalizeTaskDir,
	parseTaskBatch,
	taskLockDir,
	tryAcquireLock,
	WORKER_LANES,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const state = workflowContext.state ?? {};
const campaign = workflowContext.state?.campaign ?? {};
const leaderboard = workflowContext.state?.leaderboard ?? {};
const taskBatchDirs = parseTaskBatch(process.env.SOL_H800_TASK_BATCH ?? campaign.taskBatch?.task_dirs?.join(",") ?? "");
const batchTaskDir = lane ? taskBatchDirs[WORKER_LANES.indexOf(lane)] || "" : taskBatchDirs[0] || "";
const singleForcedTaskDir = normalizeTaskDir(campaign.forcedTaskDir ?? process.env.SOL_H800_TASK_DIR ?? process.env.SOL_H800_FORCE_TASK ?? "");
const orderedMode = taskBatchDirs.length === 0 && campaign.taskBatch?.mode === "ordered";
const orderedSelection = orderedMode ? await reserveNextOrderedTask() : null;
const forcedTaskDir = orderedSelection?.task_dir || batchTaskDir || (lane && lane !== "A" ? "" : singleForcedTaskDir);
if (!forcedTaskDir) {
	const selection = {
		task_dir: "",
		status: "idle",
		reason: orderedMode
			? `no open ordered task available for worker slot ${lane || "single"}`
			: lane
			? `no forced task assigned to worker slot ${lane}`
			: "select-forced-task-workload requires SOL_H800_TASK_BATCH, /campaign/forcedTaskDir, or SOL_H800_TASK_DIR",
		forced: true,
		ordered: orderedMode,
		lane,
	};
	const outputDir = laneOutputDir(path, root, lane);
	await fs.mkdir(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, "forced-task-selection.json");
	await fs.writeFile(outputPath, JSON.stringify(selection, null, 2) + "\n");
	return {
		summary: selection.reason,
		data: selection,
		statePatch: [lanePatch(lane, "selection", selection)],
		artifacts: [`local://${path.relative(root, outputPath)}`],
	};
}

const taskDir = path.join(root, forcedTaskDir);
if (!(await exists(taskDir))) {
	throw new Error(`forced task does not exist: ${forcedTaskDir}`);
}

const task = (campaign.tasks ?? []).find((item) => item.task_dir === forcedTaskDir) ?? {};
const existingBest = (leaderboard.recent_best_by_task ?? leaderboard.best_by_task ?? []).find((row) => row.task_dir === forcedTaskDir);
const selection = {
	task_dir: forcedTaskDir,
	reason: orderedSelection?.reason || "forced by SOL_H800_TASK_DIR/SOL_H800_TASK_BATCH for a targeted workflow run",
	assignment_mode: "optimize",
	workload_focus: "full task; iterate with the fast local evaluation, submit on promotion",
	expected_bottleneck: "unknown — the planner should identify the main gap to the target from the task evidence",
	search_budget: 2,
	profile_policy: "request diagnostics only when local evidence is unclear",
	reward_hack_watchlist: [
		"edit only the run instance's solution/ files; never data/, evaluation/, TASK.md, or submit.py",
		"no hardcoded labels/predictions; predictions must come from the trained pipeline/solver",
		"do not read other agents' or previous runs' solutions, scores, notes, or logs for this task",
	],
	forced: true,
	ordered: orderedMode,
	pre_acquired_lock: Boolean(orderedSelection?.pre_acquired_lock),
	lane,
	task_batch_index: lane ? WORKER_LANES.indexOf(lane) : 0,
	order: task.order ?? null,
	group: task.group ?? "",
	sol_id: task.sol_id ?? "",
	existing_best_candidate: existingBest?.candidate ?? "",
};

const outputDir = laneOutputDir(path, root, lane, forcedTaskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "forced-task-selection.json");
await fs.writeFile(outputPath, JSON.stringify(selection, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane} ` : ""}${orderedMode ? "ordered" : "forced"} selection ${forcedTaskDir}`,
	data: selection,
	statePatch: [lanePatch(lane, "selection", selection)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

async function reserveNextOrderedTask() {
	const active = new Set(activeTaskDirs(state));
	const doneStatuses = new Set(["final_best", "parked_current_best", "parked_after_local_limit"]);
	const statusByOrder = new Map((campaign.taskUpdates?.task_status ?? []).map((item) => [Number(item.order), item.status ?? ""]));
	const tasks = [...(campaign.tasks ?? [])].sort((a, b) => Number(a.order) - Number(b.order));
	for (const task of tasks) {
		const taskDirRel = normalizeTaskDir(task.task_dir ?? "");
		if (!taskDirRel || active.has(taskDirRel)) continue;
		const status = statusByOrder.get(Number(task.order)) ?? "";
		if (doneStatuses.has(status)) continue;
		const lockDir = taskLockDir(path, root, taskDirRel);
		const acquired = await tryAcquireLock(fs, lockDir, {
			lane,
			task_dir: taskDirRel,
			node_id: workflowContext.node?.id ?? "",
			activation_id: workflowContext.activation?.id ?? "",
			selector: "ordered",
			order: task.order ?? null,
		});
		if (!acquired) continue;
		return {
			task_dir: taskDirRel,
			pre_acquired_lock: true,
			reason: `ordered selector reserved task order ${task.order}: ${taskDirRel}`,
		};
	}
	return null;
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
