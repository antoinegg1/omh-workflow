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
const directThreshold = positiveInt(process.env.SOL_H800_DIRECT_SUBMISSION_THRESHOLD, 5);
const taskMeta = await taskMetaFor(fs, path, root, taskDir);
const cap = Number(taskMeta?.daily_cap ?? 0) || null;
const used = await submissionsToday(fs, path, root, taskDir);
const remaining = cap === null ? null : Math.max(0, cap - used);
const status = local.leaderboardUpdate?.promotion?.submission_status ?? "";
const scored = Boolean(local.leaderboardUpdate?.promoted_this_round) && status === "scored";
const reachedMilestone = Boolean(local.leaderboardUpdate?.promotion?.reached_new_milestone);
const deadlineMs = Date.parse(String(local.stintBudget?.optimization_deadline_at ?? ""));
const timeRemaining = Number.isFinite(deadlineMs) && Date.now() < deadlineMs;
const continueInner = scored && !reachedMilestone && remaining !== null && remaining > directThreshold && timeRemaining;
const result = {
	task_dir: taskDir,
	stint_ts: local.stintBudget?.stint_ts ?? "",
	round_id: local.stintBudget?.round_id ?? "",
	continue_inner: continueInner,
	remaining_today: remaining,
	direct_threshold: directThreshold,
	submission_status: status,
	scored,
	reached_new_milestone: reachedMilestone,
	time_remaining: timeRemaining,
	reason: continueInner ? "direct calibration scored and more than five submissions remain" : reachedMilestone ? "milestone reached; release the lane after round close" : "close direct loop and continue the full lane flow",
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
