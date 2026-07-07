const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const taskContext = state.taskContext ?? {};
const flows = state.plannerFlows ?? {};
const candidates = [
	{ lane: "a", label: "A", plan: flows.a?.plan ?? {}, review: flows.a?.review ?? {} },
	{ lane: "b", label: "B", plan: flows.b?.plan ?? {}, review: flows.b?.review ?? {} },
]
	.map((candidate) => ({
		...candidate,
		plan: normalizePlan(candidate.plan, candidate.label, taskContext),
	}))
	.map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }));

const viable = candidates.filter((candidate) => candidate.score.valid);
if (viable.length === 0) {
	throw new Error("no parallel planner produced a usable plan");
}

viable.sort((left, right) => {
	if (right.score.total !== left.score.total) return right.score.total - left.score.total;
	return left.lane.localeCompare(right.lane);
});

const selected = viable[0];
for (const candidate of viable) {
	await writePlanDocs(candidate.plan, candidate.label, taskContext);
}
const selectedPlan = {
	...selected.plan,
	parallel_planner_lane: selected.label,
	parallel_selection_reason: selected.score.reason,
};
const selectedReview = {
	...selected.review,
	parallel_planner_lane: selected.label,
};
const result = {
	task_dir: normalizeTaskDir(selectedPlan.task_dir || taskContext.task_dir || ""),
	selected_lane: selected.label,
	selected_candidate: String(selectedPlan.candidate_name || ""),
	selected_verdict: normalizeVerdict(selected.review?.verdict),
	selection_reason: selected.score.reason,
	candidates: candidates.map((candidate) => ({
		lane: candidate.label,
		candidate_name: String(candidate.plan?.candidate_name || ""),
		verdict: normalizeVerdict(candidate.review?.verdict),
		confidence: candidate.review?.confidence ?? "",
		required_changes: Array.isArray(candidate.review?.required_changes) ? candidate.review.required_changes.length : null,
		score: candidate.score.total,
		valid: candidate.score.valid,
		reason: candidate.score.reason,
	})),
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "parallel-plan-selection.json"), JSON.stringify(result, null, 2) + "\n");
const planArtifacts = viable.flatMap((candidate) => [candidate.plan.plan_path, candidate.plan.draft_path]).filter(Boolean);

return {
	summary: `selected planner ${selected.label}: ${result.selected_candidate || "candidate"} (${result.selected_verdict})`,
	data: result,
	statePatch: [
		{ op: "set", path: "/plan", value: selectedPlan },
		{ op: "set", path: "/planReview", value: selectedReview },
		{ op: "set", path: "/plannerFlows/selection", value: result },
	],
	artifacts: ["local://workflow-output/parallel-plan-selection.json", ...planArtifacts.map((artifact) => `local://${artifact}`)],
};

function normalizePlan(plan, label, taskContext) {
	const copy = plan && typeof plan === "object" ? { ...plan } : {};
	const taskDir = normalizeTaskDir(copy.task_dir || taskContext.task_dir || "");
	const lane = String(copy.planner_lane || label || "").toUpperCase();
	if (taskDir) copy.task_dir = taskDir;
	if (lane) copy.planner_lane = lane;
	if (taskDir && lane) {
		copy.plan_path = normalizeRelativePath(copy.plan_path || path.join(taskDir, "docs", `plan_parallel_${lane}.md`));
		copy.draft_path = normalizeRelativePath(copy.draft_path || path.join(taskDir, "docs", `draft_parallel_${lane}.md`));
	}
	copy.files_to_edit = compactStringArray(copy.files_to_edit, 12);
	copy.success_criteria = compactStringArray(copy.success_criteria, 8);
	copy.correctness_checks = compactStringArray(copy.correctness_checks, 8);
	copy.promotion_criteria = compactStringArray(copy.promotion_criteria, 8);
	copy.validation_command = String(copy.validation_command || "");
	copy.implementation_approach = excerpt(copy.implementation_approach || copy.approach || copy.plan_summary || "", 1600);
	copy.risk_summary = excerpt(copy.risk_summary || "", 1200);
	return copy;
}

async function writePlanDocs(plan, label, taskContext) {
	const taskDir = normalizeTaskDir(plan.task_dir || taskContext.task_dir || "");
	if (!taskDir) return;
	const docsDir = path.join(root, taskDir, "docs");
	await fs.mkdir(docsDir, { recursive: true });
	const planPath = normalizeRelativePath(plan.plan_path || path.join(taskDir, "docs", `plan_parallel_${label}.md`));
	const draftPath = normalizeRelativePath(plan.draft_path || path.join(taskDir, "docs", `draft_parallel_${label}.md`));
	await fs.writeFile(path.join(root, draftPath), buildDraftDoc(plan, label, taskContext));
	await fs.writeFile(path.join(root, planPath), buildPlanDoc(plan, label, taskContext));
}

