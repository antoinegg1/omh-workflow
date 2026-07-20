// Reset candidate-local state and establish the campaign-root write-scope
// baseline used by implementation-precheck. The PlanImplement agent may write
// solution/** in the task instance and runs/<task>/docs/** in the campaign.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, snapshotTree } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskDir = local.taskContext?.task_dir ?? "";
if (!taskDir) throw new Error("prepare-plan-implementation requires taskContext.task_dir");

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const taskName = path.basename(taskDir);
const snapshot = {
	taken_at: new Date().toISOString(),
	task_dir: taskDir,
	runs: await snapshotTree(fs, path, path.join(root, "runs", taskName), root),
	wiki: await snapshotTree(fs, path, path.join(root, "wiki"), root),
};
await fs.writeFile(path.join(outputDir, "plan-phase-snapshot.json"), JSON.stringify(snapshot) + "\n");

const result = {
	task_dir: taskDir,
	prepared_at: snapshot.taken_at,
	write_scope_baseline: "plan-phase-snapshot.json",
	round_id: local.stintBudget?.round_id ?? "",
	mode: local.directLoop?.continue_inner === true ? "direct_cycle" : "round_start",
};
const outputPath = path.join(outputDir, "prepare-plan-implementation.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}prepared PlanImplement candidate for ${taskDir}`,
	data: result,
	statePatch: [
		lanePatch(lane, "implementation", {}),
		lanePatch(lane, "implementationPrecheck", {}),
		lanePatch(lane, "functionalReview", {}),
		lanePatch(lane, "functionalReviewMeta", { iteration: 0, decision: "review", round_id: result.round_id }),
		lanePatch(lane, "validation", {}),
		lanePatch(lane, "rewardHackReview", {}),
		lanePatch(lane, "performanceReview", {}),
		lanePatch(lane, "directSubmission", {}),
		...(result.mode === "round_start" ? [lanePatch(lane, "directLoop", {})] : []),
		lanePatch(lane, "leaderboardUpdate", {}),
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};
