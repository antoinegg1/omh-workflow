// Per-task outer-round gate: continue the same task for up to five passed
// rounds within one stint, park it, or return it to the coordinator.
// Candidate loop-state rows live in runs/<task>/candidates.jsonl.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, normalizeTaskDir, readJsonlSafe, readJsonSafe, taskArtifactDir } =
	await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const { summarizeWindowTaskEvents } = await import(
	`file://${path.join(resourceRoot, "scripts", "campaign-controls.js")}`
);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const taskBestUpdate = localState.taskBestUpdate ?? state.taskBestUpdate ?? {};
const leaderboardUpdate = localState.leaderboardUpdate ?? state.leaderboardUpdate ?? {};
const taskDirRel = normalizeTaskDir(taskContext.task_dir ?? validation.task_dir ?? "");

if (!taskDirRel) {
	throw new Error("task-local-loop-gate requires /taskContext.task_dir");
}

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });

// A stint still has a local safety cap, but task switching is governed by the
// campaign-window no-improvement streak. Re-acquiring a task does not erase it.
const maxRounds = parsePositiveInt(process.env.SOL_H800_TASK_LOCAL_MAX_ROUNDS, 5);
const maxNoImproveRounds = parsePositiveInt(
	state.campaign?.controls?.max_no_improve_rounds ?? process.env.SOL_H800_MAX_NO_IMPROVE_ROUNDS,
	5,
);
// Stint identity: the selection guard stamps workflow-output/lanes/<lane>/<task>/stint.json
// on every acquisition. A localLoop record from an older stint is ignored, so the
// round counter resets when the coordinator re-enters the task.
const stintMarker = await readJsonSafe(fs, path.join(laneOutputDir(path, root, lane, taskDirRel), "stint.json"), {});
const stintTs = stintMarker.acquired_at ?? "";
const previousRaw = localState.localLoop?.task_dir === taskDirRel ? localState.localLoop : {};
const previous = previousRaw.stint_ts === stintTs ? previousRaw : {};
const previousRound = Number.isFinite(Number(previous.round)) ? Number(previous.round) : 0;
const round = previousRound + (validation.status === "passed" ? 1 : 0);
const eventsPath = path.join(root, "workflow-output", "stint-events.jsonl");
const priorEvents = await readJsonlSafe(fs, eventsPath);
const priorNoImproveStreak =
	summarizeWindowTaskEvents(priorEvents, state.campaign?.controls?.started_at, maxNoImproveRounds).get(taskDirRel)?.no_improve_streak ?? 0;
const improvedThisRound = Boolean(localState.stintCandidate?.improved_in_round || taskBestUpdate.improved_this_round);
const windowNoImproveStreak =
	validation.status !== "passed" ? priorNoImproveStreak : improvedThisRound ? 0 : priorNoImproveStreak + 1;

const rewardDecision = reviewDecision(rewardReview);
const rewardFailed = rewardDecision === "fail" || (!rewardDecision && verdictText(rewardReview).includes("fail"));
const rewardPassed = rewardDecision === "pass";
const performanceDecision = reviewDecision(performanceReview);
const optimizationLimitReached = hasOptimizationLimitReached(performanceReview);
const profileRequired = profileRequested(performanceReview);
// Split semantics: a SUBMISSION (verdict=promote) no longer ends the stint —
// the lane keeps iterating with the remote datapoint in hand. Only the
// reviewer's optimization_limit_reached FINALIZES the task this stint.
const finalEligible =
	validation.status === "passed" &&
	performanceDecision === "promote" &&
	rewardPassed &&
	!profileRequired &&
	optimizationLimitReached;
// A submission whose file Kaggle's evaluator REJECTED (scoring_error) is not
// progress — let the no-improvement streak accumulate so the meeting mechanism
// can fire and debug the submission format collectively.
const submittedThisRound =
	(Boolean(leaderboardUpdate.promoted_this_round) &&
		["uploaded", "scored", "pending_score"].includes(leaderboardUpdate?.promotion?.submission_status ?? "")) ||
	Boolean(localState.directLoop?.uploaded);
// Target achievement ends the stint immediately: the round budget is a MAXIMUM,
// not a quota. A Kaggle-confirmed top-1 on the board means this task is done —
// hand the lane back to the coordinator for the next open task.
const boardRow = (await readJsonSafe(fs, path.join(root, "leaderboard.json"), {}))?.best_by_task?.find?.(
	(row) => row?.task_dir === taskDirRel,
);
const targetReached = Boolean(boardRow?.reached_top1);
const optimizationDeadlineMs = Date.parse(String(localState.stintBudget?.optimization_deadline_at ?? ""));
const stintTimeExpired = Number.isFinite(optimizationDeadlineMs) && Date.now() >= optimizationDeadlineMs;
const promotedThisRound = finalEligible || targetReached; // finalization signal (status/park logic)
const shouldReviseLocally =
	validation.status === "passed" &&
	!finalEligible &&
	!rewardFailed &&
	!["reject", "fail"].includes(performanceDecision);
