const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, metricNumber, readJsonlSafe, taskArtifactDir } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskContext = local.taskContext ?? {};
const validation = local.validation ?? {};
const reward = unwrap(local.rewardHackReview ?? {});
const taskDir = taskContext.task_dir ?? validation.task_dir ?? "";
if (!taskDir) throw new Error("record-stint-candidate requires taskContext.task_dir");

const stintTs = local.stintBudget?.stint_ts ?? local.selectionGuard?.stint_started_at ?? "";
const roundId = local.stintBudget?.round_id ?? "";
const rewardVerdict = normalizeVerdict(reward.verdict ?? reward.decision ?? reward.summary ?? "");
const rewardPassed = validation.status === "passed" && rewardVerdict === "pass";
const implementation = unwrap(local.implementation ?? {});
const artifactDir = taskArtifactDir(path, root, taskDir);
await fs.mkdir(artifactDir, { recursive: true });
const candidatesPath = path.join(artifactDir, "candidates.jsonl");
let rows = await readJsonlSafe(fs, candidatesPath);
const candidate = validation.candidate ?? "";
const currentCost = finite(validation.metrics?.cost);
const priorStintCosts = rows
	.filter((row) => row?.stint_ts === stintTs && row?.reward_passed === true && row?.candidate !== candidate)
	.map((row) => finite(row?.cost))
	.filter(Number.isFinite);
const previousStintBestCost = priorStintCosts.length ? Math.min(...priorStintCosts) : null;
const improvedInStint = rewardPassed && Number.isFinite(currentCost) && (previousStintBestCost === null || currentCost < previousStintBestCost);
const previousRoundAggregate = local.stintCandidate?.round_id === roundId ? local.stintCandidate : {};
const improvedInRound = Boolean(previousRoundAggregate.improved_in_round || improvedInStint);
const existingIndex = rows.findIndex((row) => row?.candidate === candidate);
const row = {
	...(existingIndex >= 0 ? rows[existingIndex] : {}),
	artifact: validation.summary_path ?? "",
	candidate,
	score: validation.metrics?.score ?? null,
	cost: validation.metrics?.cost ?? null,
	metric_name: validation.metrics?.metric ?? "",
	higher_is_better: validation.metrics?.higher_is_better ?? null,
	mode: validation.metrics?.mode ?? "",
	status: validation.status === "passed" ? "passed" : validation.status ?? "failed",
	solution: validation.solution ?? "",
	solution_hash: validation.solution_hash ?? "",
	submission_hash: validation.submission_hash ?? "",
	stint_ts: stintTs,
	round_id: roundId,
	round_index: local.stintBudget?.round_index ?? null,
	reward_hack_review: rewardVerdict,
	reward_passed: rewardPassed,
	skip_submit: readBool(implementation, "skip_submit") === true,
	use_last_submission: readBool(implementation, "use_last_submission") === true,
	assignment_mode: taskContext.coordinator?.assignment_mode ?? "optimize",
	local_eval: normalizeLocalEval(implementation.local_eval),
	recorded_at: new Date().toISOString(),
};
if (existingIndex >= 0) rows[existingIndex] = row;
else if (candidate) rows.push(row);
await fs.writeFile(candidatesPath, rows.map(stableStringify).join("\n") + (rows.length ? "\n" : ""));

const result = {
	task_dir: taskDir,
	candidate,
	stint_ts: stintTs,
	round_id: roundId,
	round_index: local.stintBudget?.round_index ?? null,
	reward_passed: rewardPassed,
	reward_verdict: rewardVerdict,
	solution_hash: validation.solution_hash ?? "",
	submission_hash: validation.submission_hash ?? "",
	candidate_cost: Number.isFinite(currentCost) ? currentCost : null,
	previous_stint_best_cost: previousStintBestCost,
	improved_in_stint: improvedInStint,
	improved_in_round: improvedInRound,
	skip_submit: row.skip_submit,
	use_last_submission: row.use_last_submission,
	assignment_mode: row.assignment_mode,
	local_eval: row.local_eval,
};
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "record-stint-candidate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}recorded ${candidate || "candidate"}; stint improvement=${improvedInStint}`,
	data: result,
	statePatch: [lanePatch(lane, "stintCandidate", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://runs/${path.basename(taskDir)}/candidates.jsonl`],
};

function unwrap(value) {
	return value?.data && typeof value.data === "object" ? { ...value, ...value.data } : value;
}

function normalizeVerdict(value) {
	const text = String(value ?? "").toLowerCase();
	if (/\bfail\b/u.test(text)) return "fail";
	if (/\bpass\b|\bready\b|\bapprove\b/u.test(text)) return "pass";
	return text.slice(0, 40);
}

function finite(value) {
	if (value === null || value === undefined || value === "") return Number.NaN;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function readBool(value, field) {
	if (!value || typeof value !== "object") return undefined;
	if (typeof value[field] === "boolean") return value[field];
	if (value.data && typeof value.data === "object") return readBool(value.data, field);
	return undefined;
}

function normalizeLocalEval(value) {
	if (!value || typeof value !== "object") return null;
	const command = String(value.command ?? "").trim();
	if (!command) return null;
	return {
		command,
		version: String(value.version ?? "").slice(0, 80),
		confidence: String(value.confidence ?? "experimental").slice(0, 80),
		notes: String(value.notes ?? "").slice(0, 500),
	};
}

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
