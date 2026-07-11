const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState, withFileLock } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const validation = localState.validation ?? state.validation ?? {};
const taskContext = localState.taskContext ?? state.taskContext ?? {};
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

const command = ["python3", "scripts/leaderboard.py", root, "--write"];
const lockDir = path.join(root, "workflow-output", "locks", "leaderboard-update");
const { stdout, stderr, exitCode, leaderboard } = await withFileLock(
	fs,
	path,
	lockDir,
	{ lane, task_dir: taskContext.task_dir ?? "", kind: "leaderboard-update" },
	async () => {
		if (shouldPromote && taskContext.task_dir) {
			await appendPromotionRecord(root, taskContext.task_dir, validation, rewardReview, performanceReview, optimizationLimitReached);
		}

		const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const leaderboard = await readJson(path.join(root, "leaderboard.json"), {});
		return { stdout, stderr, exitCode, leaderboard };
	},
	{ staleMs: 30 * 60 * 1000, retryMs: 1000 },
);
const result = {
	status: exitCode === 0 ? (shouldPromote ? "updated" : "rebuilt-no-promotion") : "failed",
	exitCode,
	command: command.join(" "),
	promoted_this_round: shouldPromote,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	promotion_blocked_reason: shouldPromote
		? ""
		: promotionBlockedReason(validation, rewardFailed, performanceDecision, optimizationLimitReached, profileRequired),
	stdout_tail: tail(stdout, 6000),
	stderr_tail: tail(stderr, 6000),
	best_count: leaderboard.best_count ?? 0,
	metric: leaderboard.metric ?? "local_h800_p50_latency_ms",
};

const outputDir = laneOutputDir(path, root, lane, taskContext.task_dir ?? validation.task_dir ?? "");
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
	artifacts: [`local://${path.relative(root, outputPath)}`, "local://leaderboard.json", "local://leaderboard.csv"],
};

async function readJson(filePath, fallback) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

function tail(text, maxChars) {
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
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
		stdout_tail: tail(value.stdout_tail ?? "", 1200),
		stderr_tail: tail(value.stderr_tail ?? "", 1600),
		detail_file: path.relative(root, outputPath),
	};
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
	if (leadingDecision) return leadingDecision;
	return "";
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

function promotionBlockedReason(validation, rewardFailed, performanceDecision, optimizationLimitReached, profileRequired) {
	if (validation.status !== "passed") return "validation did not pass";
	if (performanceDecision !== "promote") return "performance review did not return verdict=promote";
	if (rewardFailed) return "reward-hack review failed";
	if (profileRequired) return "performance review requested profile before promotion";
	if (!optimizationLimitReached) return "performance review did not set optimization_limit_reached=true";
	return "unknown";
}

async function appendPromotionRecord(root, taskDirRel, validation, rewardReview, performanceReview, optimizationLimitReached) {
	const taskDir = path.join(root, taskDirRel);
	const row = {
		candidate: validation.candidate ?? `promoted_${Date.now()}`,
		status: "promoted",
		promotion_decision: "promote",
		optimization_limit_reached: optimizationLimitReached,
		reward_hack_review: "pass",
		solution: validation.solution ?? "",
		artifact: validation.summary_path ?? "",
		mean_ms: validation.metrics?.mean_ms ?? null,
		median_ms: validation.metrics?.median_ms ?? null,
		p90_ms: validation.metrics?.p90_ms ?? null,
		max_ms: validation.metrics?.max_ms ?? null,
		min_ms: validation.metrics?.min_ms ?? null,
		passed: validation.metrics?.passed ?? null,
		total: validation.metrics?.total ?? null,
		model: "rustcat/gpt-5.5:xhigh",
		notes: "Promoted by sol-h800-kernel-opt after reward-hack review, performance review, and optimization-limit review",
		reward_review_summary: summaryText(rewardReview),
		performance_review_summary: summaryText(performanceReview),
		optimization_limit_review: summaryText(performanceReview),
		promoted_at: new Date().toISOString(),
	};
	await fs.appendFile(path.join(taskDir, "candidates.jsonl"), JSON.stringify(row, null, 0) + "\n");
}

function summaryText(value) {
	if (!value) return "";
	if (typeof value === "string") return value.slice(0, 1000);
	if (typeof value.summary === "string") return value.summary.slice(0, 1000);
	return JSON.stringify(value).slice(0, 1000);
}
