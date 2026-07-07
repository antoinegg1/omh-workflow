const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const {
	compactWorkerPool,
	normalizeTaskDir: normalizeTaskDirShared,
	parseTaskBatch,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const taskText = await fs.readFile(path.join(root, "task.md"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));
const leaderboard = await readJson(path.join(root, "leaderboard.json"), {
	best_count: 0,
	best_by_task: [],
});
const workerPool = compactWorkerPool(state);
const previousLocalLoop = state.campaign?.localLoop ?? {};

const allTasks = manifest.tasks ?? [];
const taskRange = parseTaskRange(process.env.SOL_H800_TASK_RANGE ?? process.env.SOL_H800_TASK_ORDERS ?? "");
const taskSkip = parseTaskRange(process.env.SOL_H800_TASK_SKIP ?? "");
const orderedSelectorEnabled =
	process.env.SOL_H800_ORDERED_TASKS === "1" ||
	process.env.SOL_H800_ORDERED === "1" ||
	taskRange.enabled ||
	taskSkip.enabled;
const forcedTaskDir = normalizeTaskDirShared(process.env.SOL_H800_TASK_DIR ?? process.env.SOL_H800_FORCE_TASK ?? "");
const taskBatchDirs = parseTaskBatch(process.env.SOL_H800_TASK_BATCH ?? "");

// Runtime configuration knobs (all default to today's full-campaign behavior when
// unset, so existing launches are unaffected). Edges gate on these /config paths.
const config = {
	// Number of worker lanes to enable (1..3). Lane A always on; B needs >=2; C needs >=3.
	workerLanes: clampInt(process.env.SOL_H800_WORKER_LANES, 3, 1, 3),
	// Wiki-search lane: 0 = whole lane off; >=1 = on (both glm+deepseek searchers).
	searchAgents: clampInt(process.env.SOL_H800_SEARCH_AGENTS, 2, 0, 2),
	// Plan depth: "off" = full plan->review->revise; "light" = draft only (skip review/revise);
	// "full" = no planning, go straight from task context to finalize+implement.
	simplifyPlan: parseSimplifyPlan(process.env.SOL_H800_SIMPLIFY_PLAN),
	// Coordinator task selection. false => always use the forced/script selector (needs a
	// task set via FORCE_TASK / TASK_BATCH / ordered range).
	useCoordinator: parseBoolEnv(process.env.SOL_H800_USE_COORDINATOR, true),
};

const taskBatch = {
	enabled: taskBatchDirs.length > 0 || (orderedSelectorEnabled && !forcedTaskDir),
	mode: taskBatchDirs.length > 0 ? "batch" : orderedSelectorEnabled && !forcedTaskDir ? "ordered" : "disabled",
	task_dirs: taskBatchDirs,
	ordered: {
		enabled: orderedSelectorEnabled && taskBatchDirs.length === 0 && !forcedTaskDir,
		selection_policy: "lowest order open task not already active",
	},
};
const tasks = allTasks.filter((task) => taskIncluded(task, taskRange, taskSkip));
const baseTasks = tasks.map((task) => ({
	order: task.order,
	group: task.group,
	sol_id: task.sol_id,
	task_dir: task.task_dir,
}));
const taskStatus = [];
const taskDetails = [];
for (const task of tasks) {
	const taskDir = path.join(root, task.task_dir);
	const candidates = await readJsonl(path.join(taskDir, "candidates.jsonl"));
	const benchmarkExists = await exists(path.join(taskDir, "benchmark.csv"));
	const best = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === task.task_dir);
	const currentBest = bestPassedCandidate(candidates);
	const previousLoopForTask = previousLocalLoop.task_dir === task.task_dir ? previousLocalLoop : {};
	const localLoopExhausted =
		candidates.some((row) => Boolean(row?.local_loop_exhausted)) ||
		Boolean(currentBest?.local_loop_exhausted) ||
		previousLoopForTask.status === "parked_after_local_limit";
	const status = taskStatusLabel({ best, currentBest, localLoopExhausted, candidates });
	taskStatus.push(compactTaskStatus({
		order: task.order,
		status,
		best_p50_ms: best?.p50_ms ?? null,
		current_best_p50_ms: currentBest ? metric(currentBest, "median_ms", "p50_ms") : null,
		local_loop_exhausted: localLoopExhausted,
		local_loop_rounds: Number(currentBest?.local_loop_round ?? previousLoopForTask.round ?? 0) || 0,
		candidate_count: candidates.length,
		passed_candidate_count: candidates.filter(isPassedCandidate).length,
	}));
	taskDetails.push({
		order: task.order,
		group: task.group,
		sol_id: task.sol_id,
		task_dir: task.task_dir,
		status,
		candidate_count: candidates.length,
		passed_candidate_count: candidates.filter(isPassedCandidate).length,
		has_benchmark: benchmarkExists,
		best_p50_ms: best?.p50_ms ?? null,
		best_candidate: best?.candidate ?? "",
		current_best_p50_ms: currentBest ? metric(currentBest, "median_ms", "p50_ms") : null,
		current_best_candidate: currentBest?.candidate ?? "",
		current_best_solution_snapshot: currentBest ? candidateSolutionSnapshot(task.task_dir, currentBest) : "",
		local_loop_exhausted: localLoopExhausted,
		local_loop_rounds: Number(currentBest?.local_loop_round ?? previousLoopForTask.round ?? 0) || 0,
		local_loop_max_rounds: Number(currentBest?.local_loop_max_rounds ?? previousLoopForTask.max_rounds ?? 0) || 0,
	});
}

