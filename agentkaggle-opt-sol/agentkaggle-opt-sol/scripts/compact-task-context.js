// Build the per-task context for one lane round: task facts from tasks.json,
// the instance TASK.md, current solution files, candidate history, submission
// budget, the wiki excerpt, and the latest meeting guidance. Facts only.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	bestPassedCandidate,
	extractTaskDir: extractTaskDirShared,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	metricNumber,
	normalizeTaskDir: normalizeTaskDirShared,
	readJsonlSafe,
	readJsonSafe,
	submissionsToday,
	taskArtifactDir,
	taskMetaFor,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const { milestoneState, readProgressiveTargets, snapshotTaskFor } = await import(
	`file://${path.join(resourceRoot, "scripts", "progressive-goals.js")}`
);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const forcedTaskDir = lane ? "" : normalizeTaskDirShared(process.env.SOL_H800_TASK_DIR ?? process.env.SOL_H800_FORCE_TASK ?? "");
const selectedTaskDir =
	extractTaskDirShared(localState.selection) ||
	forcedTaskDir ||
	extractTaskDirShared(state.selection) ||
	"";
if (!selectedTaskDir) {
	throw new Error("no task available to compact");
}

const rawDir = path.join(root, selectedTaskDir);
if (!(await exists(rawDir))) {
	throw new Error(`selected task does not exist: ${selectedTaskDir}`);
}
const guard = localState.selectionGuard ?? {};
const instanceDir = guard.task_dir === selectedTaskDir && guard.instance_dir ? guard.instance_dir : "";
const artifactDir = taskArtifactDir(path, root, selectedTaskDir);
const taskMeta = (await taskMetaFor(fs, path, root, selectedTaskDir)) ?? {};
const progressiveTargets = await readProgressiveTargets(fs, path, root);

const taskMd = await readText(path.join(instanceDir || rawDir, "TASK.md"), "");
const taskConfig = await readJsonSafe(fs, path.join(rawDir, "evaluation", "task_config.json"), {});
const candidates = await readJsonlSafe(fs, path.join(artifactDir, "candidates.jsonl"));
const submissionRows = await readJsonlSafe(fs, path.join(artifactDir, "submission_log.jsonl"));
const currentBest = bestPassedCandidate(candidates);
const submittedToday = await submissionsToday(fs, path, root, selectedTaskDir);
const dailyCap = Number(taskMeta.daily_cap ?? 0) || null;
const leaderboard = await readJsonSafe(fs, path.join(root, "leaderboard.json"), { best_by_task: [] });
const bestRemote = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === selectedTaskDir) ?? null;
const goal = milestoneState(taskMeta, bestRemote?.kaggle_public, snapshotTaskFor(progressiveTargets, selectedTaskDir));
const pendingSubmissionCount = submissionRows.filter((row) => row?.uploaded !== false && row?.kaggle_public == null && !["scoring_error", "upload_failed"].includes(String(row?.status ?? ""))).length;
const routeRemoteHistory = submissionRows
	.filter((row) => row?.uploaded !== false)
	.slice(-6)
	.map(compactCalibration);
const trustedLocalEval = [...candidates].reverse().find((row) => row?.reward_passed === true && row?.local_eval?.command)?.local_eval ?? null;

const solutionFiles = instanceDir ? await listFiles(path.join(instanceDir, "solution")) : [];
const editFile = taskMeta.edit_file ?? "";
const solutionExcerpt = instanceDir && editFile
	? excerpt(await readText(path.join(instanceDir, "solution", editFile), ""), 2600)
	: "";
const dataListing = instanceDir ? await listWithSizes(path.join(instanceDir, "data"), 24) : [];

const sameTaskState =
	localState.taskContext?.task_dir === selectedTaskDir ||
	localState.validation?.task_dir === selectedTaskDir ||
	localState.revision?.task_dir === selectedTaskDir ||
	localState.localLoop?.task_dir === selectedTaskDir;
const sameTaskLocalLoop =
	localState.localLoop?.task_dir === selectedTaskDir ? localState.localLoop : {};
const windowStatus = state.campaign?.taskUpdates?.task_status?.find?.(
	(row) => Number(row?.order) === Number(taskMeta.order),
) ?? {};
const detailPaths = buildDetailPaths(selectedTaskDir, lane);
const plannerFeedback = sameTaskState ? compactPlannerFeedback(localState.performanceReview, detailPaths) : {};

