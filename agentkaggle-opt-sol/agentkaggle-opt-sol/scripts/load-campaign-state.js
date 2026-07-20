// Load the AgentKaggle campaign state: task manifest (tasks.json), campaign
// contract (task.md), leaderboard, per-task candidate evidence, and runtime
// config knobs. Facts only — selection policy lives in task.md and is judged
// by the coordinator agent.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	bestPassedCandidate,
	compactWorkerPool,
	instanceDirFor,
	metricNumber,
	normalizeTaskDir: normalizeTaskDirShared,
	parseTaskBatch,
	readJsonlSafe,
	readJsonSafe,
	readRunTag,
	remotePrimaryBeats,
	submissionsToday,
	taskArtifactDir,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const {
	compactCampaignControls,
	coverageEligibleTaskDirs: selectCoverageEligibleTaskDirs,
	emptyWindowTaskStats,
	preferredCoverageTasks: selectPreferredCoverageTasks,
	readCampaignControls,
	summarizeWindowTaskEvents,
	taskQuarantine,
	taskSubmissionFreeze,
} = await import(
	`file://${path.join(resourceRoot, "scripts", "campaign-controls.js")}`
);
const {
	decorateScoreRow,
	milestoneState,
	readProgressiveTargets,
	snapshotTaskFor,
	summarizeMilestones,
} = await import(`file://${path.join(resourceRoot, "scripts", "progressive-goals.js")}`);
const taskText = await fs.readFile(path.join(root, "task.md"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));
const progressiveTargets = await readProgressiveTargets(fs, path, root);
const controls = await readCampaignControls(fs, path, root);
const compactControls = compactCampaignControls(controls);
const stintEvents = await readJsonlSafe(fs, path.join(root, "workflow-output", "stint-events.jsonl"));
const windowTaskStats = summarizeWindowTaskEvents(stintEvents, controls.started_at, controls.max_no_improve_rounds);
await backfillPendingScores();
await reconcileLeaderboardFromLedgers();
const leaderboard = await readJsonSafe(fs, path.join(root, "leaderboard.json"), {
	best_count: 0,
	best_by_task: [],
});
const workerPool = compactWorkerPool(state);
const previousLocalLoop = state.campaign?.localLoop ?? {};

const allTasks = manifest.tasks ?? [];
const taskRange = parseTaskRange(process.env.SOL_H800_TASK_RANGE ?? process.env.SOL_H800_TASK_ORDERS ?? "");
const taskSkip = parseTaskRange(process.env.SOL_H800_TASK_SKIP ?? "");
// RANGE/SKIP are pure visibility filters; they no longer force the scripted
// ordered selector (the coordinator agent stays in charge unless BATCH/FORCE
// or an explicit ORDERED flag is set).
const orderedSelectorEnabled =
	process.env.SOL_H800_ORDERED_TASKS === "1" ||
	process.env.SOL_H800_ORDERED === "1";
const forcedTaskDir = normalizeTaskDirShared(process.env.SOL_H800_TASK_DIR ?? process.env.SOL_H800_FORCE_TASK ?? "");
const taskBatchDirs = parseTaskBatch(process.env.SOL_H800_TASK_BATCH ?? "");

