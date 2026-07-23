const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.env.GLM52_KDA_CAMPAIGN_ROOT || process.cwd();
const lane = process.env.GLM52_KDA_LANE || "manual";
const task = process.env.GLM52_KDA_TASK;
const submission = process.env.GLM52_KDA_SUBMISSION;
if (!task || !submission) {
	throw new Error("GLM52_KDA_TASK and GLM52_KDA_SUBMISSION are required");
}

const python = process.env.ROCM_TORCH_PYTHON ||
	(process.env.ROCM_TORCH_VENV ? `${process.env.ROCM_TORCH_VENV}/bin/python` : "/home/lichangye/venvs/rocm-torch/bin/python");

const outDir = path.join(root, "workflow-output", "lanes", lane);
await fs.mkdir(outDir, { recursive: true });
const reportPath = path.join(outDir, "validate-amd.json");
const formalJsonPath = path.join(outDir, "validate-amd-formal-smoke.json");

const staticErrors = await staticChecks(root, task, submission);
const torchProbe = await runProcess([
	python,
	"-c",
	[
		"import json, torch",
		"print(json.dumps({",
		"  'torch_version': torch.__version__,",
		"  'cuda_available': bool(torch.cuda.is_available()),",
		"  'device_count': int(torch.cuda.device_count()),",
		"  'devices': [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]",
		"}))",
	].join("\n"),
], root);

let torchInfo = null;
try {
	torchInfo = JSON.parse(torchProbe.stdout);
} catch {
	torchInfo = { parse_error: true, stdout_tail: torchProbe.stdout.slice(-1000) };
}

const formalSmoke = await runProcess([
	python,
	"tools/formal_eval.py",
	"--root",
	root,
	"--task",
	task,
	"--submission",
	submission,
	"--smoke",
	"--json-out",
	formalJsonPath,
], root);

let formalData = null;
try {
	formalData = JSON.parse(await fs.readFile(formalJsonPath, "utf8"));
} catch {
	try {
		formalData = JSON.parse(formalSmoke.stdout);
	} catch {
		formalData = {
			parse_error: true,
			stdout_tail: formalSmoke.stdout.slice(-2000),
			stderr_tail: formalSmoke.stderr.slice(-2000),
		};
	}
}

const errors = [...staticErrors];
if (torchProbe.exitCode !== 0) {
	errors.push(`torch ROCm probe failed: ${torchProbe.stderr || torchProbe.stdout}`);
}
if (!torchInfo?.cuda_available || Number(torchInfo?.device_count || 0) < 1) {
	errors.push(`torch ROCm GPU unavailable: ${JSON.stringify(torchInfo)}`);
}
const acceptableFormalStatus = ["passed", "correct_not_faster"].includes(formalData?.status);
if (formalSmoke.exitCode !== 0 && !acceptableFormalStatus) {
	errors.push(`formal smoke failed for ${task}: ${formalSmoke.stderr || formalSmoke.stdout}`);
}
if (formalData?.status && !acceptableFormalStatus) {
	errors.push(`formal smoke returned status=${formalData.status}`);
}

const report = {
	version: 1,
	status: errors.length === 0 ? "passed" : "failed",
	root,
	lane,
	task,
	submission,
	python,
	torch: torchInfo,
	formal_smoke: compactFormal(formalData, formalSmoke),
	errors,
	created_at: new Date().toISOString(),
};

await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
if (errors.length > 0) {
	throw new Error(`validate AMD failed for ${task}: ${errors.join("; ").slice(0, 2000)}`);
}

return {
	summary: `validate AMD passed for ${task}`,
	data: report,
	statePatch: [{ op: "set", path: `/lanes/${lane}/validateAMD`, value: report }],
	artifacts: [
		`local://${path.relative(root, reportPath)}`,
		`local://${path.relative(root, formalJsonPath)}`,
	],
};

async function staticChecks(rootDir, operatorId, solutionDir) {
	const errors = [];
	for (const rel of ["task.md", "tasks.json", "tools/formal_eval.py", "tools/workflow_formal_test.sh"]) {
		if (!(await exists(path.join(rootDir, rel)))) errors.push(`missing required file: ${rel}`);
	}
	if (!(await exists(solutionDir))) errors.push(`missing submission dir: ${solutionDir}`);
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(rootDir, "tasks.json"), "utf8"));
		const row = manifest.tasks?.find((entry) => entry.operator_id === operatorId);
		if (!row) errors.push(`tasks.json does not define operator_id=${operatorId}`);
		else if (path.resolve(row.solution_dir) !== path.resolve(solutionDir)) {
			errors.push(`submission dir does not match tasks.json: ${row.solution_dir}`);
		}
	} catch (exc) {
		errors.push(`tasks.json is not readable JSON: ${exc}`);
	}
	return errors;
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function runProcess(args, cwd) {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { args, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function compactFormal(data, processResult) {
	const aggregate = data?.aggregate || {};
	return {
		status: data?.status || (processResult.exitCode === 0 ? "unknown" : "failed"),
		exit_code: data?.exit_code ?? processResult.exitCode,
		backend: data?.backend || null,
		aggregate,
		case_count: aggregate.case_count ?? null,
		correct_cases: aggregate.correct_cases ?? null,
		passed_cases: aggregate.passed_cases ?? null,
		incorrect_cases: aggregate.incorrect_cases ?? null,
		infra_failed_cases: aggregate.infra_failed_cases ?? null,
		modification_protection_ok: (data?.tasks || [])
			.flatMap((taskResult) => taskResult.cases || [])
			.every((caseResult) => caseResult.modification_protection?.ok !== false),
		stdout_tail: processResult.stdout.slice(-1000),
		stderr_tail: processResult.stderr.slice(-1000),
	};
}