const evalFastArgs = String(taskMeta.eval_fast_args ?? "").trim();
const fullFitArgs = String(taskMeta.full_fit_args ?? "").trim();
const localEvalFast =
	selectedTaskDir === "x03-santa-2023"
		? "python evaluation/local_eval.py --no-run --submission solution/submission.csv"
		: `python evaluation/local_eval.py${evalFastArgs ? ` ${evalFastArgs}` : ""}`;

const selection = unwrap(localState.selection ?? {});
const context = {
	campaign_root: root,
	task_dir: selectedTaskDir,
	task_id: taskMeta.sol_id ?? path.basename(selectedTaskDir).split("-")[0],
	task_name: path.basename(selectedTaskDir),
	group: taskMeta.group ?? "",
	instance_dir: instanceDir,
	artifact_dir: path.relative(root, artifactDir),
	edit_file: editFile,
	objective: {
		metric: taskMeta.metric ?? taskConfig.metric ?? "",
		higher_is_better: Boolean(taskMeta.higher_is_better),
		cost_convention: "cost = higher_is_better ? -score : score; lower cost is always better",
		target_top1: taskMeta.target_top1 ?? null,
		target_top3: taskMeta.target_top3 ?? null,
		target_top5: taskMeta.target_top5 ?? null,
		active_goal: goal.active_goal,
		active_target: goal.active_target,
		active_gap: goal.active_gap,
		milestone_points: goal.milestone_points,
		goal_complete: goal.goal_complete,
		threshold_snapshot_id: progressiveTargets.snapshot_id ?? "",
		remote_primary:
			"The Kaggle score reported by `python submit.py --score-only` is the only final score. Local evaluation is an iteration signal, not a benchmark result.",
		local_signal: taskMeta.local_signal ?? "strong",
		benchmark_ready: taskMeta.benchmark_ready !== false,
		validation_mode: taskMeta.validation_mode ?? "local",
	},
	submissions: {
		today: submittedToday,
		daily_cap: dailyCap,
		remaining_today: dailyCap === null ? null : Math.max(0, dailyCap - submittedToday),
		pending_count: pendingSubmissionCount,
		hours_to_utc_reset: hoursToUtcReset(),
		autonomous_direct_allowed: dailyCap !== null && Math.max(0, dailyCap - submittedToday) > 5,
		note: "Valid new candidates submit automatically. With more than 5 remaining, direct calibration may continue inside the round; with 5 or fewer, the full lane flow may upload at most once per round. One pending upload blocks another.",
		mode: taskMeta.submission_mode ?? "file",
		artifact: taskMeta.submission_file ?? "submission.csv",
		transport:
			(taskMeta.submission_mode ?? "file") === "file"
				? "Direct file upload — the promotion script owns the whole transport (CLI, retry, REST fallback); produce the submission artifact and never call submit yourself."
				: (taskMeta.submission_mode ?? "file") === "kernel_output"
					? "Kernels-only competition: file uploads are policy-rejected. The promotion script pushes solution/kernel-metadata.json + notebook_submission.ipynb (a notebook that REGENERATES the submission artifact in-kernel by re-running the solver — no static payload) and submits the kernel output. Keep those two assets in solution/ current with the candidate."
					: "Kernels-only CODE competition: the submission is a notebook Kaggle reruns on the HIDDEN test. Author solution/kernel-metadata.json + notebook_submission.ipynb that produces predictions inside the kernel (no internet, runtime-capped); ship trained model artifacts under solution/kernel-dataset/ with a dataset-metadata.json (the promotion script uploads it as a Kaggle dataset and the notebook attaches it). The promotion script pushes and submits the kernel version.",
	},
	coordinator: {
		selection_reason: selection.reason ?? "",
		assignment_mode: selection.assignment_mode ?? "optimize",
		note: "The reason explains why this task was selected. It does not prescribe the model, solver, features, or experiment sequence.",
	},
	remote_evidence: {
		best_remote: bestRemote ? compactCalibration(bestRemote) : null,
		latest_calibration: routeRemoteHistory.at(-1) ?? null,
		route_remote_history: routeRemoteHistory,
		note: "A route may temporarily score below the historical best. Preserve the best separately while using calibration history to decide whether to continue the route.",
	},
	trusted_local_eval: trustedLocalEval,
	commands: {
		integrity: "python evaluation/check_integrity.py  (run inside instance_dir; must print 'integrity OK')",
		local_eval_fast: localEvalFast,
		local_eval_full: `python evaluation/local_eval.py${fullFitArgs ? ` ${fullFitArgs}` : ""}`,
		note: "The workflow's validation node runs these harness-side inside a capacity-2 GPU pool (CUDA_VISIBLE_DEVICES is assigned by the pool). Agents may run short dev checks themselves inside instance_dir.",
	},
	source_paths: {
		instance_task_contract: instanceDir ? path.join(instanceDir, "TASK.md") : path.join(selectedTaskDir, "TASK.md"),
		instance_solution_dir: instanceDir ? path.join(instanceDir, "solution") : "",
		task_config: path.join(selectedTaskDir, "evaluation", "task_config.json"),
		requirements: instanceDir ? path.join(instanceDir, "requirements.txt") : path.join(selectedTaskDir, "requirements.txt"),
	},
	campaign_contract_excerpt:
		typeof state.campaign?.taskContract === "string" ? excerpt(state.campaign.taskContract, 1600) : "",
	task_md_excerpt: excerpt(taskMd, 2400),
	solution_files: solutionFiles.slice(0, 16),
	solution_excerpt: solutionExcerpt,
	data_listing: dataListing,
	current_best_unfinished: currentBest ? compactCandidate(currentBest) : null,
	candidate_tail: candidates.slice(-3).map(compactCandidate),
	planner_feedback: plannerFeedback,
	local_loop: compactLocalLoop(sameTaskLocalLoop),
	window_progress: {
		visit_count: windowStatus.window_visit_count ?? 0,
		no_improve_streak: windowStatus.window_no_improve_streak ?? 0,
		stalled: Boolean(windowStatus.window_stalled),
		last_stall_at: windowStatus.last_stall_at ?? "",
		recovery_count: windowStatus.recovery_count ?? 0,
		policy: "The streak is evidence for review and coordinator scheduling, not a prescribed implementation direction. Choose the current technical work from TASK.md and available evidence.",
	},
	detail_paths: detailPaths,
	context_policy: {
		loaded_review_policy:
			"Only the latest performance-review action summary is loaded into planner_feedback. Read detail_paths for full candidate evidence, prior plans, revision notes, and diagnostics when needed.",
		local_eval_policy:
			"A reviewed solution-local evaluator is a recommended iteration signal, never a Kaggle milestone or completion score. PlanImplement may challenge or replace it.",
	},
	workflow_mode: {
		forced_task_dir: forcedTaskDir || "",
		worker_lane: lane,
	},
};