// Runtime configuration knobs (defaults = full campaign). Edges gate on /config paths.
const config = {
	workerLanes: clampInt(process.env.SOL_H800_WORKER_LANES, 4, 1, 4),
	searchAgents: clampInt(process.env.SOL_H800_SEARCH_AGENTS, 1, 0, 1),
	enableMeeting: parseBoolEnv(process.env.SOL_H800_ENABLE_MEETING, false),
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
	metric: task.metric,
	higher_is_better: Boolean(task.higher_is_better),
	target_top1: task.target_top1 ?? null,
	target_top3: task.target_top3 ?? null,
	target_top5: task.target_top5 ?? null,
	target_snapshot_id: progressiveTargets.snapshot_id ?? task.target_snapshot_id ?? "",
	daily_cap: task.daily_cap ?? null,
	benchmark_ready: task.benchmark_ready !== false,
	local_signal: task.local_signal ?? "strong",
	validation_mode: task.validation_mode ?? "local",
	edit_file: task.edit_file ?? "",
}));
const taskStatus = [];
const taskDetails = [];
for (const task of tasks) {
	const artifactDir = taskArtifactDir(path, root, task.task_dir);
	const candidates = await readJsonlSafe(fs, path.join(artifactDir, "candidates.jsonl"));
	const best = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === task.task_dir);
	const goal = milestoneState(task, best?.kaggle_public, snapshotTaskFor(progressiveTargets, task.task_dir));
	const submissionRows = await readJsonlSafe(fs, path.join(artifactDir, "submission_log.jsonl"));
	const pendingSubmissions = submissionRows.filter((row) => row?.uploaded !== false && row?.kaggle_public == null && !["scoring_error", "upload_failed"].includes(String(row?.status ?? "")));
	const latestCalibration = [...submissionRows].reverse().find((row) => row?.uploaded !== false) ?? null;
	const currentBest = bestPassedCandidate(candidates);
	const previousLoopForTask = previousLocalLoop.task_dir === task.task_dir ? previousLocalLoop : {};
	const localLoopExhausted =
		candidates.some((row) => Boolean(row?.local_loop_exhausted)) ||
		Boolean(currentBest?.local_loop_exhausted) ||
		previousLoopForTask.status === "parked_after_local_limit";
	const quarantine = taskQuarantine(controls, task.task_dir);
	const submissionFreeze = taskSubmissionFreeze(controls, task.task_dir);
	const windowStats = windowTaskStats.get(task.task_dir) ?? emptyWindowTaskStats();
	const baseStatus = taskStatusLabel({ best, currentBest, localLoopExhausted, candidates, goalComplete: goal.goal_complete });
	const status = quarantine ? "quarantined_window" : baseStatus;
	const submittedToday = await submissionsToday(fs, path, root, task.task_dir);
	taskStatus.push(compactTaskStatus({
		order: task.order,
		status,
		best_cost: best?.cost ?? null,
			best_kaggle_public: best?.kaggle_public ?? null,
			...goal,
			current_best_cost: currentBest ? metricNumber(currentBest, "cost") : null,
		current_best_score: currentBest ? metricNumber(currentBest, "score") : null,
		submissions_today: submittedToday,
		daily_cap: task.daily_cap ?? null,
			submissions_remaining_today: task.daily_cap ? Math.max(0, task.daily_cap - submittedToday) : null,
			submission_utilization: task.daily_cap ? submittedToday / task.daily_cap : null,
			pending_submission_count: pendingSubmissions.length,
			hours_to_utc_reset: hoursToUtcReset(),
		local_loop_exhausted: localLoopExhausted,
		local_loop_rounds: Number(currentBest?.local_loop_round ?? previousLoopForTask.round ?? 0) || 0,
		candidate_count: candidates.length,
		passed_candidate_count: candidates.filter((row) => ["passed", "promoted"].includes(String(row?.status ?? "").toLowerCase())).length,
		window_quarantined: Boolean(quarantine),
		window_visit_count: windowStats.visit_count,
		window_no_improve_streak: windowStats.no_improve_streak,
		window_stalled: windowStats.stalled,
		last_stall_at: windowStats.last_stall_at,
		recovery_count: windowStats.recovery_count,
		quarantine_reason: quarantine?.reason ?? quarantine?.fingerprint ?? "",
		submission_frozen: Boolean(submissionFreeze),
	}));
	taskDetails.push({
		order: task.order,
		group: task.group,
		sol_id: task.sol_id,
		task_dir: task.task_dir,
		metric: task.metric,
		higher_is_better: Boolean(task.higher_is_better),
		target_top1: task.target_top1 ?? null,
		target_top3: task.target_top3 ?? null,
		target_top5: task.target_top5 ?? null,
		...goal,
		daily_cap: task.daily_cap ?? null,
		submissions_today: submittedToday,
		submissions_remaining_today: task.daily_cap ? Math.max(0, task.daily_cap - submittedToday) : null,
		submission_utilization: task.daily_cap ? submittedToday / task.daily_cap : null,
		pending_submission_count: pendingSubmissions.length,
		hours_to_utc_reset: hoursToUtcReset(),
		latest_calibration: compactCalibration(latestCalibration),
		benchmark_ready: task.benchmark_ready !== false,
		local_signal: task.local_signal ?? "strong",
		validation_mode: task.validation_mode ?? "local",
		status,
		candidate_count: candidates.length,
		best_kaggle_public: best?.kaggle_public ?? null,
		best_cost: best?.cost ?? null,
		best_candidate: best?.candidate ?? "",
		current_best_cost: currentBest ? metricNumber(currentBest, "cost") : null,
		current_best_score: currentBest ? metricNumber(currentBest, "score") : null,
		current_best_candidate: currentBest?.candidate ?? "",
		local_loop_exhausted: localLoopExhausted,
		local_loop_rounds: Number(currentBest?.local_loop_round ?? previousLoopForTask.round ?? 0) || 0,
		local_loop_max_rounds: Number(currentBest?.local_loop_max_rounds ?? previousLoopForTask.max_rounds ?? 0) || 0,
		window_quarantined: Boolean(quarantine),
		window_visit_count: windowStats.visit_count,
		window_no_improve_streak: windowStats.no_improve_streak,
		window_stalled: windowStats.stalled,
		last_stall_at: windowStats.last_stall_at,
		recovery_count: windowStats.recovery_count,
		quarantine_reason: quarantine?.reason ?? quarantine?.fingerprint ?? "",
		submission_frozen: Boolean(submissionFreeze),
		submission_freeze_reason: submissionFreeze?.reason ?? submissionFreeze?.status ?? "",
	});
}

