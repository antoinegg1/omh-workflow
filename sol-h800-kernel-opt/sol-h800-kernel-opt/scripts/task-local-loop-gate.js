const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const campaign = state.campaign ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const leaderboardUpdate = localState.leaderboardUpdate ?? state.leaderboardUpdate ?? {};
const taskDirRel = normalizeTaskDir(taskContext.task_dir ?? validation.task_dir ?? "");

if (!taskDirRel) {
	throw new Error("task-local-loop-gate requires /taskContext.task_dir");
}

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });

const maxRounds = parsePositiveInt(process.env.SOL_H800_TASK_LOCAL_MAX_ROUNDS, 3);
const previous = localState.localLoop?.task_dir === taskDirRel ? localState.localLoop : {};
const previousRound = Number.isFinite(Number(previous.round)) ? Number(previous.round) : 0;
const round = previousRound + (validation.status === "passed" ? 1 : 0);

const rewardDecision = reviewDecision(rewardReview);
const rewardFailed = rewardDecision === "fail" || (!rewardDecision && verdictText(rewardReview).includes("fail"));
const performanceDecision = reviewDecision(performanceReview);
const optimizationLimitReached = hasOptimizationLimitReached(performanceReview);
const profileRequired = profileRequested(performanceReview);
const finalEligible =
	validation.status === "passed" &&
	performanceDecision === "promote" &&
	!rewardFailed &&
	!profileRequired &&
	optimizationLimitReached;
const promotedThisRound = Boolean(leaderboardUpdate.promoted_this_round) || finalEligible;
const shouldReviseLocally =
	validation.status === "passed" &&
	!promotedThisRound &&
	!rewardFailed &&
	!["reject", "fail"].includes(performanceDecision);
const continueSameTask = shouldReviseLocally && round < maxRounds;
// Once the round cap is hit, the task MUST stop being reselected — otherwise a task whose
// reward/performance review keeps failing never parks (shouldReviseLocally is false for it), stays
// `unfinished_current_best` (not a done status), and the ordered selector reselects it forever,
// spinning rounds well past maxRounds with no promotion. Park on cap regardless of review verdict.
// `round` only advances on a passed validation, so a task with >=1 passing candidate that exhausts
// its rounds parks with its current best; a task that never passed validation is handled below.
const localLimitReached = !promotedThisRound && round >= maxRounds && validation.status === "passed";

const result = {
	task_dir: taskDirRel,
	candidate: validation.candidate ?? "",
	round,
	max_rounds: maxRounds,
	continueSameTask,
	returnToCoordinator: !continueSameTask,
	status: status(),
	reason: reason(),
	validation_status: validation.status ?? "",
	performance_verdict: performanceDecision,
	reward_verdict: rewardDecision,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	promoted_this_round: promotedThisRound,
	local_limit_reached: localLimitReached,
};

await updateCandidateLoopState(taskDirRel, validation.candidate, {
	local_loop_round: round,
	local_loop_max_rounds: maxRounds,
	local_loop_status: result.status,
	local_loop_exhausted: localLimitReached,
});

const outputPath = path.join(outputDir, "task-local-loop-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: continueSameTask
		? `${lane ? `slot ${lane}: ` : ""}continuing ${taskDirRel} locally (${round}/${maxRounds})`
		: `${lane ? `slot ${lane}: ` : ""}returning ${taskDirRel} to coordinator (${result.status}, ${round}/${maxRounds})`,
	data: result,
	statePatch: [
		lanePatch(lane, "localLoop", result),
		{ op: "set", path: "/campaign/continue", value: true },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://${taskDirRel}/candidates.jsonl`],
};

function status() {
	if (promotedThisRound) return "task_finalized";
	if (localLimitReached) return "parked_after_local_limit";
	if (continueSameTask) return "continue_same_task";
	if (rewardFailed) return "reward_review_failed";
	if (performanceDecision === "reject") return "performance_rejected";
	if (validation.status !== "passed") return "validation_not_passed";
	return "return_to_coordinator";
}

function reason() {
	if (promotedThisRound) return "candidate promoted with optimization-limit approval";
	if (localLimitReached) return `local task loop reached ${maxRounds} round limit`;
	if (continueSameTask) return "performance review did not finalize; send feedback directly to the next planner round";
	if (rewardFailed) return "reward-hack review failed";
	if (performanceDecision === "reject") return "performance review rejected the candidate";
	if (validation.status !== "passed") return "validation did not pass";
	return "no local continuation condition matched";
}

async function updateCandidateLoopState(taskDirRel, candidate, patch) {
	if (!candidate) return;
	const candidatesPath = path.join(root, taskDirRel, "candidates.jsonl");
	const rows = await readJsonl(candidatesPath);
	let changed = false;
	const nextRows = rows.map((row) => {
		if (!row || typeof row !== "object" || row.candidate !== candidate) return row;
		const next = { ...row, ...patch };
		if (!patch.local_loop_exhausted) delete next.local_loop_exhausted;
		if (stableStringify(next) !== stableStringify(row)) changed = true;
		return next;
	});
	if (changed) {
		await fs.writeFile(candidatesPath, nextRows.map(stableStringify).join("\n") + (nextRows.length ? "\n" : ""));
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
					return { raw: line.slice(0, 1000) };
				}
			});
	} catch {
		return [];
	}
}

function normalizeTaskDir(value) {
	const text = String(value ?? "").trim().replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "");
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const taskDir = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
		if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] === "string") return value[field];
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

function stableStringify(value) {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	const sorted = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortKeys(value[key]);
	}
	return sorted;
}
