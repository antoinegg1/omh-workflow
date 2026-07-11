const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir || "tasks/kernel_opt";
const taskDir = path.join(root, taskDirRel);

const BASELINE = 147734;
// Threshold ladder from tests/submission_tests.py (candidate must be strictly under each).
const THRESHOLDS = [147734, 18532, 2164, 1790, 1579, 1548, 1487, 1363];

const previousValidation = localState.validation?.task_dir === taskDirRel ? localState.validation : {};
const previousFailureCount =
	previousValidation.status && previousValidation.status !== "passed"
		? Number(previousValidation.validation_failure_count ?? 0) || 0
		: 0;
const maxValidationFailures = parsePositiveInt(process.env.SOL_H800_VALIDATION_MAX_FAILURES, 3);

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const validationOutputPath = path.join(outputDir, "validate-kernel.json");

const candidate = `workflow_${new Date().toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14)}`;

// Measure against the FROZEN simulator, exactly mirroring tests/submission_tests.py::do_kernel_test
// (forest_height=10, rounds=16, batch_size=256). Read-only: imports the reference/frozen modules and
// perf_takehome.KernelBuilder without modifying any file under tests/.
const pyMeasure = [
	"import sys, json, random",
	'sys.path.insert(0, "tests")',
	'sys.path.insert(0, ".")',
	"random.seed(12345)",
	"from frozen_problem import Machine, build_mem_image, reference_kernel2, Tree, Input, N_CORES",
	"from perf_takehome import KernelBuilder",
	"fh, rounds, bs = 10, 16, 256",
	"forest = Tree.generate(fh)",
	"inp = Input.generate(forest, bs, rounds)",
	"mem = build_mem_image(forest, inp)",
	"kb = KernelBuilder()",
	"kb.build_kernel(forest.height, len(forest.values), len(inp.indices), rounds)",
	"machine = Machine(mem, kb.instrs, kb.debug_info(), n_cores=N_CORES)",
	"machine.enable_pause = False",
	"machine.enable_debug = False",
	"machine.run()",
	"ref_mem = None",
	"for ref_mem in reference_kernel2(mem):",
	"    pass",
	"ivp = ref_mem[6]",
	"correct = machine.mem[ivp:ivp+len(inp.values)] == ref_mem[ivp:ivp+len(inp.values)]",
	'print("RESULT_JSON:" + json.dumps({"cycles": machine.cycle, "correct": bool(correct)}))',
].join("\n");

const command = ["python3", "-c", pyMeasure];
const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);

const parsed = parseResult(stdout);
let status;
let metrics;
let reason = "";
if (exitCode !== 0 || !parsed) {
	status = "failed";
	reason = `simulator run failed (exit ${exitCode})`;
	metrics = { status: "failed", total: 1, passed: 0, cycles: null, median_ms: null };
} else if (!parsed.correct) {
	status = "failed";
	reason = "kernel output does not match the reference on the frozen simulator";
	metrics = { status: "failed", total: 1, passed: 0, cycles: parsed.cycles, median_ms: parsed.cycles };
} else {
	status = "passed";
	const cycles = parsed.cycles;
	const thresholdsPassed = THRESHOLDS.filter((t) => cycles < t).length;
	metrics = {
		status: "passed",
		total: 1,
		passed: 1,
		cycles,
		// Cycles mirrored into the latency fields so downstream best-candidate/leaderboard sorting
		// (which orders by median_ms ascending) selects the fewest-cycles candidate.
		median_ms: cycles,
		mean_ms: cycles,
		p90_ms: cycles,
		max_ms: cycles,
		min_ms: cycles,
		speedup: BASELINE / cycles,
		baseline: BASELINE,
		thresholds_passed: thresholdsPassed,
		timing_adapter: "frozen_simulator_cycles",
	};
	reason = `correct; ${cycles} cycles (speedup ${(BASELINE / cycles).toFixed(2)}x, ${thresholdsPassed}/${THRESHOLDS.length} thresholds)`;
}

// Also write a summary artifact so downstream scripts have a stable summary_path to reference.
const runTag = new Date().toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14);
const summaryDir = path.join(taskDir, "runs", runTag);
await fs.mkdir(summaryDir, { recursive: true });
const summaryPath = path.join(summaryDir, "cycles_summary.json");
await fs.writeFile(summaryPath, JSON.stringify({ candidate, status, ...metrics }, null, 2) + "\n");