const milestoneProgress = summarizeMilestones(tasks, leaderboard.best_by_task ?? [], progressiveTargets);
const progress = {
	taskCount: tasks.length,
	totalManifestTaskCount: allTasks.length,
	...milestoneProgress,
	disabled_task_count: allTasks.filter((task) => task.enabled === false).length,
	thresholdSnapshotId: progressiveTargets.snapshot_id ?? "",
	taskRange: compactTaskRange(taskRange),
	taskSkip: compactTaskRange(taskSkip),
	bestCount: taskStatus.filter((task) => task.status === "final_best").length,
	doneCount: taskStatus.filter((task) => taskDone(task.status)).length,
	openCount: taskStatus.filter((task) => !taskDone(task.status)).length,
	unoptimizedCount: taskStatus.filter((task) => task.status !== "final_best").length,
	unfinishedBestCount: taskStatus.filter((task) => ["unfinished_current_best", "parked_current_best"].includes(task.status)).length,
	localLoopExhaustedCount: taskStatus.filter((task) => task.local_loop_exhausted).length,
	quarantinedCount: taskStatus.filter((task) => task.window_quarantined).length,
	submissionFrozenCount: taskStatus.filter((task) => task.submission_frozen).length,
	activeWorkerCount: workerPool.active_tasks.length,
};
const detailPaths = {
	task_contract: "task.md",
	manifest: "tasks.json",
	progressive_targets: "progressive_targets.json",
	leaderboard: "leaderboard.json",
	campaign_state: "workflow-output/campaign-state.json",
	campaign_controls: "workflow-output/campaign-controls.json",
	wiki_index: "wiki/index.md",
	per_task_pattern: {
		task_contract: "<task-dir>/TASK.md (via the run instance symlink)",
		task_config: "<task-dir>/evaluation/task_config.json",
		candidates: "runs/<task-dir>/candidates.jsonl",
		scoreboard: "runs/<task-dir>/<run-id>/scoreboard.jsonl",
		submission_log: "runs/<task-dir>/submission_log.jsonl",
		docs: "runs/<task-dir>/docs/",
		meetings: "runs/<task-dir>/meetings/",
		wiki_note: "wiki/tasks/<task-dir>.md",
	},
	note: "The workflow prompt receives only bounded selector state. Read campaign_state or per-task paths for full evidence. task_contract holds the campaign's own rules and selection guidance — read it before judging.",
};
const taskDirByOrder = new Map(baseTasks.map((task) => [task.order, task.task_dir]));
const coverageEligibleTasks = new Set(
	selectCoverageEligibleTaskDirs(taskStatus, taskDirByOrder, workerPool.active_task_dirs),
);
const globalUnstartedTasks = taskStatus
	.filter((task) => task.status === "unstarted")
	.map((task) => taskDirByOrder.get(task.order) ?? "")
	.filter((taskDir) => taskDir && coverageEligibleTasks.has(taskDir));
