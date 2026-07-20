const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, readJsonlSafe, submissionsToday, taskArtifactDir, taskMetaFor } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskDir = local.taskContext?.task_dir ?? "";
if (!taskDir) throw new Error("direct-submission-gate requires taskContext.task_dir");

const directThreshold = positiveInt(process.env.SOL_H800_DIRECT_SUBMISSION_THRESHOLD, 5);
const taskMeta = await taskMetaFor(fs, path, root, taskDir);
const cap = Number(taskMeta?.daily_cap ?? 0) || null;
const used = await submissionsToday(fs, path, root, taskDir);
const remaining = cap === null ? null : Math.max(0, cap - used);
const logs = await readJsonlSafe(fs, path.join(taskArtifactDir(path, root, taskDir), "submission_log.jsonl"));
const solutionHash = local.stintCandidate?.solution_hash ?? local.validation?.solution_hash ?? "";
const submissionHash = local.stintCandidate?.submission_hash ?? local.validation?.submission_hash ?? "";
const duplicateSolutionHash = Boolean(solutionHash) && logs.some((row) => row?.solution_hash === solutionHash && row?.uploaded !== false);
const duplicateSubmissionHash = Boolean(submissionHash) && logs.some((row) => row?.submission_hash === submissionHash && row?.uploaded !== false);
const pendingCount = logs.filter((row) => row?.uploaded !== false && row?.kaggle_public == null && !["scoring_error", "upload_failed"].includes(String(row?.status ?? ""))).length;
const implementation = unwrap(local.implementation ?? {});
const skipSubmit = implementation.skip_submit === true;
const closing = local.roundBest?.closing === true;
const authorized =
	!closing &&
	remaining !== null &&
	remaining > directThreshold &&
	pendingCount === 0 &&
	local.stintBudget?.optimization_expired !== true &&
	local.validation?.status === "passed" &&
	local.stintCandidate?.reward_passed === true &&
	!skipSubmit &&
	Boolean(solutionHash) &&
	Boolean(submissionHash) &&
	!duplicateSolutionHash &&
	!duplicateSubmissionHash;
const result = {
	task_dir: taskDir,
	candidate: local.validation?.candidate ?? "",
	stint_ts: local.stintBudget?.stint_ts ?? "",
	round_id: local.stintBudget?.round_id ?? "",
	authorized,
	decision: authorized ? "submit_direct" : "normal_review",
	remaining_today: remaining,
	daily_cap: cap,
	direct_threshold: directThreshold,
	pending_submission_count: pendingCount,
	solution_hash: solutionHash,
	submission_hash: submissionHash,
	duplicate_solution_hash: duplicateSolutionHash,
	duplicate_submission_hash: duplicateSubmissionHash,
	skip_submit: skipSubmit,
	closing_round: closing,
	reason: reason(),
};
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "direct-submission-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${result.decision}: ${result.reason}`,
	data: result,
	statePatch: [lanePatch(lane, "directSubmission", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function reason() {
	if (closing) return "round is closing on its restored best candidate";
	if (remaining === null) return "daily submission cap is unknown";
	if (remaining <= directThreshold) return `remaining daily budget ${remaining} requires the full lane flow (threshold ${directThreshold})`;
	if (pendingCount > 0) return `task already has ${pendingCount} pending submission`;
	if (local.stintBudget?.optimization_expired === true) return "stint optimization budget expired";
	if (local.validation?.status !== "passed") return "validation did not pass";
	if (local.stintCandidate?.reward_passed !== true) return "reward review did not pass";
	if (skipSubmit) return "PlanImplement explicitly skipped this candidate's automatic submission";
	if (!solutionHash) return "validated candidate has no solution hash";
	if (!submissionHash) return "validated candidate has no submission payload hash";
	if (duplicateSolutionHash) return "solution hash was already uploaded";
	if (duplicateSubmissionHash) return "submission payload hash was already uploaded";
	return "validated new candidate is eligible for automatic direct calibration";
}

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unwrap(value) {
	return value?.data && typeof value.data === "object" ? { ...value, ...value.data } : value;
}