const stalledAfterNoImprovement =
	validation.status === "passed" && !targetReached && windowNoImproveStreak >= maxNoImproveRounds;
const continueSameTask =
	shouldReviseLocally && round < maxRounds && !targetReached && !stalledAfterNoImprovement && !stintTimeExpired;
// Once the round cap is hit, the task MUST stop being reselected — park on cap
// regardless of review verdict. `round` only advances on a passed validation.
const localLimitReached = !promotedThisRound && round >= maxRounds && validation.status === "passed";

const result = {
	task_dir: taskDirRel,
	candidate: validation.candidate ?? "",
	round,
	max_rounds: maxRounds,
	max_no_improve_rounds: maxNoImproveRounds,
	stint_ts: stintTs,
	continueSameTask,
	returnToCoordinator: !continueSameTask,
	status: status(),
	reason: reason(),
	validation_status: validation.status ?? "",
	performance_verdict: performanceDecision,
	reward_verdict: rewardDecision,
	reward_passed: rewardPassed,
	optimization_limit_reached: optimizationLimitReached,
	profile_required: profileRequired,
	target_reached: targetReached,
	improved_this_round: improvedThisRound,
	window_no_improve_streak: windowNoImproveStreak,
	stalled_after_no_improvement: stalledAfterNoImprovement,
	// meeting-gate reads this to reset the no-improvement streak: a banked
	// submission counts as progress even when the stint continues.
	promoted_this_round: submittedThisRound || finalEligible || targetReached,
	submitted_this_round: submittedThisRound,
	finalized_this_round: finalEligible || targetReached,
	local_limit_reached: localLimitReached,
	stint_time_expired: stintTimeExpired,
};

if (validation.status === "passed") {
	await fs.mkdir(path.dirname(eventsPath), { recursive: true });
	await fs.appendFile(
		eventsPath,
		JSON.stringify({
			event: "validated_round",
			at: new Date().toISOString(),
			window_id: state.campaign?.controls?.window_id ?? "",
			lane: lane || "single",
			task_dir: taskDirRel,
			stint_ts: stintTs,
			round,
			candidate: validation.candidate ?? "",
			candidate_cost: taskBestUpdate.candidate_cost ?? null,
			previous_best_cost: taskBestUpdate.previous_best_cost ?? null,
			improved: improvedThisRound,
			no_improve_streak: windowNoImproveStreak,
		}) + "\n",
	);
}

await updateCandidateLoopState(taskDirRel, validation.candidate, {
	local_loop_round: round,
	local_loop_max_rounds: maxRounds,
	local_loop_status: result.status,
	local_loop_exhausted: localLimitReached || stintTimeExpired,
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
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://runs/${path.basename(taskDirRel)}/candidates.jsonl`],
};

function status() {
	if (promotedThisRound) return "task_finalized";
	if (stintTimeExpired) return "stint_time_exhausted";
	if (stalledAfterNoImprovement) return "stalled_after_no_improvement";
	if (localLimitReached) return "parked_after_local_limit";
	if (continueSameTask) return "continue_same_task";
	if (rewardFailed) return "reward_review_failed";
	if (performanceDecision === "reject") return "performance_rejected";
	if (validation.status !== "passed") return "validation_not_passed";
	return "return_to_coordinator";
}

function reason() {
	if (promotedThisRound) return "candidate promoted with optimization-limit approval";
	if (stintTimeExpired) return "16-hour stint optimization budget expired";
	if (stalledAfterNoImprovement) {
		return `no direction-normalized local improvement for ${windowNoImproveStreak} consecutive validated rounds in this window`;
	}
	if (localLimitReached) return `local task loop reached ${maxRounds} round limit`;
	if (continueSameTask) return "performance review did not finalize; send feedback directly to the next planner round";
	if (rewardFailed) return "reward-hack review failed";
	if (performanceDecision === "reject") return "performance review rejected the candidate";
	if (validation.status !== "passed") return "validation did not pass";
	return "no local continuation condition matched";
}

async function updateCandidateLoopState(taskDirRel, candidate, patch) {
	if (!candidate) return;
	const candidatesPath = path.join(taskArtifactDir(path, root, taskDirRel), "candidates.jsonl");
	const rows = await readJsonlSafe(fs, candidatesPath);
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