const allWindowUnvisitedTasks = baseTasks
	.map((task) => task.task_dir)
	.filter((taskDir) => (windowTaskStats.get(taskDir)?.visit_count ?? 0) === 0);
const windowUnvisitedTasks = baseTasks
	.map((task) => task.task_dir)
	.filter((taskDir) =>
		coverageEligibleTasks.has(taskDir) && (windowTaskStats.get(taskDir)?.visit_count ?? 0) === 0
	);
const stalledTasks = baseTasks
	.map((task) => task.task_dir)
	.filter((taskDir) => windowTaskStats.get(taskDir)?.stalled);
const preferredCoverageTasks = selectPreferredCoverageTasks(globalUnstartedTasks, windowUnvisitedTasks);
const coverage = {
	mode: compactControls.coverage_mode ?? "hybrid",
	selection_order: "global unstarted first, then tasks not visited in the current window",
	global_unstarted_tasks: globalUnstartedTasks,
	window_unvisited_tasks: windowUnvisitedTasks,
	preferred_tasks: preferredCoverageTasks,
	stalled_tasks: stalledTasks,
	visited_task_count: baseTasks.length - allWindowUnvisitedTasks.length,
	eligible_task_count: coverageEligibleTasks.size,
	total_task_count: baseTasks.length,
};
const taskUpdates = {
	progress,
	latest_local_loop: compactLocalLoop(previousLocalLoop),
	worker_pool: workerPool,
	task_batch: taskBatch,
	task_range: compactTaskRange(taskRange),
	task_skip: compactTaskRange(taskSkip),
	window_controls: compactControls,
	coverage,
	status_policy:
		"Current status only. Do not select active, disabled, final_best, or quarantined tasks. Choose flexibly by expected time/probability to the next one-point milestone. Submission budget, pending state, hours to UTC reset, route calibrations, and the option to assign build_local_eval are judgment inputs, not fixed quotas.",
	task_status: taskStatus,
	interesting_tasks: interestingTasks(taskStatus, baseTasks, coverage),
};
const taskContractSummary = summarizeTaskContract(taskText);

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", "campaign-state.json"),
	JSON.stringify(
		{ progress, tasks: baseTasks, updates: taskUpdates, detail_paths: detailPaths, task_details: taskDetails, worker_pool: workerPool, controls: compactControls },
		null,
		2,
	) + "\n",
);

return {
		summary: `loaded ${tasks.length}/${allTasks.length} enabled tasks; ${progress.milestone_points}/${progress.milestone_max_points} milestone points, ${progress.top1_count} top-1 complete`,
	data: { progress },
	statePatch: [
		{ op: "set", path: "/campaign/taskContract", value: taskContractSummary },
		{ op: "set", path: "/campaign/tasks", value: baseTasks },
		{ op: "set", path: "/campaign/taskUpdates", value: taskUpdates },
		{ op: "set", path: "/campaign/detailPaths", value: detailPaths },
		{ op: "set", path: "/campaign/progress", value: progress },
		{ op: "set", path: "/campaign/forcedTaskDir", value: forcedTaskDir },
		{ op: "set", path: "/campaign/taskBatch", value: taskBatch },
		{ op: "set", path: "/campaign/controls", value: compactControls },
		{ op: "set", path: "/config", value: config },
		{ op: "set", path: "/leaderboard", value: compactLeaderboard(leaderboard) },
	],
	artifacts: ["local://workflow-output/campaign-state.json"],
};

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
	// Parked is NOT terminal: the coordinator may re-assign a parked task and the
	// re-entry refreshes its stint budget. Only a target-reaching promotion ends a
	// task; the campaign otherwise runs until its time budget pauses it.
	return status === "final_best";
}