const progress = {
	taskCount: tasks.length,
	totalManifestTaskCount: allTasks.length,
	taskRange: compactTaskRange(taskRange),
	taskSkip: compactTaskRange(taskSkip),
	bestCount: taskStatus.filter((task) => task.status === "final_best").length,
	doneCount: taskStatus.filter((task) => taskDone(task.status)).length,
	openCount: taskStatus.filter((task) => !taskDone(task.status)).length,
	unoptimizedCount: taskStatus.filter((task) => task.status !== "final_best").length,
	unfinishedBestCount: taskStatus.filter((task) => ["unfinished_current_best", "parked_current_best"].includes(task.status)).length,
	localLoopExhaustedCount: taskStatus.filter((task) => task.local_loop_exhausted).length,
	activeWorkerCount: workerPool.active_tasks.length,
};
const detailPaths = {
	task_contract: "task.md",
	manifest: "tasks.json",
	leaderboard: "leaderboard.json",
	campaign_state: "workflow-output/campaign-state.json",
	per_task_pattern: {
		task_contract: "tasks/<task-dir>/task.md",
		definition: "tasks/<task-dir>/definition.json",
		reference: "tasks/<task-dir>/reference.py",
		workload: "tasks/<task-dir>/workload.jsonl",
		candidates: "tasks/<task-dir>/candidates.jsonl",
		benchmark: "tasks/<task-dir>/benchmark.csv",
		docs: "tasks/<task-dir>/docs/",
		runs: "tasks/<task-dir>/runs/",
	},
	note: "The workflow prompt receives only bounded selector state. Read campaign_state or per-task paths for full evidence.",
};
const taskUpdates = {
	progress,
	latest_local_loop: compactLocalLoop(previousLocalLoop),
	worker_pool: workerPool,
	task_batch: taskBatch,
	task_range: compactTaskRange(taskRange),
	task_skip: compactTaskRange(taskSkip),
	status_policy:
		"Current status only. Do not select worker_pool.active_task_dirs, final_best, parked_current_best, or parked_after_local_limit tasks; a selection guard will reject duplicates. Join task_status.order with the base task list for task_dir; full evidence is path-only.",
	task_status: taskStatus,
	interesting_tasks: interestingTasks(taskStatus, baseTasks),
};
const taskContractSummary = summarizeTaskContract(taskText);

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", "campaign-state.json"),
	JSON.stringify(
		{ progress, tasks: baseTasks, updates: taskUpdates, detail_paths: detailPaths, task_details: taskDetails, worker_pool: workerPool },
		null,
		2,
	) + "\n",
);

