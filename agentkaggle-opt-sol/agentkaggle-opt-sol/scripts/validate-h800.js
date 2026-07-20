// Kaggle local validation (filename kept from the kernel fork for graph
// compatibility). Runs inside the task's writable run instance:
//   deps install (once) -> integrity check -> local_eval (inside the capacity-2
//   GPU pool) -> parse solution/local_score.json -> integrity re-check ->
//   candidate snapshot + scoreboard row.
// Emits the validation contract the graph edges depend on:
//   status ("passed"/"failed"/"skipped"/"parked_after_validation_limit"),
//   repair_exhausted, validation_failure_count, stdout_tail/stderr_tail, metrics.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	costOf,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	readJsonSafe,
	scoreNumberForMetric,
	taskArtifactDir,
	withGpuPool,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const { hashSolutionTree, hashSubmissionPayload } = await import(
	`file://${path.join(resourceRoot, "scripts", "submission-hash.js")}`
);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir;
if (!taskDirRel) throw new Error("validation requires /taskContext.task_dir");
const instanceDir = taskContext.instance_dir ?? "";
const editFile = taskContext.edit_file ?? "";
const objective = taskContext.objective ?? {};
const higherIsBetter = Boolean(objective.higher_is_better);
const metricName = objective.metric ?? "";
const validationMode = objective.validation_mode ?? "local";
const previousValidation = localState.validation?.task_dir === taskDirRel ? localState.validation : {};
const previousFailureCount =
	previousValidation.status && previousValidation.status !== "passed"
		? Number(previousValidation.validation_failure_count ?? 0) || 0
		: 0;
const maxValidationFailures = parsePositiveInt(process.env.SOL_H800_VALIDATION_MAX_FAILURES, 3);
// Node timeout is capped at 1h by the omh schema; keep the eval timeout under it.
const evalTimeoutMs = parsePositiveInt(process.env.SOL_H800_VALIDATION_TIMEOUT_S, 3000) * 1000;

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const validationOutputPath = path.join(outputDir, "validate-h800.json");
const artifactDir = taskArtifactDir(path, root, taskDirRel);
await fs.mkdir(artifactDir, { recursive: true });

const solutionPath = instanceDir && editFile ? path.join(instanceDir, "solution", editFile) : "";
if (!instanceDir || !editFile || !(await exists(solutionPath))) {
	const skipped = {
		status: "skipped",
		reason: !instanceDir
			? "no run instance materialized for this task"
			: `instance solution/${editFile || "?"} does not exist yet`,
		task_dir: taskDirRel,
		solution: editFile,
		validation_failure_count: previousFailureCount + 1,
	};
	maybeMarkRepairExhausted(skipped);
	if (skipped.repair_exhausted) await appendValidationExhaustedCandidate(skipped);
	await fs.writeFile(validationOutputPath, JSON.stringify(skipped, null, 2) + "\n");
	const compactSkipped = compactValidation(skipped, validationOutputPath);
	return {
		summary: `${lane ? `slot ${lane}: ` : ""}skipped validation for ${taskDirRel}: ${skipped.reason}`,
		data: compactSkipped,
		statePatch: [lanePatch(lane, "validation", compactSkipped)],
		artifacts: [`local://${path.relative(root, validationOutputPath)}`],
	};
}

const candidate = `workflow_${new Date().toISOString().replace(/[-:T.Z]/gu, "")}_${lane || "X"}`;

// 1. Instance dependencies (idempotent; marker caches success).
const depsMarker = path.join(instanceDir, ".agk-deps-installed");
let depsResult = { exitCode: 0, stdout: "cached", stderr: "" };
if (!(await exists(depsMarker))) {
	depsResult = await run(["python3", "-m", "pip", "install", "--quiet", "-r", "requirements.txt"], instanceDir, 900000);
	if (depsResult.exitCode === 0) await fs.writeFile(depsMarker, new Date().toISOString() + "\n");
}

// 2. Integrity before evaluation.
const integrityBefore = await run(["python3", "evaluation/check_integrity.py"], instanceDir, 300000);

