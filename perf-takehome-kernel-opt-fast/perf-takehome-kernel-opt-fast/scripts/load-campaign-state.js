const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};

// Single fixed task for the perf take-home. task_dir is a bookkeeping directory that holds the
// agent's plans (docs/) and candidate/leaderboard evidence; the scored file is perf_takehome.py at
// the repo root.
const taskDirRel = "tasks/kernel_opt";
const task = { order: 1, group: "perf-takehome", sol_id: "kernel", task_dir: taskDirRel };
const baseTasks = [task];

const leaderboard = await readJson(path.join(root, "leaderboard.json"), { best_count: 0, best_by_task: [] });
const candidates = await readJsonl(path.join(root, taskDirRel, "candidates.jsonl"));
const currentBest = bestPassedCandidate(candidates);
const finalBest = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === taskDirRel);
const previousLocalLoop = state.localLoop ?? {};
const localLoopExhausted =
	Boolean(currentBest?.local_loop_exhausted) || previousLocalLoop.status === "parked_after_local_limit";
const status = taskStatusLabel({ finalBest, currentBest, localLoopExhausted, candidates });

// Force the single task so selectForcedTaskWorkload runs (never the coordinator's multi-task picker).
const forcedTaskDir = taskDirRel;

const taskStatus = [compactTaskStatus({
	order: 1,
	status,
	best_cycles: finalBest ? metric(finalBest, "median_ms", "p50_ms", "cycles") : null,
	current_best_cycles: currentBest ? metric(currentBest, "median_ms", "p50_ms", "cycles") : null,
	local_loop_exhausted: localLoopExhausted,
	local_loop_rounds: Number(currentBest?.local_loop_round ?? previousLocalLoop.round ?? 0) || 0,
	candidate_count: candidates.length,
	passed_candidate_count: candidates.filter(isPassedCandidate).length,
})];

const doneStatuses = new Set(["final_best", "parked_current_best", "parked_after_local_limit"]);
const doneCount = doneStatuses.has(status) ? 1 : 0;
const progress = {
	taskCount: 1,
	totalManifestTaskCount: 1,
	bestCount: finalBest ? 1 : 0,
	doneCount,
	openCount: 1 - doneCount,
	unoptimizedCount: status !== "final_best" ? 1 : 0,
	unfinishedBestCount: ["unfinished_current_best", "parked_current_best"].includes(status) ? 1 : 0,
	localLoopExhaustedCount: localLoopExhausted ? 1 : 0,
};

const detailPaths = {
	scored_file: "perf_takehome.py",
	reference: "problem.py",
	frozen_simulator: "tests/frozen_problem.py",
	submission_tests: "tests/submission_tests.py",
	leaderboard: "leaderboard.json",
	campaign_state: "workflow-output/campaign-state.json",
	per_task_pattern: {
		docs: `${taskDirRel}/docs/`,
		candidates: `${taskDirRel}/candidates.jsonl`,
		benchmark: `${taskDirRel}/benchmark.csv`,
	},
	note: "The scored kernel is KernelBuilder.build_kernel in perf_takehome.py. problem.py/tests/ are read-only reference; do not edit them.",
};
const taskUpdates = {
	progress,
	latest_local_loop: compactLocalLoop(previousLocalLoop),
	status_policy:
		"Single perf-takehome task. Metric is total simulator cycles (lower is better); stored in the median_ms field for leaderboard compatibility.",
	task_status: taskStatus,
	interesting_tasks:
		status !== "final_best"
			? [{ order: 1, task_dir: taskDirRel, status, current_best_cycles: taskStatus[0].current_best_cycles ?? null, reason: interestingReason(status) }]
			: [],
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", "campaign-state.json"),
	JSON.stringify({ progress, tasks: baseTasks, updates: taskUpdates, detail_paths: detailPaths }, null, 2) + "\n",
);

return {
	summary: `loaded perf-takehome task (${status}); ${progress.doneCount}/1 done`,
	data: { progress },
	statePatch: [
		{ op: "set", path: "/campaign/taskContract", value: detailPaths.note },
		{ op: "set", path: "/campaign/tasks", value: baseTasks },
		{ op: "set", path: "/campaign/taskUpdates", value: taskUpdates },
		{ op: "set", path: "/campaign/detailPaths", value: detailPaths },
		{ op: "set", path: "/campaign/progress", value: progress },
		{ op: "set", path: "/campaign/forcedTaskDir", value: forcedTaskDir },
		{ op: "set", path: "/leaderboard", value: compactLeaderboard(leaderboard, taskDirRel) },
	],
	artifacts: ["local://workflow-output/campaign-state.json"],
};

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

function compactLeaderboard(value, taskDirRel) {
	const rows = (value.best_by_task ?? []).filter((row) => row.task_dir === taskDirRel);
	return {
		generated_at: value.generated_at ?? "",
		metric: value.metric ?? "simulator_cycles",
		best_count: rows.length,
		best_by_task: rows.map((row) => ({
			order: row.order,
			task_dir: row.task_dir,
			candidate: row.candidate,
			cycles: metric(row, "median_ms", "p50_ms", "cycles"),
			solution: row.solution,
			summary_path: row.summary_path,
		})),
	};
}

function bestPassedCandidate(rows) {
	return rows
		.filter((row) => isPassedCandidate(row) && Number.isFinite(metric(row, "median_ms", "p50_ms", "cycles")))
		.sort((a, b) => metric(a, "median_ms", "p50_ms", "cycles") - metric(b, "median_ms", "p50_ms", "cycles"))[0];
}

function isPassedCandidate(row) {
	if (!row || typeof row !== "object") return false;
	if (!["passed", "promoted"].includes(String(row.status ?? "").toLowerCase())) return false;
	const passed = Number(row.passed);
	const total = Number(row.total);
	if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) return passed === total;
	return Number.isFinite(metric(row, "median_ms", "p50_ms", "cycles"));
}

function metric(row, ...keys) {
	for (const key of keys) {
		const value = Number(row?.[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function taskStatusLabel({ finalBest, currentBest, localLoopExhausted, candidates }) {
	if (finalBest) return "final_best";
	if (currentBest && localLoopExhausted) return "parked_current_best";
	if (currentBest) return "unfinished_current_best";
	if (localLoopExhausted) return "parked_after_local_limit";
	if (candidates.length > 0) return "attempted_no_valid_best";
	return "unstarted";
}

function compactTaskStatus(task) {
	const result = { order: task.order, status: task.status };
	if (task.best_cycles !== null) result.best_cycles = task.best_cycles;
	if (task.current_best_cycles !== null) result.current_best_cycles = task.current_best_cycles;
	if (task.local_loop_exhausted) result.local_loop_exhausted = true;
	if (task.local_loop_rounds) result.local_loop_rounds = task.local_loop_rounds;
	if (task.candidate_count) result.candidate_count = task.candidate_count;
	if (task.passed_candidate_count) result.passed_candidate_count = task.passed_candidate_count;
	return result;
}

function interestingReason(status) {
	if (status === "unfinished_current_best") return "validated unfinished candidate; decide whether to continue or finalize";
	if (status === "parked_current_best") return "validated candidate exists but the local loop budget was exhausted";
	if (status === "attempted_no_valid_best") return "has attempts but no validated candidate";
	if (status === "parked_after_local_limit") return "local loop budget exhausted without final promotion";
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
		reason: String(value.reason ?? "").slice(0, 300),
	};
}