const result = {
	status,
	exitCode,
	command: "python3 -c '<frozen-simulator measure: forest_height=10 rounds=16 batch_size=256>'",
	task_dir: taskDirRel,
	solution: "perf_takehome.py",
	candidate,
	reason,
	stdout_tail: tail(stdout, 4000),
	stderr_tail: tail(stderr, 4000),
	summary_path: path.relative(root, summaryPath),
	metrics,
	validation_failure_count: status === "passed" ? 0 : previousFailureCount + 1,
};

maybeMarkRepairExhausted(result);
if (result.repair_exhausted) await appendValidationExhaustedCandidate(result);
await fs.writeFile(validationOutputPath, JSON.stringify(result, null, 2) + "\n");
const compactResult = compactValidation(result, validationOutputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}kernel validation ${result.status} for ${taskDirRel}: ${reason}`,
	data: compactResult,
	statePatch: [lanePatch(lane, "validation", compactResult)],
	artifacts: [`local://${path.relative(root, validationOutputPath)}`, `local://${path.relative(root, summaryPath)}`],
};

function parseResult(text) {
	const line = text.split(/\r?\n/u).find((l) => l.startsWith("RESULT_JSON:"));
	if (!line) return null;
	try {
		return JSON.parse(line.slice("RESULT_JSON:".length));
	} catch {
		return null;
	}
}

function tail(text, maxChars) {
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function compactValidation(result, outputPath) {
	return {
		status: result.status,
		exitCode: result.exitCode,
		command: result.command,
		task_dir: result.task_dir,
		solution: result.solution,
		candidate: result.candidate,
		reason: result.reason ?? "",
		detail_file: outputPath ? path.relative(root, outputPath) : "",
		summary_path: result.summary_path,
		validation_failure_count: result.validation_failure_count ?? 0,
		validation_max_failures: result.validation_max_failures ?? maxValidationFailures,
		repair_exhausted: Boolean(result.repair_exhausted),
		stdout_tail: tail(result.stdout_tail ?? "", 1200),
		stderr_tail: tail(result.stderr_tail ?? "", 1600),
		metrics: {
			status: result.metrics?.status,
			total: result.metrics?.total,
			passed: result.metrics?.passed,
			cycles: result.metrics?.cycles,
			median_ms: result.metrics?.median_ms,
			speedup: result.metrics?.speedup,
			thresholds_passed: result.metrics?.thresholds_passed,
			timing_adapter: result.metrics?.timing_adapter,
		},
	};
}

function maybeMarkRepairExhausted(result) {
	if (result.status === "passed") {
		result.repair_exhausted = false;
		result.validation_max_failures = maxValidationFailures;
		return;
	}
	result.validation_failure_count = Number(result.validation_failure_count ?? previousFailureCount + 1) || 1;
	result.validation_max_failures = maxValidationFailures;
	if (result.validation_failure_count >= maxValidationFailures) {
		result.status = "parked_after_validation_limit";
		result.repair_exhausted = true;
		result.reason = result.reason || `validation failed ${result.validation_failure_count}/${maxValidationFailures} times`;
	} else {
		result.repair_exhausted = false;
	}
}

async function appendValidationExhaustedCandidate(result) {
	const candidatesPath = path.join(root, taskDirRel, "candidates.jsonl");
	const row = {
		candidate: result.candidate ?? `validation_failed_${runTagSafe()}`,
		status: "failed",
		promotion_decision: "parked_after_validation_limit",
		local_loop_exhausted: true,
		local_loop_status: "parked_after_validation_limit",
		local_loop_round: result.validation_failure_count ?? maxValidationFailures,
		local_loop_max_rounds: maxValidationFailures,
		solution: result.solution ?? "perf_takehome.py",
		artifact: result.summary_path ?? "",
		passed: result.metrics?.passed ?? null,
		total: result.metrics?.total ?? null,
		model: "rustcat/gpt-5.5:xhigh",
		notes: `Parked by workflow after ${result.validation_failure_count ?? maxValidationFailures}/${maxValidationFailures} validation failures`,
		recorded_at: new Date().toISOString(),
	};
	await fs.mkdir(path.dirname(candidatesPath), { recursive: true });
	await fs.appendFile(candidatesPath, JSON.stringify(row) + "\n");
}

function runTagSafe() {
	return new Date().toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14);
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
