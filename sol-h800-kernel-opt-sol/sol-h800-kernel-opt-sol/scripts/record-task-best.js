const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const taskDirRel = normalizeTaskDir(taskContext.task_dir ?? validation.task_dir ?? "");

if (!taskDirRel) {
	throw new Error("record-task-best requires /taskContext.task_dir");
}

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });

const candidatesPath = path.join(root, taskDirRel, "candidates.jsonl");
let candidates = await readJsonl(candidatesPath);
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

if (validation.status === "passed" && validation.candidate && !candidates.some((row) => row?.candidate === validation.candidate)) {
	candidates.push(candidateFromValidation(validation));
}

const best = bestPassedCandidate(candidates);
const shouldTrackUnfinished = Boolean(best) && validation.status === "passed" && !rewardFailed && !finalEligible;
const before = candidates.map(stableStringify).join("\n") + (candidates.length ? "\n" : "");

candidates = candidates.map((row) => {
	if (!row || typeof row !== "object") return row;
	const next = { ...row };
	if (shouldTrackUnfinished && row.candidate === best.candidate) {
		next.current_best_unfinished = true;
		next.current_best_source = "sol-h800-kernel-opt-worker-pool";
		next.solution_snapshot = candidateSolutionSnapshot(taskDirRel, next);
	} else if (Object.prototype.hasOwnProperty.call(next, "current_best_unfinished")) {
		delete next.current_best_unfinished;
		delete next.current_best_source;
	}
	return next;
});

const after = candidates.map(stableStringify).join("\n") + (candidates.length ? "\n" : "");
if (after !== before) {
	await fs.writeFile(candidatesPath, after);
}

const result = {
	status: shouldTrackUnfinished ? (after !== before ? "recorded" : "already-current") : "skipped",
	task_dir: taskDirRel,
	candidate: validation.candidate ?? "",
	current_best_candidate: best?.candidate ?? "",
	current_best_p50_ms: metric(best, "median_ms", "p50_ms"),
	current_best_solution_snapshot: best ? candidateSolutionSnapshot(taskDirRel, best) : "",
	validation_status: validation.status ?? "",
	performance_verdict: performanceDecision,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	reward_failed: rewardFailed,
	reason: resultReason(),
};

const outputPath = path.join(outputDir, "task-best-update.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: result.current_best_candidate
		? `${lane ? `slot ${lane}: ` : ""}current unfinished best for ${taskDirRel}: ${result.current_best_candidate} p50=${result.current_best_p50_ms}`
		: `${lane ? `slot ${lane}: ` : ""}no unfinished best recorded for ${taskDirRel}`,
	data: result,
	statePatch: [lanePatch(lane, "taskBestUpdate", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://${taskDirRel}/candidates.jsonl`],
};

function resultReason() {
	if (validation.status !== "passed") return "validation did not pass";
	if (rewardFailed) return "reward-hack review failed";
	if (finalEligible) return "candidate is final-promotion eligible; final leaderboard path will record it";
	if (!best) return "no passed candidate evidence found";
	return "passed candidate is tracked as current best while local optimization continues";
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

function candidateFromValidation(value) {
	return {
		artifact: value.summary_path ?? "",
		candidate: value.candidate ?? `workflow_${Date.now()}`,
		max_ms: value.metrics?.max_ms ?? null,
		mean_ms: value.metrics?.mean_ms ?? null,
		median_ms: value.metrics?.median_ms ?? null,
		model: "rustcat/gpt-5.5:xhigh",
		notes: "H800 true latency; reference speedup ignored",
		p90_ms: value.metrics?.p90_ms ?? null,
		passed: value.metrics?.passed ?? null,
		solution: value.solution ?? "",
		status: "passed",
		total: value.metrics?.total ?? null,
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

function candidateSolutionSnapshot(taskDirRel, row) {
	const artifact = typeof row?.artifact === "string" ? row.artifact : "";
	const solution = typeof row?.solution === "string" && row.solution ? row.solution : "solution.json";
	if (!artifact) return path.join(taskDirRel, solution);
	const artifactDir = path.dirname(artifact);
	return normalizeRel(path.join(taskDirRel, artifactDir, solution));
}

function normalizeTaskDir(value) {
	const text = String(value ?? "").trim().replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "");
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const taskDir = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
}

function normalizeRel(value) {
	return String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
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
