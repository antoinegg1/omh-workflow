// Track the per-task "current unfinished best" candidate by lowest cost
// (direction-normalized local score). Candidate rows live in the campaign
// artifact dir: runs/<task>/candidates.jsonl.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	bestPassedCandidate,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	metricNumber,
	normalizeTaskDir,
	readJsonlSafe,
	taskArtifactDir,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const { directionNormalizedImprovement } = await import(
	`file://${path.join(resourceRoot, "scripts", "campaign-controls.js")}`
);
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

const artifactDir = taskArtifactDir(path, root, taskDirRel);
await fs.mkdir(artifactDir, { recursive: true });
const candidatesPath = path.join(artifactDir, "candidates.jsonl");
let candidates = await readJsonlSafe(fs, candidatesPath);
const eligibleCandidates = () => candidates.filter((row) => row?.reward_passed !== false);
const previousBest = bestPassedCandidate(
	eligibleCandidates().filter((row) => row?.candidate !== validation.candidate),
);
const rewardDecision = reviewDecision(rewardReview);
const rewardFailed = rewardDecision === "fail" || (!rewardDecision && verdictText(rewardReview).includes("fail"));
const rewardPassed = rewardDecision === "pass";
const performanceDecision = reviewDecision(performanceReview);
const optimizationLimitReached = hasOptimizationLimitReached(performanceReview);
const profileRequired = profileRequested(performanceReview);
const finalEligible =
	validation.status === "passed" &&
	performanceDecision === "promote" &&
	rewardPassed &&
	!profileRequired &&
	optimizationLimitReached;

if (validation.status === "passed" && validation.candidate && !candidates.some((row) => row?.candidate === validation.candidate)) {
	candidates.push(candidateFromValidation(validation));
}

const best = bestPassedCandidate(eligibleCandidates());
const currentCandidate = candidates.find((row) => row?.candidate === validation.candidate) ?? null;
const previousBestCost = previousBest?.cost == null ? null : metricNumber(previousBest, "cost");
const candidateCost = currentCandidate?.cost == null ? null : metricNumber(currentCandidate, "cost");
const improvedThisRound = directionNormalizedImprovement(
	previousBestCost,
	candidateCost,
	validation.status === "passed" && rewardPassed,
);
const shouldTrackUnfinished = Boolean(best) && validation.status === "passed" && rewardPassed && !finalEligible;
const before = candidates.map(stableStringify).join("\n") + (candidates.length ? "\n" : "");

candidates = candidates.map((row) => {
	if (!row || typeof row !== "object") return row;
	const next = { ...row };
	if (shouldTrackUnfinished && row.candidate === best.candidate) {
		next.current_best_unfinished = true;
		next.current_best_source = "agentkaggle-opt-sol-worker-pool";
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
	current_best_cost: metricNumber(best, "cost"),
	current_best_score: metricNumber(best, "score"),
	current_best_snapshot: best?.artifact ?? "",
	previous_best_cost: Number.isFinite(previousBestCost) ? previousBestCost : null,
	candidate_cost: Number.isFinite(candidateCost) ? candidateCost : null,
	improved_this_round: improvedThisRound,
	improvement_delta:
		Number.isFinite(previousBestCost) && Number.isFinite(candidateCost) ? previousBestCost - candidateCost : null,
	validation_status: validation.status ?? "",
	performance_verdict: performanceDecision,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	reward_failed: rewardFailed,
	reward_passed: rewardPassed,
	reason: resultReason(),
};

const outputPath = path.join(outputDir, "task-best-update.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: result.current_best_candidate
		? `${lane ? `slot ${lane}: ` : ""}current unfinished best for ${taskDirRel}: ${result.current_best_candidate} score=${result.current_best_score}`
		: `${lane ? `slot ${lane}: ` : ""}no unfinished best recorded for ${taskDirRel}`,
	data: result,
	statePatch: [lanePatch(lane, "taskBestUpdate", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://runs/${path.basename(taskDirRel)}/candidates.jsonl`],
};

function resultReason() {
	if (validation.status !== "passed") return "validation did not pass";
	if (!rewardPassed) return "reward-hack review did not pass";
	if (finalEligible) return "candidate is final-promotion eligible; the leaderboard/submission path will record it";
	if (!best) return "no passed candidate evidence found";
	return "passed candidate is tracked as current best while local optimization continues";
}

function candidateFromValidation(value) {
	return {
		artifact: value.summary_path ?? "",
		candidate: value.candidate ?? `workflow_${Date.now()}`,
		score: value.metrics?.score ?? null,
		cost: value.metrics?.cost ?? null,
		metric_name: value.metrics?.metric ?? "",
		higher_is_better: value.metrics?.higher_is_better ?? null,
		mode: value.metrics?.mode ?? "",
		notes: "local evaluation score (iteration signal); Kaggle score is the final measure",
		passed: value.metrics?.passed ?? null,
		total: value.metrics?.total ?? null,
		solution: value.solution ?? "",
		status: "passed",
		reward_passed: rewardPassed,
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