return {
	summary: `loaded ${tasks.length}/${allTasks.length} tasks; ${progress.bestCount} final best, ${progress.doneCount} done-or-parked, ${progress.unfinishedBestCount} unfinished current best`,
	data: { progress },
	statePatch: [
		{ op: "set", path: "/campaign/taskContract", value: taskContractSummary },
		{ op: "set", path: "/campaign/tasks", value: baseTasks },
		{ op: "set", path: "/campaign/taskUpdates", value: taskUpdates },
		{ op: "set", path: "/campaign/detailPaths", value: detailPaths },
		{ op: "set", path: "/campaign/progress", value: progress },
		{ op: "set", path: "/campaign/forcedTaskDir", value: forcedTaskDir },
		{ op: "set", path: "/campaign/taskBatch", value: taskBatch },
		{ op: "set", path: "/config", value: config },
		{ op: "set", path: "/leaderboard", value: compactLeaderboard(leaderboard) },
	],
	artifacts: ["local://workflow-output/campaign-state.json"],
};

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function clampInt(value, fallback, min, max) {
	const raw = String(value ?? "").trim();
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function parseBoolEnv(value, fallback) {
	const raw = String(value ?? "").trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

function parseSimplifyPlan(value) {
	const raw = String(value ?? "").trim().toLowerCase();
	if (raw === "light" || raw === "full") return raw;
	// Accept a few aliases; anything else (incl. empty / "0" / "off") keeps the full loop.
	if (raw === "1" || raw === "true" || raw === "on") return "light";
	return "off";
}

function parseTaskRange(value) {
	const raw = String(value ?? "").trim();
	const range = { enabled: false, raw, orders: new Set(), description: "all tasks" };
	if (!raw) return range;
	for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
		const span = part.match(/^(\d+)\s*-\s*(\d+)$/u);
		if (span) {
			const start = Number(span[1]);
			const end = Number(span[2]);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
				throw new Error(`invalid SOL_H800_TASK_RANGE segment: ${part}`);
			}
			for (let order = start; order <= end; order += 1) range.orders.add(order);
			continue;
		}
		const single = Number(part);
		if (!Number.isInteger(single) || single <= 0) {
			throw new Error(`invalid SOL_H800_TASK_RANGE segment: ${part}`);
		}
		range.orders.add(single);
	}
	range.enabled = range.orders.size > 0;
	range.description = compactOrderDescription(range.orders);
	return range;
}

function compactTaskRange(range) {
	return {
		enabled: Boolean(range.enabled),
		raw: range.raw,
		description: range.description,
		orders: Array.from(range.orders ?? []).sort((a, b) => a - b),
	};
}

function compactOrderDescription(orders) {
	const sorted = Array.from(orders).sort((a, b) => a - b);
	if (sorted.length === 0) return "all tasks";
	const spans = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (const order of sorted.slice(1)) {
		if (order === prev + 1) {
			prev = order;
			continue;
		}
		spans.push(start === prev ? String(start) : `${start}-${prev}`);
		start = order;
		prev = order;
	}
	spans.push(start === prev ? String(start) : `${start}-${prev}`);
	return spans.join(",");
}

function taskDone(status) {
	return ["final_best", "parked_current_best", "parked_after_local_limit"].includes(status);
}

function taskIncluded(task, includeRange, skipRange) {
	const order = Number(task.order);
	if (!Number.isFinite(order)) return false;
	if (includeRange.enabled && !includeRange.orders.has(order)) return false;
	if (skipRange.enabled && skipRange.orders.has(order)) return false;
	return true;
}

async function readJson(filePath, fallback) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

async function readJsonl(filePath) {
	try {
		const text = await fs.readFile(filePath, "utf8");
		return text
			.split(/\r?\n/u)
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return {};
				}
			});
	} catch {
		return [];
	}
}

function compactLeaderboard(value) {
	return {
		generated_at: value.generated_at ?? "",
		metric: value.metric ?? "local_h800_p50_latency_ms",
		best_count: value.best_count ?? 0,
		recent_best_by_task: (value.best_by_task ?? []).slice(-8).map((row) => ({
			order: row.order,
			task_dir: row.task_dir,
			candidate: row.candidate,
			p50_ms: row.p50_ms,
			summary_path: row.summary_path,
		})),
		leaderboard_file: "leaderboard.json",
		note: "State keeps only recent leaderboard rows. Read leaderboard_file for full best_by_task.",
	};
}

function bestPassedCandidate(rows) {
	return rows
		.filter((row) => isPassedCandidate(row) && Number.isFinite(metric(row, "median_ms", "p50_ms")))
		.sort((a, b) => metric(a, "median_ms", "p50_ms") - metric(b, "median_ms", "p50_ms"))[0];
}

