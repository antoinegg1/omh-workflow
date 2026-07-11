// Plan draft<->review loop counter, plus the per-round plan write-scope check:
// plan agents may only have written runs/<task>/docs/{draft,plan}.md since the
// reset snapshot (hardcoded matrix in lane-utils). A violation forces another
// revise round and is recorded in the gate output.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { checkWriteScope, diffTree, laneFromContext, laneOutputDir, lanePatch, laneState, readJsonSafe, snapshotTree } =
	await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const review = localState.planReview ?? state.planReview ?? {};
const previous = localState.planReviewMeta ?? state.planReviewMeta ?? {};
const taskDir = localState.taskContext?.task_dir ?? state.taskContext?.task_dir ?? "";
const maxRounds = parsePositiveInt(process.env.SOL_H800_PLAN_REVIEW_MAX_ROUNDS, 2);
const round = Number(previous.round ?? 0) + 1;
let verdict = String(review.verdict ?? "").toLowerCase() === "approve" ? "approve" : "revise";

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });

// Write-scope check against the plan-reset snapshot (script-managed artifacts excluded).
const snapshot = await readJsonSafe(fs, path.join(outputDir, "plan-reset-snapshot.json"), null);
let scope = { checked: false, ok: true, violations: [], policy: "" };
if (snapshot && taskDir) {
	const taskName = path.basename(taskDir);
	const currentRuns = await snapshotTree(fs, path, path.join(root, "runs", taskName), root);
	const currentWiki = await snapshotTree(fs, path, path.join(root, "wiki"), root);
	const changed = diffTree({ ...(snapshot.runs ?? {}), ...(snapshot.wiki ?? {}) }, { ...currentRuns, ...currentWiki })
		.map((item) => item.path)
		.filter((relPath) => !relPath.startsWith("wiki/") && !/^runs\/[^/]+\/(candidates|scoreboard|submission_log|best_manifest|integrity_|meetings\/|candidates\.jsonl)/u.test(relPath));
	const result = checkWriteScope(changed, "planner");
	scope = { checked: true, ok: result.ok, violations: result.violations.slice(0, 20), policy: result.policy };
	if (!result.ok && verdict === "approve") {
		verdict = "revise"; // out-of-scope writes force another review round and are surfaced to the planner
	}
}

const decision = verdict === "approve" || round >= maxRounds ? "finalize" : "revise";
const result = {
	round,
	max_rounds: maxRounds,
	verdict,
	decision,
	forced_finalize: verdict !== "approve" && round >= maxRounds,
	write_scope: scope,
};

const outputPath = path.join(outputDir, "plan-review-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary:
		decision === "revise"
			? `plan review requested revision (${round}/${maxRounds})${scope.checked && !scope.ok ? " [write-scope violation]" : ""}`
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
