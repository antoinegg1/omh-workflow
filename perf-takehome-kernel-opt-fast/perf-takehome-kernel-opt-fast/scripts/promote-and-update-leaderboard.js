const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState, withFileLock } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const validation = localState.validation ?? state.validation ?? {};
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir || validation.task_dir || "tasks/kernel_opt";

const performanceDecision = reviewDecision(performanceReview);
const rewardDecision = reviewDecision(rewardReview);
const rewardFailed = rewardDecision === "fail" || (!rewardDecision && verdictText(rewardReview).includes("fail"));
const optimizationLimitReached = hasOptimizationLimitReached(performanceReview);
const profileRequired = profileRequested(performanceReview);
const shouldPromote =
	validation.status === "passed" &&
	performanceDecision === "promote" &&
	!rewardFailed &&
	!profileRequired &&
	optimizationLimitReached;

const lockDir = path.join(root, "workflow-output", "locks", "leaderboard-update");
const { leaderboard } = await withFileLock(
	fs,
	path,
	lockDir,
	{ lane, task_dir: taskDirRel, kind: "leaderboard-update" },
	async () => {
		if (shouldPromote) {
			await appendPromotionRecord(root, taskDirRel, validation, rewardReview, performanceReview, optimizationLimitReached);
		}
		const leaderboard = await rebuildLeaderboard(root, taskDirRel);
		return { leaderboard };
	},
	{ staleMs: 30 * 60 * 1000, retryMs: 1000 },
);

const result = {
	status: shouldPromote ? "updated" : "rebuilt-no-promotion",
	exitCode: 0,
	command: "internal leaderboard rebuild (simulator cycles)",
	promoted_this_round: shouldPromote,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	promotion_blocked_reason: shouldPromote
		? ""
		: promotionBlockedReason(validation, rewardFailed, performanceDecision, optimizationLimitReached, profileRequired),
	best_count: leaderboard.best_count ?? 0,
	metric: leaderboard.metric ?? "simulator_cycles",
};

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "leaderboard-update.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
const compactResult = compactLeaderboardUpdate(result, outputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}leaderboard ${result.status}; best_count=${result.best_count}`,
	data: compactResult,
	statePatch: [
		lanePatch(lane, "leaderboardUpdate", compactResult),
		{ op: "set", path: "/leaderboard", value: compactLeaderboard(leaderboard) },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`, "local://leaderboard.json"],
};

// Rebuild leaderboard.json from candidates.jsonl: the best promoted+optimization-limit candidate
// (lowest cycles) becomes the task's final best.
async function rebuildLeaderboard(root, taskDirRel) {
	const candidates = await readJsonl(path.join(root, taskDirRel, "candidates.jsonl"));
	const eligible = candidates.filter(
		(row) =>
			(String(row.status ?? "").toLowerCase() === "promoted" || row.promotion_decision === "promote") &&
			asBool(row.optimization_limit_reached) &&
			Number.isFinite(metric(row, "cycles", "median_ms", "p50_ms")),
	);
	eligible.sort((a, b) => metric(a, "cycles", "median_ms", "p50_ms") - metric(b, "cycles", "median_ms", "p50_ms"));
	const best = eligible[0];
	const best_by_task = best
		? [{
			order: 1,
			task_dir: taskDirRel,
			candidate: best.candidate ?? "",
			cycles: metric(best, "cycles", "median_ms", "p50_ms"),
			p50_ms: metric(best, "cycles", "median_ms", "p50_ms"),
			solution: best.solution ?? "perf_takehome.py",
			summary_path: best.artifact ?? "",
		}]
		: [];
	const leaderboard = {
		generated_at: new Date().toISOString(),
		metric: "simulator_cycles",
		promotion_note: "best entries require status=promoted (or promotion_decision=promote) and optimization_limit_reached=true; ranked by fewest cycles.",
		task_count: 1,
		best_count: best_by_task.length,
		best_by_task,
	};
	await fs.writeFile(path.join(root, "leaderboard.json"), JSON.stringify(leaderboard, null, 2) + "\n");
	return leaderboard;
}

