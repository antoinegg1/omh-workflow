const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);

const selection = localState.selection ?? state.selection ?? {};
const selectedTaskDir = selection.task_dir || "tasks/kernel_opt";
const taskDir = path.join(root, selectedTaskDir);
await fs.mkdir(path.join(taskDir, "docs"), { recursive: true });

const BASELINE = 147734;
const candidates = await readJsonl(path.join(taskDir, "candidates.jsonl"));
const benchmarkCsv = await readText(path.join(taskDir, "benchmark.csv"), "");
const currentBest = bestPassedCandidate(candidates);

const sameTaskState =
	localState.taskContext?.task_dir === selectedTaskDir ||
	localState.validation?.task_dir === selectedTaskDir ||
	localState.revision?.task_dir === selectedTaskDir ||
	localState.localLoop?.task_dir === selectedTaskDir;
const sameTaskLocalLoop = localState.localLoop?.task_dir === selectedTaskDir ? localState.localLoop : {};
const plannerFeedback = sameTaskState ? compactPlannerFeedback(localState.performanceReview) : {};

// Static description of the perf take-home problem and the simulated VLIW/SIMD ISA. This is what the
// planner/implementer agents optimize; it replaces the SOL-ExecBench definition.json/workload.jsonl.
const taskContract = [
	"# Perf take-home: minimize simulator cycles",
	"",
	"Optimize `KernelBuilder.build_kernel` in `perf_takehome.py` (the ONLY file you may edit).",
	"It emits instruction bundles for a simulated single-core VLIW/SIMD machine defined in `problem.py`.",
	"Score = total simulator cycles for do_kernel_test(forest_height=10, rounds=16, batch_size=256) on a",
	"FROZEN copy of the simulator (tests/frozen_problem.py), lower is better. Baseline = 147734 cycles.",
	"",
	"## What the kernel computes (reference_kernel / reference_kernel2 in problem.py)",
	"Batched tree traversal: for each of `rounds` rounds, for each of `batch_size` lanes:",
	"  idx = indices[i]; val = values[i]",
	"  val = myhash(val ^ tree.values[idx])",
	"  idx = 2*idx + (1 if val even else 2); if idx >= n_nodes: idx = 0",
	"  values[i] = val; indices[i] = idx",
	"Correctness is checked against reference output in memory (inp_values region).",
	"",
	"## Machine model (problem.py)",
	"- Per-cycle slot limits: alu=12, valu=6, load=2, store=2, flow=1, debug=64.",
	"- VLEN=8 (vector ops process 8 lanes), N_CORES=1, SCRATCH_SIZE=1536.",
	"- One cycle counts per bundle that has >=1 non-debug op; debug ops are free and ignored by the",
	"  submission simulator.",
	"",
	"## Optimization levers (all legitimate)",
	"- SIMD/vectorize with VALU across the 256 lanes (VLEN=8).",
	"- Pack many independent ops per bundle to exploit the slot limits (VLIW).",
	"- Unroll loops, hoist constants, batch/coalesce loads and stores, precompute hash constants once.",
	"- Shape/rounds-specialized instruction schedules are allowed.",
	"",
	"## Forbidden (reward hacking)",
	"- Do NOT edit problem.py, tests/, or frozen_problem.py.",
	"- Do NOT hard-code reference outputs, read frozen_problem results, or precompute per-seed answers.",
	"- Do NOT bypass the simulator or break the pause/yield contract required by the dev harness.",
].join("\n");

const context = {
	task_dir: selectedTaskDir,
	task_name: "kernel_opt",
	metric: "simulator_cycles",
	baseline_cycles: BASELINE,
	source_paths: {
		scored_file: "perf_takehome.py",
		reference: "problem.py",
		frozen_simulator: "tests/frozen_problem.py",
		submission_tests: "tests/submission_tests.py",
		candidates: path.join(selectedTaskDir, "candidates.jsonl"),
		benchmark: path.join(selectedTaskDir, "benchmark.csv"),
		plan: path.join(selectedTaskDir, "docs", "plan.md"),
	},
	task_contract: taskContract,
	validation_command:
		"python3 -c '<frozen-simulator measure>'  (run by the validateKernel node; do not invoke run_h800_task.py)",
	editable_files: ["perf_takehome.py"],
	protected_files: ["problem.py", "tests/", "tests/frozen_problem.py", "tests/submission_tests.py"],
	current_best_unfinished: currentBest ? compactCandidate(currentBest) : null,
	candidate_tail: candidates.slice(-3).map(compactCandidate),
	benchmark_tail: benchmarkCsv.split(/\r?\n/u).filter((line) => line.trim()).slice(-4),
	planner_feedback: plannerFeedback,
	local_loop: compactLocalLoop(sameTaskLocalLoop),
	detail_paths: {
		task_docs: {
			docs_dir: path.join(selectedTaskDir, "docs"),
			draft_plan: path.join(selectedTaskDir, "docs", "draft.md"),
			plan: path.join(selectedTaskDir, "docs", "plan.md"),
			final_plan: path.join(selectedTaskDir, "docs", "final_plan.md"),
		},
		candidate_evidence: {
			candidates: path.join(selectedTaskDir, "candidates.jsonl"),
			benchmark: path.join(selectedTaskDir, "benchmark.csv"),
			current_best_summary: currentBest?.artifact ? path.join(selectedTaskDir, currentBest.artifact.replace(new RegExp(`^${selectedTaskDir}/`, "u"), "")) : "",
		},
		workflow_outputs: {
			task_context: path.join("workflow-output", "task-context.json"),
			latest_validation: path.join("workflow-output", "validate-kernel.json"),
		},
	},
	context_policy: {
		note: "Read source_paths.scored_file and reference for exact ISA/semantics. Only perf_takehome.py is editable.",
	},
	workflow_mode: { worker_lane: lane, forced_task_dir: selectedTaskDir },
};