function taskIncluded(task, includeRange, skipRange) {
	if (task.enabled === false) return false;
	const order = Number(task.order);
	if (!Number.isFinite(order)) return false;
	if (includeRange.enabled && !includeRange.orders.has(order)) return false;
	if (skipRange.enabled && skipRange.orders.has(order)) return false;
	return true;
}

function compactLeaderboard(value) {
	return {
		generated_at: value.generated_at ?? "",
		metric: value.metric ?? "kaggle_public(remote-primary)",
		best_count: value.best_count ?? 0,
		threshold_snapshot_id: progressiveTargets.snapshot_id ?? "",
		recent_best_by_task: (value.best_by_task ?? []).slice(-8).map((row) => ({
			order: row.order,
			task_dir: row.task_dir,
			candidate: row.candidate,
			kaggle_public: row.kaggle_public ?? null,
			kaggle_private: row.kaggle_private ?? null,
			score: row.score ?? null,
			cost: row.cost ?? null,
			metric_name: row.metric_name ?? "",
				submission_status: row.submission_status ?? "",
				milestone_points: row.milestone_points ?? 0,
				active_goal: row.active_goal ?? "top5",
			})),
		leaderboard_file: "leaderboard.json",
		note: "kaggle_public is the primary value (remote-primary); local score/cost are iteration signals. State keeps only recent rows — read leaderboard_file for full best_by_task.",
	};
}

function taskStatusLabel({ best, currentBest, localLoopExhausted, candidates, goalComplete }) {
	// Remote-primary: a promoted task is only FINAL when its Kaggle score reached
	// the target. A scored-below-target promotion re-opens the task (the reviewer
	// promoted on local evidence; the remote score is new information), unless the
	// local loop budget is already exhausted.
	if (best && goalComplete) return "final_best";
	if (best && localLoopExhausted) return "parked_current_best";
	if (best) return "unfinished_current_best";
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
	if (task.best_cost !== null) result.best_cost = task.best_cost;
	if (task.best_kaggle_public !== null) result.best_kaggle_public = task.best_kaggle_public;
	result.reached_top5 = Boolean(task.reached_top5);
	result.reached_top3 = Boolean(task.reached_top3);
	result.reached_top1 = Boolean(task.reached_top1);
	result.highest_milestone = task.highest_milestone ?? null;
	result.milestone_points = task.milestone_points ?? 0;
	result.active_goal = task.active_goal ?? null;
	result.active_target = task.active_target ?? null;
	result.active_gap = task.active_gap ?? null;
	result.goal_complete = Boolean(task.goal_complete);
	if (task.current_best_cost !== null) result.current_best_cost = task.current_best_cost;
	if (task.current_best_score !== null) result.current_best_score = task.current_best_score;
	if (task.submissions_today) result.submissions_today = task.submissions_today;
	if (task.daily_cap !== null) result.daily_cap = task.daily_cap;
	result.submissions_remaining_today = task.submissions_remaining_today ?? null;
	result.submission_utilization = task.submission_utilization ?? null;
	result.pending_submission_count = task.pending_submission_count ?? 0;
	result.hours_to_utc_reset = task.hours_to_utc_reset ?? null;
	if (task.local_loop_exhausted) result.local_loop_exhausted = true;
	if (task.local_loop_rounds) result.local_loop_rounds = task.local_loop_rounds;
	if (task.candidate_count) result.candidate_count = task.candidate_count;
	if (task.passed_candidate_count) result.passed_candidate_count = task.passed_candidate_count;
	if (task.window_quarantined) result.window_quarantined = true;
	if (task.window_visit_count) result.window_visit_count = task.window_visit_count;
	if (task.window_no_improve_streak) result.window_no_improve_streak = task.window_no_improve_streak;
	if (task.window_stalled) result.window_stalled = true;
	if (task.last_stall_at) result.last_stall_at = task.last_stall_at;
	if (task.recovery_count) result.recovery_count = task.recovery_count;
	if (task.quarantine_reason) result.quarantine_reason = task.quarantine_reason;
	if (task.submission_frozen) result.submission_frozen = true;
	return result;
}

