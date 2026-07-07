const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskDir = localState.taskContext?.task_dir ?? state.taskContext?.task_dir ?? "";
const maxPlanReviewRounds = parsePositiveInt(process.env.SOL_H800_PLAN_REVIEW_MAX_ROUNDS, 2);
const planReviewMeta = {
	task_dir: taskDir,
	round: 0,
	max_rounds: maxPlanReviewRounds,
	verdict: "",
	decision: "draft",
	forced_finalize: false,
};
const result = {
	task_dir: taskDir,
	reset: true,
	plan_review_max_rounds: maxPlanReviewRounds,
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "reset-simple-plan-state.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}reset simple plan state for ${taskDir || "selected task"}`,
	data: result,
	statePatch: [
		lanePatch(lane, "planReviewMeta", planReviewMeta),
		lanePatch(lane, "planReview", {}),
		lanePatch(lane, "plan", {}),
		lanePatch(lane, "implementationPlan", {}),
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
