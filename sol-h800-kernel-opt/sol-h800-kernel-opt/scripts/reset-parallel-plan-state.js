const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const taskDir = state.taskContext?.task_dir ?? "";
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
	planner_flows: ["a", "b"],
	plan_review_max_rounds: maxPlanReviewRounds,
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "reset-parallel-plan-state.json"), JSON.stringify(result, null, 2) + "\n");

return {
	summary: `reset parallel plan state for ${taskDir || "selected task"}`,
	data: result,
	statePatch: [
		{ op: "set", path: "/planReviewMeta", value: planReviewMeta },
		{ op: "set", path: "/planReview", value: {} },
		{ op: "set", path: "/plan", value: {} },
		{ op: "set", path: "/plannerFlows", value: {} },
		{ op: "set", path: "/implementationPlan", value: {} },
	],
	artifacts: ["local://workflow-output/reset-parallel-plan-state.json"],
};

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
