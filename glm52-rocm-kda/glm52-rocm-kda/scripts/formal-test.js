const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.env.GLM52_KDA_CAMPAIGN_ROOT || process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));

const task = process.env.GLM52_KDA_TASK || "";
const taskRow = task ? manifest.tasks.find((row) => row.operator_id === task) : null;
if (task && !taskRow) {
	throw new Error(`unknown GLM52_KDA_TASK: ${task}`);
}

const mode = process.env.GLM52_KDA_FORMAL_MODE || "smoke";
const canaryMode = mode === "canary-smoke" || mode === "canary-visible";
const lane = process.env.GLM52_KDA_LANE || taskRow?.lane || "manual";
const submission = process.env.GLM52_KDA_SUBMISSION || taskRow?.solution_dir || "";
if (!canaryMode && !submission) {
	throw new Error("GLM52_KDA_SUBMISSION is required when GLM52_KDA_TASK is not set");
}

const python = process.env.ROCM_TORCH_PYTHON ||
	(process.env.ROCM_TORCH_VENV ? `${process.env.ROCM_TORCH_VENV}/bin/python` : "/home/lichangye/venvs/rocm-torch/bin/python");

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const safeTask = task || "all";
const outDir = path.join(root, "workflow-output", "formal-tests", "lanes", lane, safeTask);
await fs.mkdir(outDir, { recursive: true });

const jsonOut = path.join(outDir, `${stamp}-${mode}.formal-result.json`);
const stdoutPath = path.join(outDir, `${stamp}-${mode}.stdout.log`);
const stderrPath = path.join(outDir, `${stamp}-${mode}.stderr.log`);
const summaryPath = path.join(outDir, "latest-summary.json");

const args = [
	python,
	"tools/formal_eval.py",
	"--root",
	root,
	"--json-out",
	jsonOut,
];

if (task) {
	args.push("--task", task);
}
if (canaryMode) {
	args.push("--canary");
} else {
	args.push("--submission", submission);
}

const defaults = modeDefaults(mode);
applyModeArgs(args, defaults);
applyEnvOverrides(args);
appendExtraArgs(args, process.env.GLM52_KDA_FORMAL_EXTRA_ARGS || "");

const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);

await fs.writeFile(stdoutPath, stdout);
await fs.writeFile(stderrPath, stderr);

let data = null;
let parseError = "";
try {
	data = JSON.parse(await fs.readFile(jsonOut, "utf8"));
} catch (exc) {
	parseError = `${exc}`;
	try {
		data = JSON.parse(stdout);
	} catch {
		data = {
			status: exitCode === 0 ? "passed" : "infra_failed",
			exit_code: exitCode,
			parse_error: parseError,
			stdout_tail: stdout.slice(-2000),
			stderr_tail: stderr.slice(-2000),
		};
	}
}

const compact = compactResult(data, {
	root,
	task,
	lane,
	mode,
	submission,
	exitCode,
	command: args,
	artifacts: {
		formal_result: jsonOut,
		stdout: stdoutPath,
		stderr: stderrPath,
	},
});
await fs.writeFile(summaryPath, JSON.stringify(compact, null, 2) + "\n");
const inline = inlineResult(compact, summaryPath, jsonOut);

if (truthy(process.env.GLM52_KDA_FORMAL_THROW_ON_FAIL) && exitCode !== 0) {
	throw new Error(`formal test failed: task=${task || "all"} mode=${mode} status=${compact.status} exit=${exitCode}`);
}

return {
	summary: `formal ${mode} ${inline.status} for ${task || "all"}: ${inline.correct_cases}/${inline.case_count} correct, ${inline.passed_cases} passed`,
	data: inline,
	statePatch: [
		{ op: "set", path: `/lanes/${lane}/formalTests/latest`, value: inline },
	],
	artifacts: [
		`local://${path.relative(root, summaryPath)}`,
		`local://${path.relative(root, jsonOut)}`,
	],
};

function modeDefaults(selectedMode) {
	switch (selectedMode) {
		case "smoke":
			return { smoke: true };
		case "visible-probe":
			return { repeat: 1, iterations: 1, warmup: 0, noGpuLock: true };
		case "shape":
			return { repeat: 1, iterations: 1, warmup: 0, noGpuLock: true };
		case "full":
			return {};
		case "canary-smoke":
			return { smoke: true };
		case "canary-visible":
			return { repeat: 1, iterations: 1, warmup: 0, noGpuLock: true };
		default:
			throw new Error(`unknown GLM52_KDA_FORMAL_MODE: ${selectedMode}`);
	}
}

function applyModeArgs(argv, defaults) {
	if (defaults.smoke) {
		argv.push("--smoke");
	}
	if (mode === "shape" && !process.env.GLM52_KDA_M) {
		throw new Error("GLM52_KDA_M is required when GLM52_KDA_FORMAL_MODE=shape");
	}
	if (mode === "shape") {
		argv.push("--M", String(process.env.GLM52_KDA_M));
	}
	if (defaults.repeat !== undefined) {
		argv.push("--repeat", String(defaults.repeat));
	}
	if (defaults.iterations !== undefined) {
		argv.push("--iterations", String(defaults.iterations));
	}
	if (defaults.warmup !== undefined) {
		argv.push("--warmup", String(defaults.warmup));
	}
	if (defaults.noGpuLock) {
		argv.push("--no-gpu-lock");
	}
}

