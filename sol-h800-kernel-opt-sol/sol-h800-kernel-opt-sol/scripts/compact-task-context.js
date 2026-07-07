const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const {
	extractTaskDir: extractTaskDirShared,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	normalizeTaskDir: normalizeTaskDirShared,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const tasks = state.campaign?.tasks ?? [];
const forcedTaskDir = lane ? "" : normalizeTaskDirShared(process.env.SOL_H800_TASK_DIR ?? process.env.SOL_H800_FORCE_TASK ?? "");
const selectedTaskDir =
	extractTaskDirShared(localState.selection) ||
	forcedTaskDir ||
	extractTaskDirShared(state.selection) ||
	(lane ? "" : firstUnoptimizedTask(tasks)?.task_dir || tasks[0]?.task_dir);
if (!selectedTaskDir) {
	throw new Error("no task available to compact");
}

const taskDir = path.join(root, selectedTaskDir);
if (!(await exists(taskDir))) {
	throw new Error(`selected task does not exist: ${selectedTaskDir}`);
}
const definition = await readJson(path.join(taskDir, "definition.json"), {});
const reference = await readText(path.join(taskDir, "reference.py"), "");
const taskMd = await readText(path.join(taskDir, "task.md"), "");
const workloadText = await readText(path.join(taskDir, "workload.jsonl"), "");
const workloadLines = workloadText.split(/\r?\n/u).filter((line) => line.trim());
const workloads = workloadLines.map((line) => safeJson(line));
const candidates = await readJsonl(path.join(taskDir, "candidates.jsonl"));
const benchmarkCsv = await readText(path.join(taskDir, "benchmark.csv"), "");
const sameTaskLocalLoop =
	localState.localLoop?.task_dir === selectedTaskDir ? limitValue(localState.localLoop, 3) : {};
const sameTaskState =
	localState.taskContext?.task_dir === selectedTaskDir ||
	localState.validation?.task_dir === selectedTaskDir ||
	localState.revision?.task_dir === selectedTaskDir ||
	localState.localLoop?.task_dir === selectedTaskDir;
const currentBest = bestPassedCandidate(candidates);
const detailPaths = await buildDetailPaths(taskDir, selectedTaskDir, currentBest, state, lane);
const plannerFeedback = sameTaskState ? compactPlannerFeedback(localState.performanceReview, detailPaths) : {};

const context = {
	task_dir: selectedTaskDir,
	task_name: path.basename(selectedTaskDir),
	source_paths: {
		definition: path.join(selectedTaskDir, "definition.json"),
		reference: path.join(selectedTaskDir, "reference.py"),
		workload: path.join(selectedTaskDir, "workload.jsonl"),
		task_contract: path.join(selectedTaskDir, "task.md"),
		candidates: path.join(selectedTaskDir, "candidates.jsonl"),
		benchmark: path.join(selectedTaskDir, "benchmark.csv"),
	},
	campaign_contract_excerpt:
		typeof state.campaign?.taskContract === "string" ? excerpt(state.campaign.taskContract, 1800) : "",
	definition_summary: {
		name: definition.name,
		description: excerpt(definition.description ?? "", 900),
		axes: limitValue(definition.axes ?? {}, 3),
		inputs: limitValue(definition.inputs ?? {}, 3),
		outputs: limitValue(definition.outputs ?? {}, 3),
		tolerances: limitValue(definition.tolerances ?? {}, 3),
	},
	workload_count: workloadLines.length,
	workload_axis_summary: summarizeAxes(workloads),
	workload_samples: workloads.slice(0, 3).map(stripWorkloadIdentity),
	reference_excerpt: referenceDigest(reference),
	task_md_excerpt: excerpt(taskMd, 2200),
	current_best_unfinished: currentBest ? compactCandidate(currentBest) : null,
	candidate_tail: candidates.slice(-3).map(compactCandidate),
	benchmark_tail: benchmarkCsv.split(/\r?\n/u).filter((line) => line.trim()).slice(-4),
	planner_feedback: plannerFeedback,
	local_loop: compactLocalLoop(sameTaskLocalLoop),
	detail_paths: detailPaths,
	context_policy: {
		loaded_review_policy:
			"Only the latest performance-review action summary is loaded into planner_feedback. Read detail_paths for full candidate evidence, prior plans, revision notes, profile reports, and traces when needed.",
	},
	workflow_mode: {
		scout_smoke: process.env.SOL_H800_SCOUT_SMOKE === "1",
		forced_task_dir: forcedTaskDir || "",
		worker_lane: lane,
	},
};

const outputDir = laneOutputDir(path, root, lane, selectedTaskDir);
await fs.mkdir(outputDir, { recursive: true });
const contextPath = path.join(outputDir, "task-context.json");

const taskWiki = path.join(root, "wiki", "tasks", `${path.basename(selectedTaskDir)}.md`);
if (!(await exists(taskWiki))) {
	await fs.mkdir(path.dirname(taskWiki), { recursive: true });
	await fs.writeFile(
		taskWiki,
		[
			`# ${path.basename(selectedTaskDir)}`,
			"",
			"- Status: unverified",
			"- Target: local H800 P50 latency",
			"- Promotion: official SOL-ExecBench correctness plus H800 latency evidence",
			"",
			"## Notes",
			"",
			"Scouts and coordinator should append sourced findings here.",
			"",
		].join("\n"),
	);
}

// Surface the current wiki content (maintained by the wiki-search lane) into the
// task context so each planning/revision round sees the freshest findings.
context.wiki_excerpt = excerpt(await readText(taskWiki, ""), 4000);

// Surface the latest meeting decision (if a stall meeting was held for this task)
// so the next revision round acts on the moderator's binding guidance. The sidecar
// lives under workflow-output/ (git-ignored scratch), written by append-meeting-record.js.
context.meeting_guidance = await readJson(
	path.join(root, "workflow-output", "meeting-guidance", `${path.basename(selectedTaskDir)}.json`),
	null,
);

await fs.writeFile(contextPath, JSON.stringify(context, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}compacted context for ${selectedTaskDir}`,
	data: { task_dir: selectedTaskDir, workload_count: workloadLines.length, forced: Boolean(forcedTaskDir), lane },
	statePatch: [lanePatch(lane, "taskContext", compactContextForState(context, contextPath))],
	artifacts: [`local://${path.relative(root, contextPath)}`, `local://${path.relative(root, taskWiki)}`],
};

function extractTaskDir(selection) {
	if (!selection) return "";
	if (typeof selection === "string") return matchTaskDir(selection);
	if (selection.task_dir) return selection.task_dir;
	if (selection.data?.task_dir) return selection.data.task_dir;
	if (selection.data?.taskDir) return selection.data.taskDir;
	if (selection.summary) return matchTaskDir(String(selection.summary));
	const text = JSON.stringify(selection);
	return matchTaskDir(text);
}

function matchTaskDir(text) {
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const value = match[0].replace(/^\/?root\/kernel-opt\//u, "");
	return value.startsWith("tasks/") ? value : `tasks/${value}`;
}

function normalizeTaskDir(value) {
	if (typeof value !== "string" || !value.trim()) return "";
	const trimmed = value.trim().replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "");
	return matchTaskDir(trimmed);
}

function firstUnoptimizedTask(tasks) {
	return tasks.find((task) => task.best_p50_ms === null || task.best_p50_ms === undefined) ?? tasks[0];
}

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

async function readJson(filePath, fallback) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

async function readJsonl(filePath) {
	const text = await readText(filePath, "");
	return text
		.split(/\r?\n/u)
		.filter((line) => line.trim())
		.map((line) => safeJson(line));
}

function safeJson(line) {
	try {
		return JSON.parse(line);
	} catch {
		return { raw: line.slice(0, 1000) };
	}
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read source path for full text]`;
}

function referenceDigest(text) {
	const value = String(text ?? "");
	const signatures = value
		.split(/\r?\n/u)
		.filter((line) => /^(def|class)\s+/u.test(line.trim()) || /^@/u.test(line.trim()))
		.slice(0, 60)
		.join("\n");
	const runIndex = value.search(/\n(?:@torch\.no_grad\(\)\n)?def run\s*\(/u);
	const runExcerpt = runIndex >= 0 ? value.slice(runIndex, runIndex + 2600) : value.slice(Math.max(0, value.length - 2600));
	return excerpt([signatures, runExcerpt].filter(Boolean).join("\n\n--- run/tail excerpt ---\n"), 3600);
}

function stripWorkloadIdentity(workload) {
	if (!workload || typeof workload !== "object") return workload;
	const { uuid: _uuid, ...rest } = workload;
	return limitValue(rest, 4);
}

function summarizeAxes(workloads) {
	const valuesByAxis = new Map();
	for (const workload of workloads) {
		if (!workload || typeof workload !== "object" || !workload.axes) continue;
		for (const [axis, value] of Object.entries(workload.axes)) {
			if (!valuesByAxis.has(axis)) valuesByAxis.set(axis, []);
			valuesByAxis.get(axis).push(value);
		}
	}
	const summary = {};
	for (const [axis, values] of valuesByAxis.entries()) {
		const numeric = values.filter((value) => typeof value === "number");
		const unique = [...new Set(values.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value));
		summary[axis] = {
			count: values.length,
			unique_count: unique.length,
			unique_values: unique.length <= 32 ? unique : unique.slice(0, 32),
		};
		if (numeric.length === values.length && numeric.length > 0) {
			const sorted = [...numeric].sort((a, b) => a - b);
			summary[axis].min = sorted[0];
			summary[axis].max = sorted[sorted.length - 1];
			summary[axis].p50 = sorted[Math.floor(sorted.length / 2)];
			summary[axis].all_multiples_of_128 = sorted.every((value) => value % 128 === 0);
		}
	}
	return summary;
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
		solution: row.solution ?? "",
		solution_snapshot: row.solution_snapshot ?? "",
		artifact: row.artifact ?? "",
		mean_ms: row.mean_ms ?? null,
		median_ms: row.median_ms ?? row.p50_ms ?? null,
		p90_ms: row.p90_ms ?? null,
		max_ms: row.max_ms ?? null,
		min_ms: row.min_ms ?? null,
		passed: row.passed ?? null,
		total: row.total ?? null,
		model: row.model ?? "",
		notes: excerpt(row.notes ?? "", 300),
		promoted_at: row.promoted_at ?? "",
	};
}

function bestPassedCandidate(rows) {
	return rows
		.filter((row) => isPassedCandidate(row) && Number.isFinite(metric(row, "median_ms", "p50_ms")))
		.sort((a, b) => metric(a, "median_ms", "p50_ms") - metric(b, "median_ms", "p50_ms"))[0];
}

function isPassedCandidate(row) {
	if (!row || typeof row !== "object") return false;
	if (!["passed", "promoted"].includes(String(row.status ?? "").toLowerCase())) return false;
	const passed = Number(row.passed);
	const total = Number(row.total);
	if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) return passed === total;
	return Number.isFinite(metric(row, "median_ms", "p50_ms"));
}

function metric(row, ...keys) {
	for (const key of keys) {
		const value = Number(row?.[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

async function buildDetailPaths(taskDirAbs, taskDirRel, currentBest, state, lane = "") {
	const docsDir = path.join(taskDirAbs, "docs");
	const revisionNotes = (await listMatchingFiles(docsDir, /^revision_.*\.md$/u)).map((filePath) => normalizeRel(path.relative(root, filePath)));
	const profileReports = (await findFiles(path.join(taskDirAbs, "profile"), "REPORT.md", 8)).map((filePath) =>
		normalizeRel(path.relative(root, filePath)),
	);
	const stateProfileReport = normalizeRel(state.profile?.report_path ?? state.profile?.data?.report_path ?? "");
	if (stateProfileReport && !profileReports.includes(stateProfileReport)) profileReports.push(stateProfileReport);

	const workflowOutputPrefix = lane
		? path.join("workflow-output", "lanes", lane, path.basename(taskDirRel))
		: "workflow-output";
	return {
		task_docs: {
			docs_dir: path.join(taskDirRel, "docs"),
			draft_plan: path.join(taskDirRel, "docs", "draft.md"),
			plan: path.join(taskDirRel, "docs", "plan.md"),
			final_plan: path.join(taskDirRel, "docs", "final_plan.md"),
			revision_notes: revisionNotes.slice(-5),
		},
		candidate_evidence: {
			candidates: path.join(taskDirRel, "candidates.jsonl"),
			benchmark: path.join(taskDirRel, "benchmark.csv"),
			current_best_trace: currentBest?.artifact ? path.join(taskDirRel, normalizeRel(currentBest.artifact)) : "",
			current_best_summary: candidateSummaryPath(taskDirRel, currentBest),
			current_best_solution_snapshot: candidateSolutionSnapshot(taskDirRel, currentBest),
		},
		profile: {
			report_paths: profileReports.slice(-5),
		},
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
			revision_notes: detailPaths.task_docs.revision_notes.slice(-2),
			profile_reports: detailPaths.profile.report_paths.slice(-2),
			candidates: detailPaths.candidate_evidence.candidates,
			benchmark: detailPaths.candidate_evidence.benchmark,
			current_best_summary: detailPaths.candidate_evidence.current_best_summary,
			current_best_trace: detailPaths.candidate_evidence.current_best_trace,
		},
	};
}

function deriveMustDoNext({ profileRequired, remainingExperiments, reason }) {
	if (profileRequired) return "Obtain or use profile evidence before another speculative rewrite.";
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
		task_dir: context.task_dir,
		task_name: context.task_name,
		context_file: normalizeRel(path.relative(root, contextPath)),
		source_paths: context.source_paths,
		definition_summary: {
			name: context.definition_summary?.name ?? "",
			description: excerpt(context.definition_summary?.description ?? "", 300),
		},
		workload_count: context.workload_count,
		current_best_unfinished: context.current_best_unfinished,
		candidate_tail: Array.isArray(context.candidate_tail) ? context.candidate_tail.slice(-2) : [],
		benchmark_tail: Array.isArray(context.benchmark_tail) ? context.benchmark_tail.slice(-2) : [],
		planner_feedback: context.planner_feedback,
		local_loop: context.local_loop,
		wiki_excerpt: context.wiki_excerpt ?? "",
		meeting_guidance: context.meeting_guidance ?? null,
		detail_paths: context.detail_paths,
		context_policy: {
			state_compacted:
				"Full task context is stored at context_file. Read that artifact and source_paths for exact details before implementation.",
		},
		workflow_mode: context.workflow_mode,
	};
}

function candidateSummaryPath(taskDirRel, row) {
	const artifact = normalizeRel(row?.artifact ?? "");
	if (!artifact) return "";
	const match = /^runs\/h800\/([^/]+)\//u.exec(artifact);
	if (match) return path.join(taskDirRel, "runs", "h800", match[1], "h800_latency_summary.json");
	if (artifact.endsWith("h800_latency_summary.json")) return path.join(taskDirRel, artifact);
	return "";
}

function candidateSolutionSnapshot(taskDirRel, row) {
	if (!row || typeof row !== "object") return "";
	if (typeof row.solution_snapshot === "string" && row.solution_snapshot) return normalizeRel(row.solution_snapshot);
	const artifact = normalizeRel(row.artifact ?? "");
	const solution = typeof row.solution === "string" && row.solution ? row.solution : "solution.json";
	if (!artifact) return path.join(taskDirRel, solution);
	return path.join(taskDirRel, path.dirname(artifact), solution).replaceAll("\\", "/");
}

async function listMatchingFiles(dir, pattern) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && pattern.test(entry.name))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

async function findFiles(dir, basename, limit) {
	const found = [];
	await walkFiles(dir, async (filePath) => {
		if (path.basename(filePath) === basename) found.push(filePath);
	});
	return found.sort().slice(-limit);
}

async function walkFiles(dir, visit) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) await walkFiles(filePath, visit);
		else if (entry.isFile()) await visit(filePath);
	}
}

function normalizeRel(value) {
	return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple)?\//u, "");
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function limitValue(value, depth) {
	if (depth <= 0) return summarizeValue(value);
	if (typeof value === "string") return excerpt(value, 500);
	if (Array.isArray(value)) {
		const mapped = value.slice(0, 12).map((item) => limitValue(item, depth - 1));
		if (value.length > mapped.length) mapped.push(`...[${value.length - mapped.length} more items]`);
		return mapped;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).slice(0, 24);
		const output = Object.fromEntries(entries.map(([key, item]) => [key, limitValue(item, depth - 1)]));
		const remaining = Object.keys(value).length - entries.length;
		if (remaining > 0) output.__truncated_keys = remaining;
		return output;
	}
	return value;
}

function summarizeValue(value) {
	if (typeof value === "string") return excerpt(value, 160);
	if (Array.isArray(value)) return `[array length ${value.length}]`;
	if (value && typeof value === "object") return `[object keys ${Object.keys(value).slice(0, 8).join(", ")}]`;
	return value;
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