function buildDraftDoc(plan, label, taskContext) {
	return [
		`# Parallel Planner ${label} Draft`,
		"",
		`- Task: ${plan.task_dir || taskContext.task_dir || ""}`,
		`- Candidate: ${plan.candidate_name || ""}`,
		`- Focus: ${label === "A" ? "conservative low-risk candidate" : "higher-upside alternate candidate"}`,
		"",
		"## Approach",
		"",
		String(plan.implementation_approach || "See plan handoff JSON.").trim(),
		"",
	].join("\n");
}

function buildPlanDoc(plan, label, taskContext) {
	const lines = [
		`# Parallel Planner ${label} Plan: ${plan.candidate_name || "candidate"}`,
		"",
		"## Handoff",
		"",
		`- Task: ${plan.task_dir || taskContext.task_dir || ""}`,
		`- Planner lane: ${label}`,
		`- Candidate: ${plan.candidate_name || ""}`,
		"",
		"## Implementation Approach",
		"",
		String(plan.implementation_approach || "No implementation approach provided.").trim(),
		"",
		"## Files To Edit",
		"",
		formatList(plan.files_to_edit),
		"",
		"## Validation",
		"",
		`- Command: \`${plan.validation_command || ""}\``,
		"",
		"## Correctness Checks",
		"",
		formatList(plan.correctness_checks),
		"",
		"## Success Criteria",
		"",
		formatList(plan.success_criteria),
		"",
		"## Promotion Criteria",
		"",
		formatList(plan.promotion_criteria),
		"",
		"## Reward-Hack Risks",
		"",
		String(plan.risk_summary || "No risk summary provided.").trim(),
		"",
	];
	return lines.join("\n");
}

function formatList(values) {
	if (!Array.isArray(values) || values.length === 0) return "- Not specified";
	return values.map((value) => `- ${String(value)}`).join("\n");
}

function scoreCandidate(candidate) {
	const plan = candidate.plan ?? {};
	const review = candidate.review ?? {};
	const hasPlan = Boolean(plan && typeof plan === "object" && Object.keys(plan).length > 0);
	const hasTaskDir = Boolean(normalizeTaskDir(plan.task_dir || ""));
	const hasCandidate = Boolean(String(plan.candidate_name || "").trim());
	if (!hasPlan || !hasTaskDir || !hasCandidate) {
		return { valid: false, total: Number.NEGATIVE_INFINITY, reason: "missing plan task_dir or candidate_name" };
	}

	const verdict = normalizeVerdict(review.verdict);
	const requiredChanges = Array.isArray(review.required_changes) ? review.required_changes.length : 6;
	let total = 10;
	const reasons = [];
	if (verdict === "approve") {
		total += 100;
		reasons.push("approved by reviewer");
	} else {
		total += 20;
		reasons.push("review requested revision");
	}
	total += confidenceScore(review.confidence);
	total -= Math.min(requiredChanges, 6) * 2;
	if (Array.isArray(plan.success_criteria) && plan.success_criteria.length > 0) total += 3;
	if (Array.isArray(plan.files_to_edit) && plan.files_to_edit.length > 0) total += 2;
	if (String(plan.validation_command || "").includes("run_h800_task.py")) total += 2;
	return { valid: true, total, reason: reasons.join("; ") };
}

function normalizeVerdict(value) {
	return String(value ?? "").toLowerCase() === "approve" ? "approve" : "revise";
}

function confidenceScore(value) {
	const text = String(value ?? "").toLowerCase();
	if (/^(high|strong|certain|0\.[8-9]|1(?:\.0+)?)$/u.test(text)) return 6;
	if (/^(medium|moderate|0\.[5-7])/u.test(text)) return 3;
	if (/^(low|weak|0\.[0-4])/u.test(text)) return 0;
	const numeric = Number.parseFloat(text);
	return Number.isFinite(numeric) ? Math.max(0, Math.min(6, numeric * 6)) : 1;
}

function normalizeTaskDir(value) {
	const text = String(value ?? "").trim();
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const taskDir = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
}

function normalizeRelativePath(value) {
	return String(value ?? "").replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple|-test)?\//u, "").replace(/^\/+/u, "");
}

function compactStringArray(value, limit) {
	if (Array.isArray(value)) return value.slice(0, limit).map((item) => excerpt(item, 500));
	if (typeof value === "string" && value.trim()) return [excerpt(value.trim(), 500)];
	return [];
}

function excerpt(value, limit) {
	const text = String(value ?? "");
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}