function interestingTasks(tasks, baseTasks, coverage) {
	const taskDirByOrder = new Map(baseTasks.map((task) => [task.order, task.task_dir]));
	const preferred = new Set(coverage?.preferred_tasks ?? []);
	const priority = {
		unfinished_current_best: 0,
		parked_current_best: 1,
		attempted_no_valid_best: 2,
		unstarted: 3,
		parked_after_local_limit: 4,
		final_best: 5,
	};
	return [...tasks]
		.filter((task) => !["final_best", "quarantined_window"].includes(task.status))
		.sort((a, b) => {
			const aPreferred = preferred.has(taskDirByOrder.get(a.order)) ? 0 : 1;
			const bPreferred = preferred.has(taskDirByOrder.get(b.order)) ? 0 : 1;
			return aPreferred - bPreferred || (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.order - b.order;
		})
		.slice(0, 13)
		.map((task) => ({
			order: task.order,
			task_dir: taskDirByOrder.get(task.order) ?? "",
			status: task.status,
				best_kaggle_public: task.best_kaggle_public ?? null,
				milestone_points: task.milestone_points ?? 0,
				active_goal: task.active_goal ?? null,
				active_target: task.active_target ?? null,
				active_gap: task.active_gap ?? null,
				current_best_cost: task.current_best_cost ?? null,
			submissions_today: task.submissions_today ?? 0,
				daily_cap: task.daily_cap ?? null,
				submissions_remaining_today: task.submissions_remaining_today ?? null,
				pending_submission_count: task.pending_submission_count ?? 0,
				hours_to_utc_reset: task.hours_to_utc_reset ?? null,
			local_loop_exhausted: task.local_loop_exhausted,
			local_loop_rounds: task.local_loop_rounds,
			window_visit_count: task.window_visit_count ?? 0,
			window_no_improve_streak: task.window_no_improve_streak ?? 0,
			window_stalled: Boolean(task.window_stalled),
			reason: interestingReason(task),
		}));
}

function interestingReason(task) {
	if (task.active_goal) return `next milestone ${task.active_goal}; coordinator judges expected point/time and submission timing`;
	if (task.status === "unfinished_current_best") return "validated unfinished candidate; decide whether to continue or switch";
	if (task.status === "parked_current_best") return "validated candidate exists but the local loop budget was exhausted";
	if (task.status === "attempted_no_valid_best") return "has attempts but no validated candidate";
	if (task.status === "parked_after_local_limit") return "local loop budget exhausted without final promotion";
	return "not started";
}

function hoursToUtcReset(now = new Date()) {
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	return Math.max(0, (next - now.getTime()) / 3600000);
}

function compactCalibration(row) {
	if (!row) return null;
	return {
		candidate: row.candidate ?? "",
		kaggle_public: row.kaggle_public ?? null,
		status: row.status ?? row.submission_status ?? "",
		submitted_at: row.submitted_at ?? row.time ?? "",
		solution_hash: row.solution_hash ?? "",
		submission_hash: row.submission_hash ?? "",
	};
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
		.slice(0, 60)
		.join("\n");
	return excerpt(lines, 2600);
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read detail_paths.task_contract for full text]`;
}

// Reconcile the leaderboard against each task's submission ledger: whenever the
// board row has no remote score but the ledger holds Kaggle-scored rows (from a
// later candidate, a kernel-route submission, or a poll that landed after the
// board row was written), compare every scored ledger row with the board and
// preserve the direction-best Kaggle public result. Route regressions remain in
// the ledger without overwriting the best.
async function reconcileLeaderboardFromLedgers() {
	try {
		const lbPath = path.join(root, "leaderboard.json");
		const lb = await readJsonSafe(fs, lbPath, null);
		if (!lb || !Array.isArray(lb.best_by_task)) return;
		let changed = false;
		for (const task of (manifest.tasks ?? []).filter((item) => item.enabled !== false)) {
			const entry = lb.best_by_task.find((item) => item?.task_dir === task.task_dir);
			const rows = await readJsonlSafe(fs, path.join(taskArtifactDir(path, root, task.task_dir), "submission_log.jsonl"));
			const scored = rows.filter((row) => row?.kaggle_public != null && row?.uploaded !== false);
			if (scored.length === 0) continue;
			const hib = Boolean(task.higher_is_better);
			scored.sort((a, b) => (hib ? b.kaggle_public - a.kaggle_public : a.kaggle_public - b.kaggle_public));
			const best = scored[0];
			const candidate = decorateScoreRow({
				...(entry ?? {}),
				order: task.order,
				task_dir: task.task_dir,
				candidate: best.candidate ?? entry?.candidate ?? "",
				metric_name: task.metric,
				higher_is_better: hib,
				kaggle_public: best.kaggle_public,
				kaggle_private: best.kaggle_private ?? entry?.kaggle_private ?? null,
				submission_status: "scored",
				promoted_at: best.submitted_at ?? entry?.promoted_at ?? "",
			}, task, snapshotTaskFor(progressiveTargets, task.task_dir), progressiveTargets.snapshot_id);
			if (entry && !remotePrimaryBeats(candidate, entry, hib)) continue;
			lb.best_by_task = (lb.best_by_task ?? []).filter((item) => item?.task_dir !== task.task_dir).concat([candidate]);
			changed = true;
		}
		if (changed) {
			lb.best_by_task.sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99));
			lb.best_count = lb.best_by_task.length;
			lb.generated_at = new Date().toISOString();
			await fs.writeFile(lbPath, JSON.stringify(lb, null, 2) + "\n");
			await fs.writeFile(path.join(root, "leaderboard.csv"), leaderboardCsv(lb));
		}
	} catch {
		// Reconciliation must never block campaign state loading.
	}
}

// Fill in Kaggle scores for submissions that uploaded but whose score was not
// visible inside the promotion poll window (slow-scoring competitions land as
// pending_score and nothing else re-polls them). Kaggle access is read-only
// (submit.py --score-only). Throttled campaign-wide to one sweep per 10 min.
async function backfillPendingScores() {
	try {
		const markerPath = path.join(root, "workflow-output", "score-backfill.marker");
		const marker = await fs.stat(markerPath).catch(() => null);
		if (marker && Date.now() - marker.mtimeMs < 600000) return;
		const pending = [];
		for (const task of manifest.tasks ?? []) {
			const logPath = path.join(taskArtifactDir(path, root, task.task_dir), "submission_log.jsonl");
			const rows = await readJsonlSafe(fs, logPath);
			if (rows.some((row) => row?.uploaded !== false && row?.kaggle_public == null && row?.message)) {
				const stat = await fs.stat(logPath).catch(() => null);
				pending.push({ task, logPath, rows, size: stat?.size ?? 0 });
			}
		}
		if (pending.length === 0) return;
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, new Date().toISOString());
		const runTag = await readRunTag(fs, path, root);
		if (!runTag) return;
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		for (const { task, logPath, rows, size } of pending) {
			let stdout = "";
			try {
				({ stdout } = await exec("python3", ["submit.py", "--score-only"], {
					cwd: instanceDirFor(path, runTag, task.task_dir),
					timeout: 120000,
				}));
			} catch {
				continue;
			}
			let changed = false;
			for (const row of rows) {
				if (row?.uploaded === false || row?.kaggle_public != null || !row?.message) continue;
				if (row?.status === "scoring_error") continue;
				const line = stdout.split(/\r?\n/u).find((text) => text.includes(row.message));
				if (!line) continue;
				const pub = /public=([-0-9.eE]+)/u.exec(line);
				if (pub) {
					const priv = /private=([-0-9.eE]+)/u.exec(line);
					row.kaggle_public = Number(pub[1]);
					if (priv) row.kaggle_private = Number(priv[1]);
					row.status = "scored";
					changed = true;
					await backfillLeaderboardScore(task.task_dir, row);
				} else if (/status=\S*error/iu.test(line)) {
					// Kaggle's evaluator rejected the file — terminal, not pending.
					row.status = "scoring_error";
					changed = true;
					await backfillLeaderboardStatus(task.task_dir, row, "scoring_error");
				}
			}
			if (changed) {
				// Skip the rewrite if someone appended since our read (promotion race);
				// the next sweep picks it up.
				const now = await fs.stat(logPath).catch(() => null);
				if (now && now.size === size) {
					await fs.writeFile(logPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
				}
			}
		}
	} catch {
		// Best-effort: score backfill must never block campaign state loading.
	}
}

async function backfillLeaderboardScore(taskDirRel, row) {
	const lbPath = path.join(root, "leaderboard.json");
	const lb = await readJsonSafe(fs, lbPath, null);
	if (!lb || !Array.isArray(lb.best_by_task)) return;
	const task = (manifest.tasks ?? []).find((item) => item.task_dir === taskDirRel);
	if (!task || task.enabled === false) return;
	const entry = lb.best_by_task.find((item) => item?.task_dir === taskDirRel);
	const candidate = decorateScoreRow({
		...(entry ?? {}),
		order: task.order,
		task_dir: taskDirRel,
		candidate: row.candidate ?? entry?.candidate ?? "",
		metric_name: task.metric,
		higher_is_better: Boolean(task.higher_is_better),
		kaggle_public: row.kaggle_public,
		kaggle_private: row.kaggle_private ?? entry?.kaggle_private ?? null,
		submission_status: "scored",
		promoted_at: row.submitted_at ?? entry?.promoted_at ?? "",
	}, task, snapshotTaskFor(progressiveTargets, taskDirRel), progressiveTargets.snapshot_id);
	if (entry && !remotePrimaryBeats(candidate, entry, Boolean(task.higher_is_better))) return;
	lb.best_by_task = (lb.best_by_task ?? []).filter((item) => item?.task_dir !== taskDirRel).concat([candidate]);
	lb.best_by_task.sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99));
	lb.best_count = lb.best_by_task.length;
	lb.generated_at = new Date().toISOString();
	await fs.writeFile(lbPath, JSON.stringify(lb, null, 2) + "\n");
	await fs.writeFile(path.join(root, "leaderboard.csv"), leaderboardCsv(lb));
}

function leaderboardCsv(leaderboard) {
	const fields = ["order", "task_dir", "candidate", "metric", "kaggle_public", "kaggle_private", "score", "submission_status", "reached_top1", "target_top1", "promoted_at", "reached_top5", "target_top5", "reached_top3", "target_top3", "highest_milestone", "milestone_points", "active_goal", "active_target", "goal_complete", "threshold_snapshot_id"];
	const rows = (leaderboard.best_by_task ?? []).map((row) => fields.map((field) => csvValue(field === "metric" ? row.metric_name : row[field])).join(","));
	return [fields.join(","), ...rows].join("\n") + "\n";
}

function csvValue(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function backfillLeaderboardStatus(taskDirRel, row, status) {
	const lbPath = path.join(root, "leaderboard.json");
	const lb = await readJsonSafe(fs, lbPath, null);
	if (!lb || !Array.isArray(lb.best_by_task)) return;
	const entry = lb.best_by_task.find((item) => item?.task_dir === taskDirRel);
	if (!entry || entry.kaggle_public != null) return;
	if (entry.candidate && row.candidate && entry.candidate !== row.candidate) return;
	entry.submission_status = status;
	lb.generated_at = new Date().toISOString();
	await fs.writeFile(lbPath, JSON.stringify(lb, null, 2) + "\n");
}
