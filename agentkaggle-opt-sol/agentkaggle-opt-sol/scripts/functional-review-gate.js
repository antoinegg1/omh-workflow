const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskDir = local.taskContext?.task_dir ?? "";
const review = unwrap(local.functionalReview ?? {});
const previous = local.functionalReviewMeta ?? {};
const deadlineMs = Date.parse(String(local.stintBudget?.optimization_deadline_at ?? ""));
const expired = Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;
const verdict = normalizeVerdict(review.verdict ?? review.decision ?? review.summary ?? "");
const decision = expired ? "finalize" : verdict === "ready" ? "finalize" : "rework";
const result = {
	task_dir: taskDir,
	round_id: local.stintBudget?.round_id ?? "",
	iteration: Number(previous.iteration ?? 0) + 1,
	verdict: verdict || "improve",
	decision,
	expired,
	remaining_optimization_seconds: local.stintBudget?.remaining_optimization_seconds ?? null,
};
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "functional-review-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}functional review ${result.verdict}; ${decision}`,
	data: result,
	statePatch: [lanePatch(lane, "functionalReviewMeta", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function unwrap(value) {
	return value?.data && typeof value.data === "object" ? { ...value, ...value.data } : value;
}

function normalizeVerdict(value) {
	const text = String(value ?? "").toLowerCase();
	if (/\bready\b/u.test(text)) return "ready";
	if (/\bimprove\b|\brevise\b/u.test(text)) return "improve";
	return "";
}