async function appendPromotionRecord(root, taskDirRel, validation, rewardReview, performanceReview, optimizationLimitReached) {
	const cycles = metric(validation.metrics ?? {}, "cycles", "median_ms");
	const row = {
		candidate: validation.candidate ?? `promoted_${Date.now()}`,
		status: "promoted",
		promotion_decision: "promote",
		optimization_limit_reached: optimizationLimitReached,
		reward_hack_review: "pass",
		solution: validation.solution ?? "perf_takehome.py",
		artifact: validation.summary_path ?? "",
		cycles,
		median_ms: cycles,
		speedup: validation.metrics?.speedup ?? null,
		thresholds_passed: validation.metrics?.thresholds_passed ?? null,
		passed: validation.metrics?.passed ?? null,
		total: validation.metrics?.total ?? null,
		model: "rustcat/gpt-5.5:xhigh",
		notes: "Promoted by perf-takehome-kernel-opt after reward-hack review, performance review, and optimization-limit review",
		reward_review_summary: summaryText(rewardReview),
		performance_review_summary: summaryText(performanceReview),
		promoted_at: new Date().toISOString(),
	};
	await fs.mkdir(path.join(root, taskDirRel), { recursive: true });
	await fs.appendFile(path.join(root, taskDirRel, "candidates.jsonl"), JSON.stringify(row) + "\n");
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

function metric(row, ...keys) {
	for (const key of keys) {
		const value = Number(row?.[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function asBool(value) {
	if (value === true) return true;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
	return false;
}

function compactLeaderboard(value) {
	return {
		generated_at: value.generated_at ?? "",
		metric: value.metric ?? "simulator_cycles",
		best_count: value.best_count ?? 0,
		recent_best_by_task: (value.best_by_task ?? []).slice(-8).map((row) => ({
			order: row.order,
			task_dir: row.task_dir,
			candidate: row.candidate,
			cycles: row.cycles ?? row.p50_ms,
			summary_path: row.summary_path,
		})),
		leaderboard_file: "leaderboard.json",
	};
}

function compactLeaderboardUpdate(value, outputPath) {
	return {
		status: value.status,
		exitCode: value.exitCode,
		command: value.command,
		promoted_this_round: Boolean(value.promoted_this_round),
		optimization_limit_reached: Boolean(value.optimization_limit_reached),
		profile_required: Boolean(value.profile_required),
		promotion_blocked_reason: value.promotion_blocked_reason,
		best_count: value.best_count,
		metric: value.metric,
		detail_file: path.relative(root, outputPath),
	};
}

function promotionBlockedReason(validation, rewardFailed, performanceDecision, optimizationLimitReached, profileRequired) {
	if (validation.status !== "passed") return "validation did not pass";
	if (performanceDecision !== "promote") return "performance review did not return verdict=promote";
	if (rewardFailed) return "reward-hack review failed";
	if (profileRequired) return "performance review requested profile before promotion";
	if (!optimizationLimitReached) return "performance review did not set optimization_limit_reached=true";
	return "unknown";
}

function summaryText(value) {
	if (!value) return "";
	if (typeof value === "string") return value.slice(0, 1000);
	if (typeof value.summary === "string") return value.summary.slice(0, 1000);
	return JSON.stringify(value).slice(0, 1000);
}

function verdictText(value) {
	if (!value) return "";
	if (typeof value === "string") return value.toLowerCase();
	return JSON.stringify(value).toLowerCase();
}

function reviewDecision(value) {
	const exact = normalizeDecision(readStringField(value, "verdict"));
	if (exact) return exact;
	const decision = normalizeDecision(readStringField(value, "decision"));
	if (decision) return decision;
	const text = verdictText(value);
	if (/\bverdict\b\s*[:=]\s*"?promote"?\b/u.test(text)) return "promote";
	if (/\bverdict\b\s*[:=]\s*"?revise"?\b/u.test(text)) return "revise";
	if (/\bverdict\b\s*[:=]\s*"?reject"?\b/u.test(text)) return "reject";
	if (/\bverdict\b\s*[:=]\s*"?pass"?\b/u.test(text)) return "pass";
	if (/\bverdict\b\s*[:=]\s*"?fail"?\b/u.test(text)) return "fail";
	const leadingDecision =
		leadingTextDecision(readStringField(value, "summary")) ||
		leadingTextDecision(readStringField(value, "explanation")) ||
		leadingTextDecision(readStringField(value, "reason")) ||
		(typeof value === "string" ? leadingTextDecision(value) : "");
	return leadingDecision || "";
}

function normalizeDecision(value) {
	if (!value) return "";
	const normalized = value.trim().toLowerCase();
	return ["promote", "revise", "reject", "pass", "fail"].includes(normalized) ? normalized : "";
}

function leadingTextDecision(value) {
	if (!value) return "";
	const match = value.trim().toLowerCase().match(/^(promote|revise|reject|pass|fail)\b/u);
	return match ? match[1] : "";
}

function hasOptimizationLimitReached(value) {
	if (readBoolField(value, "optimization_limit_reached") === true) return true;
	const text = verdictText(value);
	return /\boptimization_limit_reached\b\s*[:=]\s*true\b/u.test(text);
}

function profileRequested(value) {
	if (readBoolField(value, "profile_required") === true) return true;
	const text = verdictText(value);
	return /\bprofile_required\b\s*[:=]\s*true\b/u.test(text);
}

function readStringField(value, field) {
	if (!value) return "";
	if (typeof value === "string") {
		const parsed = parseJsonLike(value);
		return parsed ? readStringField(parsed, field) : "";
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = readStringField(item, field);
			if (found) return found;
		}
		return "";
	}
	if (typeof value === "object") {
		if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] === "string") {
			return value[field].trim().toLowerCase();
		}
		for (const nested of Object.values(value)) {
			const found = readStringField(nested, field);
			if (found) return found;
		}
	}
	return "";
}

function readBoolField(value, field) {
	if (!value) return undefined;
	if (typeof value === "string") {
		const parsed = parseJsonLike(value);
		return parsed ? readBoolField(parsed, field) : undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = readBoolField(item, field);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value === "object") {
		if (Object.prototype.hasOwnProperty.call(value, field)) return normalizeBool(value[field]);
		for (const nested of Object.values(value)) {
			const found = readBoolField(nested, field);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function normalizeBool(value) {
	if (value === true || value === false) return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "yes") return true;
		if (normalized === "false" || normalized === "no") return false;
	}
	return undefined;
}

function parseJsonLike(value) {
	const text = value.trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}