const outputDir = laneOutputDir(path, root, lane, selectedTaskDir);
await fs.mkdir(outputDir, { recursive: true });
const contextPath = path.join(outputDir, "task-context.json");
await fs.writeFile(contextPath, JSON.stringify(context, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}compacted context for ${selectedTaskDir} (perf take-home)`,
	data: { task_dir: selectedTaskDir, metric: "simulator_cycles", lane },
	statePatch: [lanePatch(lane, "taskContext", compactContextForState(context, contextPath))],
	artifacts: [`local://${path.relative(root, contextPath)}`],
};

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

async function readJsonl(filePath) {
	const text = await readText(filePath, "");
	return text
		.split(/\r?\n/u)
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { raw: line.slice(0, 1000) };
			}
		});
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read source path for full text]`;
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
		artifact: row.artifact ?? "",
		cycles: metric(row, "cycles", "median_ms", "p50_ms"),
		speedup: row.speedup ?? null,
		passed: row.passed ?? null,
		total: row.total ?? null,
		model: row.model ?? "",
		notes: excerpt(row.notes ?? "", 300),
		promoted_at: row.promoted_at ?? "",
	};
}

function bestPassedCandidate(rows) {
	return rows
		.filter((row) => isPassedCandidate(row) && Number.isFinite(metric(row, "cycles", "median_ms", "p50_ms")))
		.sort((a, b) => metric(a, "cycles", "median_ms", "p50_ms") - metric(b, "cycles", "median_ms", "p50_ms"))[0];
}

function isPassedCandidate(row) {
	if (!row || typeof row !== "object") return false;
	if (!["passed", "promoted"].includes(String(row.status ?? "").toLowerCase())) return false;
	const passed = Number(row.passed);
	const total = Number(row.total);
	if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) return passed === total;
	return Number.isFinite(metric(row, "cycles", "median_ms", "p50_ms"));
}

function metric(row, ...keys) {
	for (const key of keys) {
		const value = Number(row?.[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function compactPlannerFeedback(value) {
	if (!value) return {};
	const data = value.data && typeof value.data === "object" ? value.data : value;
	const remainingExperiments = Array.isArray(data.remaining_experiments)
		? data.remaining_experiments.slice(0, 4).map((item) => excerpt(item, 260))
		: [];
	const reason = excerpt(data.reason ?? data.summary ?? value.summary ?? "", 900);
	return {
		source: "performanceReview",
		verdict: data.verdict ?? data.decision ?? "",
		optimization_limit_reached: Boolean(data.optimization_limit_reached),
		blocking_reason: reason,
		next_experiments: remainingExperiments,
		must_do_next: remainingExperiments[0] ?? (reason ? "Address the latest performance-review blocking reason." : ""),
	};
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
		metric: context.metric,
		baseline_cycles: context.baseline_cycles,
		context_file: path.relative(root, contextPath),
		source_paths: context.source_paths,
		task_contract: excerpt(context.task_contract, 3000),
		validation_command: context.validation_command,
		editable_files: context.editable_files,
		protected_files: context.protected_files,
		current_best_unfinished: context.current_best_unfinished,
		candidate_tail: Array.isArray(context.candidate_tail) ? context.candidate_tail.slice(-2) : [],
		benchmark_tail: Array.isArray(context.benchmark_tail) ? context.benchmark_tail.slice(-2) : [],
		planner_feedback: context.planner_feedback,
		local_loop: context.local_loop,
		detail_paths: context.detail_paths,
		context_policy: context.context_policy,
		workflow_mode: context.workflow_mode,
	};
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}