function applyEnvOverrides(argv) {
	addOpt(argv, "--M", process.env.GLM52_KDA_M, mode !== "shape");
	addOpt(argv, "--repeat", process.env.GLM52_KDA_REPEAT);
	addOpt(argv, "--iterations", process.env.GLM52_KDA_ITERATIONS);
	addOpt(argv, "--warmup", process.env.GLM52_KDA_WARMUP);
	addOpt(argv, "--device", process.env.GLM52_KDA_DEVICE);
	if (truthy(process.env.GLM52_KDA_NO_GPU_LOCK) && !argv.includes("--no-gpu-lock")) {
		argv.push("--no-gpu-lock");
	}
}

function addOpt(argv, flag, value, enabled = true) {
	if (enabled && value !== undefined && value !== "") {
		argv.push(flag, String(value));
	}
}

function appendExtraArgs(argv, extra) {
	if (!extra.trim()) {
		return;
	}
	for (const part of extra.trim().split(/\s+/u)) {
		argv.push(part);
	}
}

function truthy(value) {
	return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function compactResult(data, meta) {
	const tasks = (data.tasks || []).map((taskResult) => ({
		operator_id: taskResult.operator_id,
		status: taskResult.status,
		aggregate: taskResult.aggregate,
		cases: (taskResult.cases || []).map((caseResult) => {
			const perShape = caseResult.result?.per_shape || [];
			return {
				harness_task: caseResult.harness_task,
				harness_operator: caseResult.harness_operator,
				phase: caseResult.phase,
				score_scope: caseResult.score_scope,
				metric_group: caseResult.metric_group,
				metric_component: caseResult.metric_component,
				production_equivalent: caseResult.production_equivalent,
				performance_required: caseResult.performance_required,
				status: caseResult.status,
				correct: caseResult.correct,
				performance_ok: caseResult.performance_ok,
				modification_protection: caseResult.modification_protection,
				shapes: perShape.map((shape) => ({
					uuid: shape.uuid,
					axes: shape.axes,
					correct: shape.correct,
					shape_verdict: shape.shape_verdict,
					speedup: shape.speedup,
						speedup_conservative: shape.speedup_conservative,
						candidate_us: shape.candidate_us,
						reference_us: shape.reference_us,
						reward: shape.reward,
						bound: shape.bound,
						metric_resource: shape.metric_resource,
						candidate_primary_util: shape.candidate_primary_util,
						reference_primary_util: shape.reference_primary_util,
						primary_util_ratio: shape.primary_util_ratio,
						primary_util_ratio_conservative: shape.primary_util_ratio_conservative,
						primary_util_ratio_optimistic: shape.primary_util_ratio_optimistic,
						candidate_tflops: shape.candidate_tflops,
						reference_tflops: shape.reference_tflops,
						candidate_mfu: shape.candidate_mfu,
						reference_mfu: shape.reference_mfu,
						candidate_bw_gbps: shape.candidate_bw_gbps,
						reference_bw_gbps: shape.reference_bw_gbps,
						candidate_bw_util: shape.candidate_bw_util,
						reference_bw_util: shape.reference_bw_util,
						timing_unstable: shape.timing_unstable,
					})),
			};
		}),
	}));
	const aggregate = data.aggregate || {};
	return {
		version: 1,
		root: meta.root,
		lane: meta.lane,
		task: meta.task || "all",
		mode: meta.mode,
		submission: meta.submission || null,
		status: data.status || "unknown",
		exit_code: data.exit_code ?? meta.exitCode,
		backend: data.backend || null,
		aggregate,
		case_count: aggregate.case_count ?? tasks.reduce((sum, row) => sum + (row.aggregate?.case_count || 0), 0),
		correct_cases: aggregate.correct_cases ?? 0,
		passed_cases: aggregate.passed_cases ?? 0,
		incorrect_cases: aggregate.incorrect_cases ?? 0,
		infra_failed_cases: aggregate.infra_failed_cases ?? 0,
		tasks,
		command: meta.command,
		artifacts: meta.artifacts,
		created_at: new Date().toISOString(),
	};
}

function inlineResult(compact, summaryPath, formalResultPath) {
	return {
		version: compact.version,
		root: compact.root,
		lane: compact.lane,
		task: compact.task,
		mode: compact.mode,
		status: compact.status,
		exit_code: compact.exit_code,
		backend: compact.backend,
		aggregate: compact.aggregate,
		case_count: compact.case_count,
		correct_cases: compact.correct_cases,
		passed_cases: compact.passed_cases,
		incorrect_cases: compact.incorrect_cases,
		infra_failed_cases: compact.infra_failed_cases,
		tasks: compact.tasks.map((taskResult) => ({
			operator_id: taskResult.operator_id,
			status: taskResult.status,
			aggregate: taskResult.aggregate,
			cases: taskResult.cases.map((caseResult) => ({
				harness_task: caseResult.harness_task,
				score_scope: caseResult.score_scope,
				performance_required: caseResult.performance_required,
				status: caseResult.status,
				correct: caseResult.correct,
				performance_ok: caseResult.performance_ok,
				modification_protection_ok: caseResult.modification_protection?.ok ?? null,
				shape_count: caseResult.shapes.length,
				wins: caseResult.shapes.filter((shape) => shape.shape_verdict === "win").length,
				regressions: caseResult.shapes.filter((shape) => shape.shape_verdict === "regress").length,
				neutral: caseResult.shapes.filter((shape) => shape.shape_verdict === "neutral").length,
			})),
		})),
		artifacts: {
			latest_summary: summaryPath,
			formal_result: formalResultPath,
		},
		created_at: compact.created_at,
	};
}