const outputDir = laneOutputDir(path, root, lane, selectedTaskDir);
await fs.mkdir(outputDir, { recursive: true });
const contextPath = path.join(outputDir, "task-context.json");

const wikiRoot = process.env.SOL_H800_FLOW_WIKI_DIR || path.join(root, "wiki");
const taskWiki = path.join(wikiRoot, "tasks", `${path.basename(selectedTaskDir)}.md`);
if (!(await exists(taskWiki))) {
	await fs.mkdir(path.dirname(taskWiki), { recursive: true });
	await fs.writeFile(
		taskWiki,
		[
			`# ${path.basename(selectedTaskDir)}`,
			"",
			`- Competition: ${taskMeta.comp_slug ?? ""}`,
			`- Metric: ${taskMeta.metric ?? ""} (${taskMeta.higher_is_better ? "higher" : "lower"} is better)`,
			`- Final score source: remote Kaggle submission (local evaluation is an iteration signal only)`,
			"",
			"## Notes",
			"",
			"Search lane appends sourced findings here.",
			"",
		].join("\n"),
	);
}

// Surface the current wiki note (maintained by the search lane) into the task
// context. Progressive disclosure: prefer the note's top TL;DR/consensus section
// over blind head-truncation, and expose the section-heading index so agents can
// read the full note selectively by section.
const wikiNoteText = await readText(taskWiki, "");
context.wiki_excerpt = wikiTldrExcerpt(wikiNoteText, 4000);
context.wiki_sections = wikiSectionIndex(wikiNoteText);
context.wiki_paths = {
	task_note: path.relative(root, taskWiki),
	index: path.relative(root, path.join(wikiRoot, "index.md")),
	meetings_dir: path.relative(root, path.join(wikiRoot, "meetings")),
};

// Latest meeting decision sidecar (written by append-meeting-record.js).
context.meeting_guidance = await readJsonSafe(
	fs,
	path.join(root, "workflow-output", "meeting-guidance", `${path.basename(selectedTaskDir)}.json`),
	null,
);

