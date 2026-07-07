const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
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
const existingBest = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === forcedTaskDir);
const selection = {
	task_dir: forcedTaskDir,
	reason: orderedSelection?.reason || "forced by SOL_H800_TASK_DIR for a targeted workflow run",
	workload_focus: "full workload; no workload truncation",
	expected_bottleneck: task.group === "Quant" ? "quantized tensor-core compute and epilogue bandwidth" : "task-specific H800 latency",
	scout_budget: { glm: 1, deepseek: 1 },
	profile_policy: "profile only when validation passes but latency or bottleneck evidence is unclear",
	reward_hack_watchlist: [
		"do not branch on workload uuid, trace order, pointer identity, or evaluator internals",
		"do not promote from smoke tests or reference speedup",
		"do not edit task definition, workload, reference, or protected workflow files",
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
	const lockRoot = path.join(root, "workflow-output", "active-task-locks");
	await fs.mkdir(lockRoot, { recursive: true });
	for (const task of tasks) {
		const taskDir = normalizeTaskDir(task.task_dir ?? "");
		if (!taskDir || active.has(taskDir)) continue;
		const status = statusByOrder.get(Number(task.order)) ?? "";
		if (doneStatuses.has(status)) continue;
		const lockDir = taskLockDir(path, root, taskDir);
		const acquired = await tryAcquireLock(fs, lockDir, {
			lane,
			task_dir: taskDir,
			node_id: workflowContext.node?.id ?? "",
			activation_id: workflowContext.activation?.id ?? "",
			selector: "ordered",
			order: task.order ?? null,
		});
		if (!acquired) continue;
		return {
			task_dir: taskDir,
			pre_acquired_lock: true,
			reason: `ordered selector reserved task order ${task.order}: ${taskDir}`,
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
