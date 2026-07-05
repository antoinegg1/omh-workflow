const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState, withFileLock } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir;
if (!taskDirRel) throw new Error("validate-h800 requires /taskContext.task_dir");
const taskDir = path.join(root, taskDirRel);
const previousValidation = localState.validation?.task_dir === taskDirRel ? localState.validation : {};
const previousFailureCount =
	previousValidation.status && previousValidation.status !== "passed"
		? Number(previousValidation.validation_failure_count ?? 0) || 0
		: 0;
const maxValidationFailures = parsePositiveInt(process.env.SOL_H800_VALIDATION_MAX_FAILURES, 3);
const solutionName = (await exists(path.join(taskDir, "solution.json")))
	? "solution.json"
	: (await exists(path.join(taskDir, "solution.py")))
		? "solution.py"
		: "";

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const validationOutputPath = path.join(outputDir, "validate-h800.json");

if (!solutionName) {
	const skipped = {
		status: "skipped",
		reason: "no solution.json or solution.py exists yet",
		task_dir: taskDirRel,
		validation_failure_count: previousFailureCount + 1,
	};
	maybeMarkRepairExhausted(skipped);
	if (skipped.repair_exhausted) await appendValidationExhaustedCandidate(skipped);
	await fs.writeFile(validationOutputPath, JSON.stringify(skipped, null, 2) + "\n");
	const compactSkipped = compactValidation(skipped, validationOutputPath);
	return {
		summary: `${lane ? `slot ${lane}: ` : ""}skipped H800 validation for ${taskDirRel}: no solution yet`,
		data: compactSkipped,
		statePatch: [lanePatch(lane, "validation", compactSkipped)],
		artifacts: [`local://${path.relative(root, validationOutputPath)}`],
	};
}

const candidate = `workflow_${new Date().toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14)}`;
const command = [
	"python3",
	"scripts/run_h800_task.py",
	taskDirRel,
	"--solution-name",
	solutionName,
	"--candidate",
	candidate,
	"--model",
	"infini/gpt-5.5:xhigh",
];
if (process.env.SOL_H800_VALIDATION_ITERATIONS) {
	command.push("--iterations", process.env.SOL_H800_VALIDATION_ITERATIONS);
}
if (process.env.SOL_H800_MAX_WORKLOADS) {
	command.push("--max-workloads", process.env.SOL_H800_MAX_WORKLOADS);
}

const lockDir = path.join(root, "workflow-output", "locks", "h800-validation");
const { result, latestSummary } = await withFileLock(
	fs,
	path,
	lockDir,
	{ lane, task_dir: taskDirRel, kind: "h800-validation" },
	async () => {
		const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		const latestSummary = await newestFile(path.join(taskDir, "runs", "h800"), "h800_latency_summary.json");
		const summary = latestSummary ? await readJson(latestSummary, {}) : {};
		return {
			latestSummary,
			result: {
				status: exitCode === 0 ? "passed" : "failed",
				exitCode,
				command: command.join(" "),
				task_dir: taskDirRel,
				solution: solutionName,
				candidate,
				stdout_tail: tail(stdout, 6000),
				stderr_tail: tail(stderr, 6000),
				summary_path: latestSummary ? path.relative(root, latestSummary) : "",
				metrics: summary,
				validation_failure_count: exitCode === 0 ? 0 : previousFailureCount + 1,
			},
		};
	},
	{ staleMs: 6 * 60 * 60 * 1000, retryMs: 3000 },
);

maybeMarkRepairExhausted(result);
if (result.repair_exhausted) await appendValidationExhaustedCandidate(result);
await fs.writeFile(validationOutputPath, JSON.stringify(result, null, 2) + "\n");
const compactResult = compactValidation(result, validationOutputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}H800 validation ${result.status} for ${taskDirRel} (${solutionName})`,
	data: compactResult,
	statePatch: [lanePatch(lane, "validation", compactResult)],
	artifacts: [`local://${path.relative(root, validationOutputPath)}`].concat(latestSummary ? [`local://${path.relative(root, latestSummary)}`] : []),
};

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function newestFile(dir, basename) {
	const matches = [];
	await walk(dir, async (filePath) => {
		if (path.basename(filePath) === basename) matches.push(filePath);
	});
	if (matches.length === 0) return "";
	const stats = await Promise.all(matches.map(async (filePath) => ({ filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs })));
	stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return stats[0].filePath;
}

async function walk(dir, visit) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) await walk(filePath, visit);
		else if (entry.isFile()) await visit(filePath);
	}
}

async function readJson(filePath, fallback) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return fallback;
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
			median_ms: result.metrics?.median_ms,
			mean_ms: result.metrics?.mean_ms,
			p90_ms: result.metrics?.p90_ms,
			max_ms: result.metrics?.max_ms,
			min_ms: result.metrics?.min_ms,
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
		candidate: result.candidate ?? `validation_failed_${Date.now()}`,
		status: "failed",
		promotion_decision: "parked_after_validation_limit",
		local_loop_exhausted: true,
		local_loop_status: "parked_after_validation_limit",
		local_loop_round: result.validation_failure_count ?? maxValidationFailures,
		local_loop_max_rounds: maxValidationFailures,
		solution: result.solution ?? solutionName,
		artifact: result.summary_path ?? "",
		passed: result.metrics?.passed ?? null,
		total: result.metrics?.total ?? null,
		model: "infini/gpt-5.5:xhigh",
		notes: `Parked by workflow after ${result.validation_failure_count ?? maxValidationFailures}/${maxValidationFailures} validation failures`,
		recorded_at: new Date().toISOString(),
	};
	await fs.appendFile(candidatesPath, JSON.stringify(row) + "\n");
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
