export const CAMPAIGN_CONTROLS_RELATIVE_PATH = "workflow-output/campaign-controls.json";

export async function readCampaignControls(fs, path, root, nowMs = Date.now()) {
	let raw = {};
	try {
		raw = JSON.parse(await fs.readFile(path.join(root, CAMPAIGN_CONTROLS_RELATIVE_PATH), "utf8"));
	} catch {
		/* optional control file */
	}
	const expiresMs = Date.parse(String(raw?.expires_at ?? ""));
	const active = Boolean(raw?.window_id) && Number.isFinite(expiresMs) && nowMs < expiresMs;
	return {
		version: Number(raw?.version ?? 2) || 2,
		window_id: String(raw?.window_id ?? ""),
		started_at: String(raw?.started_at ?? ""),
		expires_at: String(raw?.expires_at ?? ""),
		phase: String(raw?.phase ?? ""),
		active,
		priority_tasks: stringList(raw?.priority_tasks),
		coverage_mode: String(raw?.coverage_mode ?? "hybrid"),
		max_no_improve_rounds: positiveInt(raw?.max_no_improve_rounds, 3),
		max_recovery_attempts: positiveInt(raw?.max_recovery_attempts, 1),
		task_quarantine: recordMap(raw?.task_quarantine),
		submission_freeze: recordMap(raw?.submission_freeze),
	};
}

export function taskQuarantine(controls, taskDir) {
	if (!controls?.active || !taskDir) return null;
	return controls.task_quarantine?.[taskDir] ?? null;
}

export function taskSubmissionFreeze(controls, taskDir) {
	if (!controls?.active || !taskDir) return null;
	return controls.submission_freeze?.[taskDir] ?? null;
}

export function compactCampaignControls(controls) {
	return {
		window_id: controls?.window_id ?? "",
		started_at: controls?.started_at ?? "",
		expires_at: controls?.expires_at ?? "",
		phase: controls?.phase ?? "",
		active: Boolean(controls?.active),
		priority_tasks: stringList(controls?.priority_tasks),
		coverage_mode: controls?.coverage_mode ?? "hybrid",
		max_no_improve_rounds: positiveInt(controls?.max_no_improve_rounds, 3),
		max_recovery_attempts: positiveInt(controls?.max_recovery_attempts, 1),
		quarantined_tasks: Object.keys(recordMap(controls?.task_quarantine)).sort(),
		submission_frozen_tasks: Object.keys(recordMap(controls?.submission_freeze)).sort(),
		control_file: CAMPAIGN_CONTROLS_RELATIVE_PATH,
	};
}

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeFailureFingerprint(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/req_[a-z0-9]+/gu, "req")
		.replace(/activation-\d+/gu, "activation")
		.replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gu, "timestamp")
		.replace(/\b\d+\b/gu, "n")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 400);
}

export function directionNormalizedImprovement(previousCost, candidateCost, validationPassed = true) {
	const previous = finiteMetric(previousCost);
	const candidate = finiteMetric(candidateCost);
	return validationPassed && Number.isFinite(candidate) && (!Number.isFinite(previous) || candidate < previous);
}

export function summarizeWindowTaskEvents(events, startedAt = "") {
	const startedMs = Date.parse(String(startedAt ?? ""));
	const stats = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		if (Number.isFinite(startedMs) && Date.parse(String(event?.at ?? "")) < startedMs) continue;
		const taskDir = String(event?.task_dir ?? "");
		if (!taskDir) continue;
		const current = stats.get(taskDir) ?? emptyWindowTaskStats();
		if (event.event === "acquired") current.visit_count += 1;
		if (event.event === "validated_round") {
			current.validated_rounds += 1;
			current.no_improve_streak = event.improved ? 0 : current.no_improve_streak + 1;
			if (event.improved) current.stalled = false;
			if (current.no_improve_streak >= 3) {
				current.stalled = true;
				current.last_stall_at = String(event.at ?? current.last_stall_at);
			}
		}
		if (event.event === "recovery_started") current.recovery_count += 1;
		if (event.event === "released" && event.stalled) {
			current.stalled = true;
			current.last_stall_at = String(event.at ?? current.last_stall_at);
		}
		stats.set(taskDir, current);
	}
	return stats;
}

export function emptyWindowTaskStats() {
	return {
		visit_count: 0,
		validated_rounds: 0,
		no_improve_streak: 0,
		stalled: false,
		last_stall_at: "",
		recovery_count: 0,
	};
}

export function preferredCoverageTasks(globalUnstartedTasks, windowUnvisitedTasks) {
	return globalUnstartedTasks.length > 0 ? [...globalUnstartedTasks] : [...windowUnvisitedTasks];
}

export function coverageEligibleTaskDirs(taskStatus, taskDirByOrder, activeTaskDirs = []) {
	const active = new Set(activeTaskDirs);
	return taskStatus
		.filter((task) => task.status !== "final_best" && !task.window_quarantined)
		.map((task) => taskDirByOrder.get(task.order) ?? "")
		.filter((taskDir) => taskDir && !active.has(taskDir));
}

function finiteMetric(value) {
	if (value === null || value === undefined || value === "") return Number.NaN;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stringList(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(item => String(item ?? "").trim()).filter(Boolean))];
}

function recordMap(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