let result;
if (depsResult.exitCode !== 0) {
	result = failure("deps", `pip install -r requirements.txt failed`, depsResult);
} else if (integrityBefore.exitCode !== 0) {
	result = failure("integrity", "check_integrity failed before evaluation — protected files changed", integrityBefore);
} else {
	// 3. Local evaluation inside the capacity-2 GPU pool.
	const configuredEval =
		metricName === "santa_2023_move_score" && (await exists(path.join(instanceDir, "solution", "submission.csv")))
			? "python evaluation/local_eval.py --no-run --submission solution/submission.csv"
			: metricName === "neurogolf_points"
				? String(taskContext.commands?.local_eval_full ?? "python evaluation/local_eval.py")
			: String(taskContext.commands?.local_eval_fast ?? "python evaluation/local_eval.py");
	const evalArgs = configuredEval
		.replace(/^python3?\s+/u, "")
		.split(/\s+/u)
		.filter(Boolean);
	const command = ["python3", ...evalArgs];
	const started = Date.now();
	const evalRun = await withGpuPool(
		fs,
		path,
		root,
		{ lane, task_dir: taskDirRel, kind: "local-eval", candidate },
		async (slot) => run(command, instanceDir, evalTimeoutMs, { CUDA_VISIBLE_DEVICES: String(slot) }),
		{ staleMs: 3 * 60 * 60 * 1000, retryMs: 3000 },
	);
	const evalSeconds = Math.round((Date.now() - started) / 1000);

	// 4. Parse the harness-written score file.
	const scoreData = await readJsonSafe(fs, path.join(instanceDir, "solution", "local_score.json"), null);
	const score = scoreNumberForMetric(scoreData, metricName);

	// 5. Integrity after evaluation.
	const integrityAfter = await run(["python3", "evaluation/check_integrity.py"], instanceDir, 300000);

	if (evalRun.exitCode !== 0) {
		result = failure("eval", "local_eval exited non-zero", evalRun);
		} else if (score === null && validationMode !== "remote_only") {
			result = failure("score", "local_eval produced no parseable solution/local_score.json", evalRun);
	} else if (integrityAfter.exitCode !== 0) {
		result = failure("integrity", "check_integrity failed AFTER evaluation — the candidate touched protected files", integrityAfter);
	} else {
		result = {
			status: "passed",
			exitCode: 0,
			command: command.join(" "),
			task_dir: taskDirRel,
			solution: editFile,
			candidate,
			stdout_tail: tail(evalRun.stdout, 6000),
			stderr_tail: tail(evalRun.stderr, 6000),
			validation_failure_count: 0,
			metrics: {
				status: "passed",
				passed: 1,
				total: 1,
					score,
					cost: score === null ? null : costOf(score, higherIsBetter),
				metric: scoreData?.metric ?? metricName,
				higher_is_better: higherIsBetter,
					mode: validationMode === "remote_only" ? "remote_only" : metricName === "neurogolf_points" && scoreData?.official === true ? "full" : "fast",
				eval_seconds: evalSeconds,
				local_signal: objective.local_signal ?? "strong",
				subset: scoreData?.subset ?? null,
				official: scoreData?.official ?? null,
				n_tasks: scoreData?.n_tasks ?? null,
				solved: scoreData?.solved ?? null,
			},
		};
		// 6. Candidate snapshot + scoreboard row (campaign artifacts).
		result.summary_path = await snapshotCandidate(result);
		await appendScoreboard(result, evalSeconds);
	}
}

maybeMarkRepairExhausted(result);
if (result.repair_exhausted) await appendValidationExhaustedCandidate(result);
await fs.writeFile(validationOutputPath, JSON.stringify(result, null, 2) + "\n");
const compactResult = compactValidation(result, validationOutputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}local validation ${result.status} for ${taskDirRel}${
		result.metrics?.score !== undefined && result.metrics?.score !== null ? ` (${result.metrics.metric}=${result.metrics.score})` : ""
	}`,
	data: compactResult,
	statePatch: [lanePatch(lane, "validation", compactResult)],
	artifacts: [`local://${path.relative(root, validationOutputPath)}`],
};

function failure(kind, reason, procResult) {
	return {
		status: "failed",
		exitCode: procResult.exitCode,
		command: (procResult.cmd ?? []).join(" "),
		task_dir: taskDirRel,
		solution: editFile,
		candidate,
		reason: `${kind}: ${reason}`,
		stdout_tail: tail(procResult.stdout ?? "", 6000),
		stderr_tail: tail(procResult.stderr ?? "", 6000),
		validation_failure_count: previousFailureCount + 1,
		metrics: { status: "failed" },
	};
}

