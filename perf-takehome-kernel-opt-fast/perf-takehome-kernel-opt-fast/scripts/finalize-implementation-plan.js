const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const plan = localState.plan ?? state.plan ?? {};
const planReview = localState.planReview ?? state.planReview ?? {};
const planReviewMeta = localState.planReviewMeta ?? state.planReviewMeta ?? {};
const taskDir = normalizeTaskDir(plan.task_dir || taskContext.task_dir || "");
if (!taskDir) {
	throw new Error("cannot finalize implementation plan without task_dir");
}

const taskName = path.basename(taskDir);
const docsDir = path.join(root, taskDir, "docs");
await fs.mkdir(docsDir, { recursive: true });

const planPath = normalizeRelativePath(plan.plan_path || path.join(taskDir, "docs", "plan.md"));
const draftPath = normalizeRelativePath(plan.draft_path || path.join(taskDir, "docs", "draft.md"));
const sourcePlanText = await readText(path.join(root, planPath), "");
const finalPlanRel = path.join(taskDir, "docs", "final_plan.md");
const finalPlanAbs = path.join(root, finalPlanRel);
const finalPlanText = buildFinalPlanText({
	taskName,
	plan,
	planPath,
	draftPath,
	sourcePlanText,
	planReview,
	planReviewMeta,
});
await fs.writeFile(finalPlanAbs, finalPlanText);

const output = {
	task_dir: taskDir,
	task_name: taskName,
	candidate_name: String(plan.candidate_name || "candidate"),
	final_plan_path: finalPlanRel,
	plan_path: planPath,
	draft_path: draftPath,
	files_to_edit: compactStringArray(plan.files_to_edit, 12),
	validation_command: String(plan.validation_command || "the validateKernel node runs the frozen simulator (do_kernel_test 10/16/256); do not invoke run_h800_task.py"),
	success_criteria: compactStringArray(plan.success_criteria, 8),
	risk_summary: excerpt(plan.risk_summary ?? "", 1200),
	source_paths: taskContext.source_paths ?? {},
	workload_count: taskContext.workload_count ?? null,
	workload_axis_summary: taskContext.workload_axis_summary ?? {},
	current_evidence: summarizeCandidateTail(taskContext.candidate_tail),
	benchmark_tail: Array.isArray(taskContext.benchmark_tail) ? taskContext.benchmark_tail.slice(-5) : [],
	plan_review: {
		verdict: planReview.verdict ?? "",
		required_changes: compactStringArray(planReview.required_changes, 6),
		rationale: excerpt(planReview.rationale ?? "", 1200),
		round: planReviewMeta.round ?? 0,
		max_rounds: planReviewMeta.max_rounds ?? 0,
		forced_finalize: Boolean(planReviewMeta.forced_finalize),
	},
	final_plan_excerpt: excerpt(finalPlanText, 11000),
	detail_artifacts: [finalPlanRel, planPath, draftPath].filter(Boolean),
};

const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "implementation-plan.json");
await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
const compactOutput = compactImplementationPlan(output, outputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}finalized implementation plan for ${taskName}: ${output.candidate_name}`,
	data: { task_dir: taskDir, candidate_name: output.candidate_name, final_plan_path: finalPlanRel, implementation_plan_file: compactOutput.implementation_plan_file, lane },
	statePatch: [lanePatch(lane, "implementationPlan", compactOutput)],
	artifacts: [`local://${path.relative(root, outputPath)}`, `local://${finalPlanRel}`],
};

function buildFinalPlanText({ taskName, plan, planPath, draftPath, sourcePlanText, planReview, planReviewMeta }) {
	const lines = [
		`# Final Plan: ${String(plan.candidate_name || taskName)}`,
		"",
		"## Handoff",
		"",
		`- Task: ${taskName}`,
		`- Plan source: \`${planPath}\``,
		`- Draft source: \`${draftPath}\``,
		`- Review verdict: ${String(planReview.verdict || "unknown")}`,
		`- Review round: ${String(planReviewMeta.round ?? 0)}/${String(planReviewMeta.max_rounds ?? 0)}`,
		`- Forced finalize: ${Boolean(planReviewMeta.forced_finalize)}`,
		"",
	];
	if (Array.isArray(planReview.required_changes) && planReview.required_changes.length > 0) {
		lines.push("## Last Review Notes", "");
		for (const change of planReview.required_changes.slice(0, 6)) {
			lines.push(`- ${String(change)}`);
		}
		lines.push("");
	}
	lines.push("## Approved Plan", "");
	lines.push(sourcePlanText.trim() ? sourcePlanText.trim() : JSON.stringify(plan, null, 2));
	lines.push("");
	return lines.join("\n");
}

function normalizeTaskDir(value) {
	const text = String(value ?? "").trim();
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const taskDir = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
}

function normalizeRelativePath(value) {
	return String(value ?? "").replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "").replace(/^\/+/u, "");
}

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

function compactStringArray(value, limit) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, limit).map((item) => excerpt(item, 500));
}

function summarizeCandidateTail(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(-4).map((row) => ({
		candidate: row?.candidate ?? "",
		status: row?.status ?? "",
		promotion_decision: row?.promotion_decision ?? "",
		optimization_limit_reached: Boolean(row?.optimization_limit_reached),
		median_ms: row?.median_ms ?? row?.p50_ms ?? null,
		mean_ms: row?.mean_ms ?? null,
		p90_ms: row?.p90_ms ?? null,
		max_ms: row?.max_ms ?? null,
		passed: row?.passed ?? null,
		total: row?.total ?? null,
		solution: row?.solution ?? "",
	}));
}

function excerpt(value, limit) {
	const text = String(value ?? "");
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars; read referenced file for full text]`;
}

function compactImplementationPlan(value, outputPath) {
	return {
		task_dir: value.task_dir,
		task_name: value.task_name,
		candidate_name: value.candidate_name,
		final_plan_path: value.final_plan_path,
		plan_path: value.plan_path,
		draft_path: value.draft_path,
		implementation_plan_file: normalizeRelativePath(path.relative(root, outputPath)),
		files_to_edit: compactStringArray(value.files_to_edit, 12),
		validation_command: value.validation_command,
		success_criteria: compactStringArray(value.success_criteria, 6),
		risk_summary: excerpt(value.risk_summary, 500),
		source_paths: value.source_paths,
		workload_count: value.workload_count,
		plan_review: {
			verdict: value.plan_review?.verdict ?? "",
			required_changes: compactStringArray(value.plan_review?.required_changes, 4),
			round: value.plan_review?.round ?? 0,
			max_rounds: value.plan_review?.max_rounds ?? 0,
			forced_finalize: Boolean(value.plan_review?.forced_finalize),
		},
		detail_artifacts: value.detail_artifacts,
		context_policy: {
			state_compacted:
				"Read final_plan_path and implementation_plan_file for full plan details. Do not rely on workflow state for full plan text.",
		},
	};
}
