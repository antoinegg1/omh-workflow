// Freeze the reviewed plan into runs/<task>/docs/final_plan.md and emit the
// compact implementation handoff. Also the plan-phase write-scope checkpoint:
// verifies the plan agents only wrote their two markdown files (hardcoded
// matrix in lane-utils), then snapshots runs/<task>/ + wiki/ so the
// implementation-phase guard can diff against it.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	checkWriteScope,
	diffTree,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	normalizeTaskDir,
	readJsonSafe,
	snapshotTree,
	taskArtifactDir,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
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
const artifactDir = taskArtifactDir(path, root, taskDir);
const docsDir = path.join(artifactDir, "docs");
await fs.mkdir(docsDir, { recursive: true });

const planPath = normalizeRelativePath(plan.plan_path || path.join("runs", taskName, "docs", "plan.md"));
const draftPath = normalizeRelativePath(plan.draft_path || path.join("runs", taskName, "docs", "draft.md"));
const sourcePlanText = await readText(path.join(root, planPath), "");
const finalPlanRel = path.join("runs", taskName, "docs", "final_plan.md");
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

// Plan-phase write-scope check (final defense; plan-review-gate checks each round).
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const planSnapshot = await readJsonSafe(fs, path.join(outputDir, "plan-reset-snapshot.json"), null);
let scope = { checked: false, ok: true, violations: [] };
if (planSnapshot) {
	const currentRuns = await snapshotTree(fs, path, path.join(root, "runs", taskName), root);
	const currentWiki = await snapshotTree(fs, path, path.join(root, "wiki"), root);
	const changed = diffTree({ ...(planSnapshot.runs ?? {}), ...(planSnapshot.wiki ?? {}) }, { ...currentRuns, ...currentWiki })
		.map((item) => item.path)
		.filter((relPath) => relPath !== finalPlanRel && !relPath.startsWith("wiki/") && !/^runs\/[^/]+\/(candidates|scoreboard|submission_log|integrity_|meetings\/)/u.test(relPath));
	const verdict = checkWriteScope(changed, "planner");
	scope = { checked: true, ok: verdict.ok, violations: verdict.violations.slice(0, 20), policy: verdict.policy };
}

// Snapshot for the implementation-phase guard (implementation-precheck.js diffs against this).
const implBaseline = {
	taken_at: new Date().toISOString(),
	runs: await snapshotTree(fs, path, path.join(root, "runs", taskName), root),
	wiki: await snapshotTree(fs, path, path.join(root, "wiki"), root),
};
await fs.writeFile(path.join(outputDir, "plan-phase-snapshot.json"), JSON.stringify(implBaseline) + "\n");

const output = {
	task_dir: taskDir,
	task_name: taskName,
	candidate_name: String(plan.candidate_name || "candidate"),
	final_plan_path: finalPlanRel,
	plan_path: planPath,
	draft_path: draftPath,
	instance_dir: taskContext.instance_dir ?? "",
	edit_file: taskContext.edit_file ?? "",
	objective: taskContext.objective ?? {},
	submissions: taskContext.submissions ?? {},
	files_to_edit: compactStringArray(plan.files_to_edit, 12),
	validation_command: String(
		plan.validation_command ||
			`${taskContext.commands?.integrity ?? "python evaluation/check_integrity.py"} && ${taskContext.commands?.local_eval_fast ?? "python evaluation/local_eval.py"}`,
	),
	success_criteria: compactStringArray(plan.success_criteria, 8),
	risk_summary: excerpt(plan.risk_summary ?? "", 1200),
	source_paths: taskContext.source_paths ?? {},
	wiki_paths: taskContext.wiki_paths ?? {},
	current_evidence: summarizeCandidateTail(taskContext.candidate_tail),
	plan_write_scope: scope,
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

const outputPath = path.join(outputDir, "implementation-plan.json");
await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
const compactOutput = compactImplementationPlan(output, outputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}finalized implementation plan for ${taskName}: ${output.candidate_name}${scope.checked && !scope.ok ? " (plan write-scope VIOLATION recorded)" : ""}`,
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

function normalizeRelativePath(value) {
	return String(value ?? "").replace(/^\/+/u, "").replaceAll("\\", "/");
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
		score: row?.score ?? null,
		cost: row?.cost ?? null,
		kaggle_public: row?.kaggle_public ?? null,
		mode: row?.mode ?? "",
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
		instance_dir: value.instance_dir,
		edit_file: value.edit_file,
		objective: value.objective,
		submissions: value.submissions,
		implementation_plan_file: normalizeRelativePath(path.relative(root, outputPath)),
		files_to_edit: compactStringArray(value.files_to_edit, 12),
		validation_command: value.validation_command,
		success_criteria: compactStringArray(value.success_criteria, 6),
		risk_summary: excerpt(value.risk_summary, 500),
		source_paths: value.source_paths,
		wiki_paths: value.wiki_paths,
		plan_write_scope: value.plan_write_scope,
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