await fs.writeFile(contextPath, JSON.stringify(context, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}compacted context for ${selectedTaskDir}`,
	data: { task_dir: selectedTaskDir, instance_dir: instanceDir, forced: Boolean(forcedTaskDir), lane },
	statePatch: [lanePatch(lane, "taskContext", compactContextForState(context, contextPath))],
	artifacts: [`local://${path.relative(root, contextPath)}`, `local://${path.relative(root, taskWiki)}`],
};

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

async function listFiles(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
	} catch {
		return [];
	}
}

async function listWithSizes(dir, limit) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const rows = [];
		for (const entry of entries.slice(0, limit)) {
			const filePath = path.join(dir, entry.name);
			try {
				const stat = await fs.stat(filePath);
				rows.push(`${entry.name}${stat.isDirectory() ? "/" : ` (${humanSize(stat.size)})`}`);
			} catch {
				rows.push(entry.name);
			}
		}
		if (entries.length > limit) rows.push(`...[${entries.length - limit} more entries]`);
		return rows;
	} catch {
		return [];
	}
}

function humanSize(bytes) {
	if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
	if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${bytes}B`;
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read source path for full text]`;
}

// Progressive disclosure L1: extract the note's top consensus section (## TL;DR
// or a "current consensus"-style heading) instead of blindly truncating the head.
function wikiTldrExcerpt(text, limit) {
	const value = String(text ?? "");
	const heading = /^##\s+(TL;DR|.*current consensus.*|Runnable spec.*)$/im.exec(value);
	if (heading) {
		const start = heading.index;
		const afterHeading = start + heading[0].length;
		const next = /\n##\s/u.exec(value.slice(afterHeading));
		const section = value.slice(start, next ? afterHeading + next.index : undefined);
		return excerpt(`${section.trim()}\n\n[L1 excerpt — full note has more sections; see wiki_sections]`, limit);
	}
	return excerpt(value, limit);
}

