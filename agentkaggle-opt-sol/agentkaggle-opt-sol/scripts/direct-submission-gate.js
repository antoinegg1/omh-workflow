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

const reserve = positiveInt(process.env.SOL_H800_DIRECT_SUBMISSION_RESERVE, 10);
const taskMeta = await taskMetaFor(fs, path, root, taskDir);
const cap = Number(taskMeta?.daily_cap ?? 0) || null;
const used = await submissionsToday(fs, path, root, taskDir);
const remaining = cap === null ? null : Math.max(0, cap - used);
const logs = await readJsonlSafe(fs, path.join(taskArtifactDir(path, root, taskDir), "submission_log.jsonl"));
const hash = local.stintCandidate?.solution_hash ?? local.validation?.solution_hash ?? "";
const duplicateHash = Boolean(hash) && logs.some((row) => row?.solution_hash === hash && row?.uploaded !== false);
const closing = local.roundBest?.closing === true;
const authorized =
	!closing &&
	remaining !== null &&
	remaining > reserve &&
	local.stintBudget?.optimization_expired !== true &&
	local.validation?.status === "passed" &&
	local.stintCandidate?.reward_passed === true &&
	local.stintCandidate?.improved_in_stint === true &&
	local.stintCandidate?.request_submit === true &&
	Boolean(hash) &&
	!duplicateHash;
const result = {
	task_dir: taskDir,
	candidate: local.validation?.candidate ?? "",
	stint_ts: local.stintBudget?.stint_ts ?? "",
	round_id: local.stintBudget?.round_id ?? "",
	authorized,
	decision: authorized ? "submit_direct" : "normal_review",
	remaining_today: remaining,
	daily_cap: cap,
	reserve,
	solution_hash: hash,
	duplicate_hash: duplicateHash,
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
	if (remaining <= reserve) return `remaining daily budget ${remaining} is at reserve ${reserve}`;
	if (local.stintBudget?.optimization_expired === true) return "stint optimization budget expired";
	if (local.validation?.status !== "passed") return "validation did not pass";
	if (local.stintCandidate?.reward_passed !== true) return "reward review did not pass";
	if (local.stintCandidate?.improved_in_stint !== true) return "candidate did not improve the stint local best";
	if (local.stintCandidate?.request_submit !== true) return "PlanImplement did not request a calibration submission";
	if (!hash) return "validated candidate has no solution hash";
	if (duplicateHash) return "solution hash was already uploaded";
	return "validated local improvement requested for direct calibration";
}

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
