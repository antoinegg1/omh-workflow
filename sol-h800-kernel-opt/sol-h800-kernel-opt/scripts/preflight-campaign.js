const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });
await fs.rm(path.join(outDir, "active-task-locks"), { recursive: true, force: true });
await fs.mkdir(path.join(outDir, "active-task-locks"), { recursive: true });
await fs.mkdir(path.join(outDir, "locks"), { recursive: true });

const checks = {
	root,
	startedAt: new Date().toISOString(),
	requiredPaths: {},
	commands: {},
	gpu: {},
};

for (const relPath of [
	"task.md",
	"tasks.json",
	"scripts/run_h800_task.py",
	"scripts/h800_timing_adapter/sitecustomize.py",
	"scripts/leaderboard.py",
	"../envs/sol-local/bin/python",
	"../envs/sol-local/bin/sol-execbench",
	"../SOL-ExecBench/.git",
	".omp/skills/sol-h800-coordinator/SKILL.md",
	".omp/agents/glm-scout.md",
	".omp/agents/deepseek-scout.md",
]) {
	checks.requiredPaths[relPath] = await exists(path.join(root, relPath));
}

checks.commands.nvidiaSmi = await run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"]);
const localPython = path.resolve(root, "../envs/sol-local/bin/python");
const localSolExecBench = path.resolve(root, "../envs/sol-local/bin/sol-execbench");
checks.commands.localPython = await run([
	localPython,
	"-c",
	"import torch, sys; print(sys.executable); print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')",
]);
checks.commands.localSolExecBench = await run([localSolExecBench, "--help"]);
checks.commands.solExecBenchGitStatus = await run([
	"git",
	"-C",
	path.resolve(root, "../SOL-ExecBench"),
	"status",
	"--short",
]);
checks.gpu.name = checks.commands.nvidiaSmi.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
checks.gpu.isH800 = checks.gpu.name.includes("H800");
checks.solExecBenchReadOnlyClean =
	checks.commands.solExecBenchGitStatus.exitCode === 0 &&
	checks.commands.solExecBenchGitStatus.stdout.trim() === "";
checks.timingAdapterReady = checks.requiredPaths["scripts/h800_timing_adapter/sitecustomize.py"];
checks.validationReady =
	checks.commands.localPython.exitCode === 0 &&
	checks.commands.localSolExecBench.exitCode === 0 &&
	checks.timingAdapterReady &&
	checks.solExecBenchReadOnlyClean;

const preflightPath = path.join(outDir, "preflight-campaign.json");
await fs.writeFile(preflightPath, JSON.stringify(checks, null, 2) + "\n");

const missing = Object.entries(checks.requiredPaths)
	.filter(([, ok]) => !ok)
	.map(([relPath]) => relPath);
if (missing.length > 0) {
	throw new Error(`missing required kernel-opt paths: ${missing.join(", ")}`);
}
if (!checks.gpu.isH800) {
	throw new Error(`local GPU is not H800: ${checks.gpu.name || "unknown"}`);
}
if (!checks.validationReady) {
	throw new Error(
		`local SOL-ExecBench validation environment is not available: ${
			checks.commands.localPython.stderr ||
			checks.commands.localSolExecBench.stderr ||
			checks.commands.solExecBenchGitStatus.stderr ||
			checks.commands.solExecBenchGitStatus.stdout ||
			checks.commands.localPython.stdout ||
			checks.commands.localSolExecBench.stdout
		}. Use the local sol-local env (../envs/sol-local relative to the campaign root), keep ../SOL-ExecBench read-only and clean, keep scripts/h800_timing_adapter/sitecustomize.py available, and do not install or select another validation environment.`,
	);
}

return {
	summary: `preflight passed on ${checks.gpu.name}`,
	data: compactChecks(checks, preflightPath),
	statePatch: [
		{ op: "set", path: "/campaign/root", value: root },
		{ op: "set", path: "/campaign/preflight", value: compactChecks(checks, preflightPath) },
		{ op: "set", path: "/campaign/validationReady", value: checks.validationReady },
		{ op: "set", path: "/campaign/continue", value: true },
		{ op: "set", path: "/workerPool", value: { lanes: ["A", "B", "C", "D", "E"], activeTasks: {}, initialized_at: checks.startedAt } },
	],
	artifacts: ["local://workflow-output/preflight-campaign.json"],
};

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function run(cmd) {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { cmd, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function compactChecks(value, filePath) {
	return {
		root: value.root,
		startedAt: value.startedAt,
		gpu: value.gpu,
		validationReady: Boolean(value.validationReady),
		solExecBenchReadOnlyClean: Boolean(value.solExecBenchReadOnlyClean),
		timingAdapterReady: Boolean(value.timingAdapterReady),
		missingRequiredPaths: Object.entries(value.requiredPaths ?? {})
			.filter(([, ok]) => !ok)
			.map(([relPath]) => relPath),
		detail_file: path.relative(root, filePath),
		note: "Full command stdout/stderr is stored in detail_file, not workflow state.",
	};
}