// Progressive disclosure L2: the note's addressable section headings.
function wikiSectionIndex(text) {
	return [...String(text ?? "").matchAll(/^##+\s+(.+)$/gm)].slice(0, 24).map((match) => match[1].trim());
}

function compactCandidate(row) {
	if (!row || typeof row !== "object") return row;
	return {
		candidate: row.candidate ?? "",
		status: row.status ?? "",
		promotion_decision: row.promotion_decision ?? "",
		optimization_limit_reached: Boolean(row.optimization_limit_reached),
		current_best_unfinished: Boolean(row.current_best_unfinished),
		local_loop_exhausted: Boolean(row.local_loop_exhausted),
		local_loop_round: row.local_loop_round ?? null,
		local_loop_max_rounds: row.local_loop_max_rounds ?? null,
		reward_hack_review: row.reward_hack_review ?? "",
		score: row.score ?? null,
		cost: row.cost ?? null,
		metric_name: row.metric_name ?? "",
		mode: row.mode ?? "",
		kaggle_public: row.kaggle_public ?? null,
		kaggle_private: row.kaggle_private ?? null,
		submission_status: row.submission_status ?? "",
		local_eval: row.local_eval ?? null,
		passed: row.passed ?? null,
		total: row.total ?? null,
		artifact: row.artifact ?? "",
		notes: excerpt(row.notes ?? "", 300),
		promoted_at: row.promoted_at ?? "",
	};
}

function buildDetailPaths(taskDirRel, lane = "") {
	const taskName = path.basename(taskDirRel);
	const artifactRel = path.join("runs", taskName);
	const workflowOutputPrefix = lane
		? path.join("workflow-output", "lanes", lane, taskName)
		: "workflow-output";
	return {
		submission_guide: path.join("runs", "_ops", "submission-guide.md"),
		task_docs: {
			docs_dir: path.join(artifactRel, "docs"),
			plan: path.join(artifactRel, "docs", "plan.md"),
			iteration_log: path.join(artifactRel, "docs", "iteration-log.md"),
		},
		candidate_evidence: {
			candidates: path.join(artifactRel, "candidates.jsonl"),
			scoreboard: path.join(artifactRel, "scoreboard.jsonl"),
			submission_log: path.join(artifactRel, "submission_log.jsonl"),
			best_manifest: path.join(artifactRel, "best_manifest.json"),
			candidate_snapshots: path.join(artifactRel, "candidates"),
		},
		meetings: path.join(artifactRel, "meetings"),
		workflow_outputs: {
			task_context: path.join(workflowOutputPrefix, "task-context.json"),
			latest_validation: path.join(workflowOutputPrefix, "validate-h800.json"),
			latest_task_best_update: path.join(workflowOutputPrefix, "task-best-update.json"),
			latest_local_loop_gate: path.join(workflowOutputPrefix, "task-local-loop-gate.json"),
		},
	};
}

function compactPlannerFeedback(value, detailPaths) {
	if (!value) return {};
	const data = value.data && typeof value.data === "object" ? value.data : value;
	const profileRequired = Boolean(data.profile_required);
	const remainingExperiments = Array.isArray(data.remaining_experiments)
		? data.remaining_experiments.slice(0, 4).map((item) => excerpt(item, 260))
		: [];
	const reason = excerpt(data.reason ?? data.summary ?? value.summary ?? "", 900);
	return {
		source: "performanceReview",
		verdict: data.verdict ?? data.decision ?? "",
		optimization_limit_reached: Boolean(data.optimization_limit_reached),
		profile_required: profileRequired,
		blocking_reason: reason,
		next_experiments: remainingExperiments,
		must_do_next: deriveMustDoNext({ profileRequired, remainingExperiments, reason }),
		full_detail_paths: {
			candidates: detailPaths.candidate_evidence.candidates,
			scoreboard: detailPaths.candidate_evidence.scoreboard,
			plan: detailPaths.task_docs.plan,
		},
	};
}

function deriveMustDoNext({ profileRequired, remainingExperiments, reason }) {
	if (profileRequired) return "Obtain or use diagnostic evidence before another speculative rewrite.";
	if (remainingExperiments.length > 0) return remainingExperiments[0];
	return reason ? "Address the latest performance-review blocking reason." : "";
}

function compactLocalLoop(value) {
	if (!value || typeof value !== "object" || Object.keys(value).length === 0) return {};
	const round = numberOrNull(value.round);
	const maxRounds = numberOrNull(value.max_rounds);
	return {
		task_dir: value.task_dir ?? "",
		round,
		max_rounds: maxRounds,
		remaining_rounds: round !== null && maxRounds !== null ? Math.max(0, maxRounds - round) : null,
		continueSameTask: Boolean(value.continueSameTask),
		status: value.status ?? "",
		reason: excerpt(value.reason ?? "", 500),
	};
}

function compactContextForState(context, contextPath) {
	return {
		campaign_root: context.campaign_root,
		task_dir: context.task_dir,
		task_id: context.task_id,
		task_name: context.task_name,
		group: context.group,
		instance_dir: context.instance_dir,
		artifact_dir: context.artifact_dir,
		edit_file: context.edit_file,
		objective: context.objective,
		submissions: context.submissions,
		coordinator: context.coordinator,
		remote_evidence: context.remote_evidence,
		trusted_local_eval: context.trusted_local_eval,
		commands: context.commands,
		context_file: path.relative(root, contextPath),
		source_paths: context.source_paths,
		solution_files: context.solution_files,
		current_best_unfinished: context.current_best_unfinished,
		candidate_tail: Array.isArray(context.candidate_tail) ? context.candidate_tail.slice(-2) : [],
		planner_feedback: context.planner_feedback,
		local_loop: context.local_loop,
		window_progress: context.window_progress,
		wiki_excerpt: excerpt(context.wiki_excerpt ?? "", 2200),
		wiki_sections: context.wiki_sections ?? [],
		wiki_paths: context.wiki_paths,
		meeting_guidance: context.meeting_guidance ?? null,
		detail_paths: context.detail_paths,
		context_policy: {
			state_compacted:
				"Full task context is stored at context_file. Read that artifact, source_paths, and the instance TASK.md for exact details before planning or implementation.",
		},
		workflow_mode: context.workflow_mode,
	};
}

function compactCalibration(row) {
	if (!row) return null;
	return {
		candidate: row.candidate ?? "",
		kaggle_public: row.kaggle_public ?? null,
		kaggle_private: row.kaggle_private ?? null,
		status: row.status ?? row.submission_status ?? "",
		submitted_at: row.submitted_at ?? row.promoted_at ?? row.time ?? "",
		solution_hash: row.solution_hash ?? "",
		submission_hash: row.submission_hash ?? "",
	};
}

function hoursToUtcReset(now = new Date()) {
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	return Math.max(0, (next - now.getTime()) / 3600000);
}

function unwrap(value) {
	return value?.data && typeof value.data === "object" ? { ...value, ...value.data } : value;
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
