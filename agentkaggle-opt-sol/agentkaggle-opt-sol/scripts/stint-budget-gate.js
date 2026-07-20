const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, readJsonSafe } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskDir = local.taskContext?.task_dir ?? local.selectionGuard?.task_dir ?? "";
if (!taskDir) throw new Error("stint-budget-gate requires a selected task");

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const marker = await readJsonSafe(fs, path.join(outputDir, "stint.json"), {});
const startedAt = marker.acquired_at || local.selectionGuard?.stint_started_at || new Date().toISOString();
const budgetSeconds = positiveInt(process.env.SOL_H800_STINT_BUDGET_SECONDS, 16 * 60 * 60);
const graceSeconds = positiveInt(process.env.SOL_H800_STINT_FINALIZATION_GRACE_SECONDS, 2 * 60 * 60);
const optimizationDeadlineMs = Date.parse(startedAt) + budgetSeconds * 1000;
const finalizationDeadlineMs = optimizationDeadlineMs + graceSeconds * 1000;
const nowMs = Date.now();
const previousPassedRounds = Number(local.localLoop?.stint_ts === startedAt ? local.localLoop?.round ?? 0 : 0) || 0;
const continueInner = local.directLoop?.continue_inner === true && local.directLoop?.stint_ts === startedAt;
const previousRoundId = local.stintBudget?.stint_ts === startedAt ? local.stintBudget?.round_id ?? "" : "";
const roundIndex = continueInner
	? Number(local.stintBudget?.round_index ?? previousPassedRounds + 1) || previousPassedRounds + 1
	: previousPassedRounds + 1;
const roundId = continueInner && previousRoundId ? previousRoundId : `${startedAt.replace(/[^0-9]/gu, "").slice(0, 14)}-r${roundIndex}`;
const result = {
	task_dir: taskDir,
	lane,
	stint_ts: startedAt,
	started_at: startedAt,
	optimization_deadline_at: new Date(optimizationDeadlineMs).toISOString(),
	finalization_deadline_at: new Date(finalizationDeadlineMs).toISOString(),
	budget_seconds: budgetSeconds,
	finalization_grace_seconds: graceSeconds,
	remaining_optimization_seconds: Math.max(0, Math.floor((optimizationDeadlineMs - nowMs) / 1000)),
	remaining_finalization_seconds: Math.max(0, Math.floor((finalizationDeadlineMs - nowMs) / 1000)),
	optimization_expired: nowMs >= optimizationDeadlineMs,
	finalization_expired: nowMs >= finalizationDeadlineMs,
	can_optimize: nowMs < optimizationDeadlineMs,
	round_index: roundIndex,
	round_id: roundId,
	continue_inner: continueInner,
};
const outputPath = path.join(outputDir, "stint-budget-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${result.can_optimize ? "optimization budget active" : "optimization budget expired"} for ${taskDir}`,
	data: result,
	statePatch: [
		lanePatch(lane, "stintBudget", result),
		...(continueInner ? [] : [lanePatch(lane, "roundBest", { round_id: roundId, closing: false })]),
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
