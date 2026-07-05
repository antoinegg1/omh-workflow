const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(workflowContext.state ?? {}, lane);
const progress = workflowContext.state?.campaign?.progress ?? {};
const leaderboard = workflowContext.state?.leaderboard ?? {};
const taskDir = localState.taskContext?.task_dir ?? "";
const taskCount = progress.taskCount ?? 60;
const bestCount = progress.bestCount ?? leaderboard.best_count ?? 0;
const doneCount = progress.doneCount ?? bestCount;
const openCount = progress.openCount ?? Math.max(0, taskCount - doneCount);
const continueCampaign = openCount > 0;
const result = {
	continue: continueCampaign,
	taskCount,
	bestCount,
	doneCount,
	openCount,
	reason: continueCampaign
		? "not all selected tasks have final or parked optimization records"
		: "all selected tasks have final or parked optimization records",
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "next-task-or-finalize.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: continueCampaign
		? `continuing campaign: ${doneCount}/${taskCount} selected tasks done-or-parked (${bestCount} final best)`
		: "campaign complete",
	data: result,
	statePatch: [
		{ op: "set", path: "/campaign/continue", value: continueCampaign },
		{ op: "set", path: "/campaign/finalize", value: result },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};
