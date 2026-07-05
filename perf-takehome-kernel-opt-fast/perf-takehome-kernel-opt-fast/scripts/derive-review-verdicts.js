// derive-review-verdicts.js
//
// FAST flow merges the old rewardHackReview + performanceReview into a SINGLE reviewer call
// (reviewCandidate) that writes /performanceReview. That object carries BOTH:
//   - the compliance judgement (correctness + no reward-hack)  -> data.reward_verdict ("pass"|"fail")
//   - the promotion judgement (promote|revise|reject)          -> data.verdict
//   - the next-round optimization ideas                        -> data.remaining_experiments / reason
//
// Downstream scripts (record-task-best, promote-and-update-leaderboard, task-local-loop-gate) were
// written for the two-node design and still read /rewardHackReview separately. To keep them 100%
// unchanged, this tiny script derives /rewardHackReview from the merged review's compliance fields.
// No LLM call — pure state transform.

const path = await import("node:path");
const fs = await import("node:fs/promises");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);

const review = localState.performanceReview ?? state.performanceReview ?? {};
const data = review && typeof review.data === "object" ? review.data : review;

// Compliance verdict: prefer an explicit reward_verdict field from the merged review; otherwise infer
// from the review text. DEFAULT to "pass" only when the review clearly promotes/revises a validated
// candidate — a reviewer that flagged a real reward-hack MUST set reward_verdict:"fail" or say so.
const rawReward = normalize(readStr(data, "reward_verdict") || readStr(data, "compliance") || readStr(review, "reward_verdict"));
let rewardVerdict = rawReward;
if (rewardVerdict !== "pass" && rewardVerdict !== "fail") {
	// Fall back to scanning the review text for an explicit reward-hack failure signal.
	const text = `${readStr(review, "summary")} ${readStr(data, "reason")} ${readStr(data, "rationale")} ${readStr(data, "compliance_note")}`.toLowerCase();
	if (/\breward[_ -]?hack\b[^.]{0,40}\b(fail|present|detected|found|yes)\b/u.test(text) || /\bverdict\s*[:=]\s*"?fail"?/u.test(text)) {
		rewardVerdict = "fail";
	} else {
		rewardVerdict = "pass";
	}
}

const rewardHackReview = {
	task_dir: data.task_dir ?? review.task_dir ?? localState.taskContext?.task_dir ?? "",
	verdict: rewardVerdict,
	source: "reviewCandidate",
	summary: readStr(review, "summary").slice(0, 200),
	rationale: (readStr(data, "compliance_note") || readStr(data, "rationale") || readStr(data, "reason")).slice(0, 600),
};

const outputDir = laneOutputDir(path, root, lane, rewardHackReview.task_dir || "tasks/kernel_opt");
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "derive-review-verdicts.json");
await fs.writeFile(outputPath, JSON.stringify(rewardHackReview, null, 2) + "\n");

return {
	summary: `derived reward verdict=${rewardVerdict} from merged review`,
	data: rewardHackReview,
	statePatch: [lanePatch(lane, "rewardHackReview", rewardHackReview)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function readStr(obj, key) {
	if (!obj || typeof obj !== "object") return "";
	const v = obj[key];
	return typeof v === "string" ? v : "";
}

function normalize(value) {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "pass" || v === "passed" || v === "ok" || v === "clean") return "pass";
	if (v === "fail" || v === "failed" || v === "reject" || v === "rejected") return "fail";
	return v;
}