function isPassedCandidate(row) {
	if (!row || typeof row !== "object") return false;
	if (!["passed", "promoted"].includes(String(row.status ?? "").toLowerCase())) return false;
	const passed = Number(row.passed);
	const total = Number(row.total);
	if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) return passed === total;
	return Number.isFinite(metric(row, "median_ms", "p50_ms"));
}

function metric(row, ...keys) {
	for (const key of keys) {
		const value = Number(row?.[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function taskStatusLabel({ best, currentBest, localLoopExhausted, candidates }) {
	if (best) return "final_best";
	if (currentBest && localLoopExhausted) return "parked_current_best";
	if (currentBest) return "unfinished_current_best";
	if (localLoopExhausted) return "parked_after_local_limit";
	if (candidates.length > 0) return "attempted_no_valid_best";
	return "unstarted";
}

function compactTaskStatus(task) {
	const result = {
		order: task.order,
		status: task.status,
	};
	if (task.best_p50_ms !== null) result.best_p50_ms = task.best_p50_ms;
	if (task.current_best_p50_ms !== null) result.current_best_p50_ms = task.current_best_p50_ms;
	if (task.local_loop_exhausted) result.local_loop_exhausted = true;
	if (task.local_loop_rounds) result.local_loop_rounds = task.local_loop_rounds;
	if (task.candidate_count) result.candidate_count = task.candidate_count;
	if (task.passed_candidate_count) result.passed_candidate_count = task.passed_candidate_count;
	return result;
}

function interestingTasks(tasks, baseTasks) {
	const taskDirByOrder = new Map(baseTasks.map((task) => [task.order, task.task_dir]));
	const priority = {
		unfinished_current_best: 0,
		parked_current_best: 1,
		attempted_no_valid_best: 2,
		unstarted: 3,
		parked_after_local_limit: 4,
		final_best: 5,
	};
	return [...tasks]
		.filter((task) => task.status !== "final_best")
		.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.order - b.order)
		.slice(0, 12)
		.map((task) => ({
			order: task.order,
			task_dir: taskDirByOrder.get(task.order) ?? "",
			status: task.status,
			best_p50_ms: task.best_p50_ms,
			current_best_p50_ms: task.current_best_p50_ms,
			local_loop_exhausted: task.local_loop_exhausted,
			local_loop_rounds: task.local_loop_rounds,
			reason: interestingReason(task),
		}));
}

function interestingReason(task) {
	if (task.status === "unfinished_current_best") return "validated unfinished candidate; decide whether to continue or switch";
	if (task.status === "parked_current_best") return "validated candidate exists but the local loop budget was exhausted";
	if (task.status === "attempted_no_valid_best") return "has attempts but no validated candidate";
	if (task.status === "parked_after_local_limit") return "local loop budget exhausted without final promotion";
	return "not started";
}

function compactLocalLoop(value) {
	if (!value || typeof value !== "object") return {};
	return {
		task_dir: value.task_dir ?? "",
		round: value.round ?? null,
		max_rounds: value.max_rounds ?? null,
		status: value.status ?? "",
		continueSameTask: Boolean(value.continueSameTask),
		reason: excerpt(value.reason ?? "", 300),
	};
}

function summarizeTaskContract(text) {
	const value = String(text ?? "");
	const lines = value
		.split(/\r?\n/u)
		.filter((line) => line.trim())
		.slice(0, 40)
		.join("\n");
	return excerpt(lines, 1800);
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read detail_paths for full text]`;
}

function candidateSolutionSnapshot(taskDirRel, row) {
	const artifact = typeof row?.artifact === "string" ? row.artifact : "";
	const solution = typeof row?.solution === "string" && row.solution ? row.solution : "solution.json";
	if (!artifact) return path.join(taskDirRel, solution);
	const artifactDir = path.dirname(artifact.replace(new RegExp(`^${escapeRegExp(taskDirRel)}/`, "u"), ""));
	return path.join(taskDirRel, artifactDir, solution).replaceAll("\\", "/");
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeTaskDir(value) {
	if (typeof value !== "string" || !value.trim()) return "";
	const trimmed = value.trim().replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "");
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(trimmed);
	if (!match) return "";
	const taskDir = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
}