async function snapshotCandidate(result) {
	try {
		const candDir = path.join(artifactDir, "candidates", result.candidate);
		await fs.mkdir(candDir, { recursive: true });
		const sourceSolution = path.join(instanceDir, "solution");
		const snapshotSolution = path.join(candDir, "solution");
		await fs.rm(snapshotSolution, { recursive: true, force: true });
		await fs.cp(sourceSolution, snapshotSolution, { recursive: true });
		result.solution_hash = await hashSolutionTree(fs, path, sourceSolution);
		result.submission_hash = await hashSubmissionPayload(fs, path, sourceSolution, taskContext.submissions ?? {});
		const scoreFile = path.join(instanceDir, "solution", "local_score.json");
		if (await exists(scoreFile)) await fs.copyFile(scoreFile, path.join(candDir, "local_score.json"));
		await fs.writeFile(
			path.join(candDir, "validation.json"),
			JSON.stringify({ ...result, stdout_tail: tail(result.stdout_tail, 2000), stderr_tail: tail(result.stderr_tail, 2000) }, null, 2) + "\n",
		);
		return path.relative(root, candDir);
	} catch {
		return "";
	}
}

async function appendScoreboard(result, evalSeconds) {
	const row = {
		ts: new Date().toISOString(),
		lane,
		candidate: result.candidate,
		phase: "local_eval",
		metric: result.metrics.metric,
		score: result.metrics.score,
		cost: result.metrics.cost,
		higher_is_better: result.metrics.higher_is_better,
		mode: result.metrics.mode,
		eval_seconds: evalSeconds,
		integrity: "ok",
		snapshot: result.summary_path ?? "",
	};
	await fs.appendFile(path.join(artifactDir, "scoreboard.jsonl"), JSON.stringify(row) + "\n");
}

async function run(cmd, cwd, timeoutMs, extraEnv = {}) {
	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...extraEnv },
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				/* already exited */
			}
		}, timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		return {
			cmd,
			exitCode: timedOut ? -2 : exitCode,
			stdout,
			stderr: timedOut ? `${stderr}\n[killed after ${Math.round(timeoutMs / 1000)}s timeout]` : stderr,
		};
	} catch (error) {
		return { cmd, exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function tail(text, maxChars) {
	const value = String(text ?? "");
	return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function compactValidation(result, outputPath) {
	return {
		status: result.status,
		exitCode: result.exitCode ?? null,
		command: result.command ?? "",
		task_dir: result.task_dir,
		instance_dir: instanceDir,
		solution: result.solution,
		candidate: result.candidate ?? "",
		reason: result.reason ?? "",
		detail_file: outputPath ? path.relative(root, outputPath) : "",
		summary_path: result.summary_path ?? "",
			solution_hash: result.solution_hash ?? "",
			submission_hash: result.submission_hash ?? "",
		validation_failure_count: result.validation_failure_count ?? 0,
		validation_max_failures: result.validation_max_failures ?? maxValidationFailures,
		repair_exhausted: Boolean(result.repair_exhausted),
		stdout_tail: tail(result.stdout_tail ?? "", 1200),
		stderr_tail: tail(result.stderr_tail ?? "", 1600),
		metrics: {
			status: result.metrics?.status,
			passed: result.metrics?.passed ?? null,
			total: result.metrics?.total ?? null,
			score: result.metrics?.score ?? null,
			cost: result.metrics?.cost ?? null,
			metric: result.metrics?.metric ?? "",
			higher_is_better: result.metrics?.higher_is_better ?? null,
			mode: result.metrics?.mode ?? "",
			eval_seconds: result.metrics?.eval_seconds ?? null,
			local_signal: result.metrics?.local_signal ?? "",
			subset: result.metrics?.subset ?? null,
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
	const candidatesPath = path.join(artifactDir, "candidates.jsonl");
	const row = {
		candidate: result.candidate ?? `validation_failed_${Date.now()}`,
		status: "failed",
		promotion_decision: "parked_after_validation_limit",
		local_loop_exhausted: true,
		local_loop_status: "parked_after_validation_limit",
		local_loop_round: result.validation_failure_count ?? maxValidationFailures,
		local_loop_max_rounds: maxValidationFailures,
		solution: result.solution ?? editFile,
		artifact: result.summary_path ?? "",
		score: result.metrics?.score ?? null,
		cost: result.metrics?.cost ?? null,
		metric_name: result.metrics?.metric ?? metricName,
		notes: `Parked by workflow after ${result.validation_failure_count ?? maxValidationFailures}/${maxValidationFailures} validation failures`,
		recorded_at: new Date().toISOString(),
	};
	await fs.appendFile(candidatesPath, JSON.stringify(row) + "\n");
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
