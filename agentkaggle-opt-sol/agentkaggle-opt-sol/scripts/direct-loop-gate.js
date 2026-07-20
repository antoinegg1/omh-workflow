const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, submissionsToday, taskMetaFor } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskDir = local.taskContext?.task_dir ?? "";
const reserve = positiveInt(process.env.SOL_H800_DIRECT_SUBMISSION_RESERVE, 10);
const taskMeta = await taskMetaFor(fs, path, root, taskDir);
const cap = Number(taskMeta?.daily_cap ?? 0) || null;
const used = await submissionsToday(fs, path, root, taskDir);
const remaining = cap === null ? null : Math.max(0, cap - used);
const status = local.leaderboardUpdate?.promotion?.submission_status ?? "";
const uploaded =
	Boolean(local.leaderboardUpdate?.promoted_this_round) && ["uploaded", "scored", "pending_score"].includes(status);
const deadlineMs = Date.parse(String(local.stintBudget?.optimization_deadline_at ?? ""));
const timeRemaining = Number.isFinite(deadlineMs) && Date.now() < deadlineMs;
const continueInner = uploaded && remaining !== null && remaining > reserve && timeRemaining;
const result = {
	task_dir: taskDir,
	stint_ts: local.stintBudget?.stint_ts ?? "",
	round_id: local.stintBudget?.round_id ?? "",
	continue_inner: continueInner,
	remaining_today: remaining,
	reserve,
	submission_status: status,
	uploaded,
	time_remaining: timeRemaining,
	reason: continueInner ? "direct calibration landed and budget remains" : "close round and restore its best candidate",
};
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "direct-loop-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${continueInner ? "continue direct candidate loop" : "close direct candidate loop"}`,
	data: result,
	statePatch: [lanePatch(lane, "directLoop", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
