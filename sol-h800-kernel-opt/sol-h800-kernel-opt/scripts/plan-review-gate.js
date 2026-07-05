const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const review = localState.planReview ?? state.planReview ?? {};
const previous = localState.planReviewMeta ?? state.planReviewMeta ?? {};
const taskDir = localState.taskContext?.task_dir ?? state.taskContext?.task_dir ?? "";
const maxRounds = parsePositiveInt(process.env.SOL_H800_PLAN_REVIEW_MAX_ROUNDS, 2);
const round = Number(previous.round ?? 0) + 1;
const verdict = String(review.verdict ?? "").toLowerCase() === "approve" ? "approve" : "revise";
const decision = verdict === "approve" || round >= maxRounds ? "finalize" : "revise";
const result = {
	round,
	max_rounds: maxRounds,
	verdict,
	decision,
	forced_finalize: verdict !== "approve" && round >= maxRounds,
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "plan-review-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary:
		decision === "revise"
			? `plan review requested revision (${round}/${maxRounds})`
			: result.forced_finalize
				? `plan review budget exhausted; finalizing after ${round} review(s)`
				: `plan approved after ${round} review(s)`,
	data: result,
	statePatch: [lanePatch(lane, "planReviewMeta", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
