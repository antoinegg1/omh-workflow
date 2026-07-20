// AgentKaggle campaign preflight. Verifies the campaign root layout, python
// environment, and Kaggle credentials. GPU is reported informationally only —
// no specific GPU model is required. Upload-auth problems WARN (submissions
// will be recorded as pending) instead of failing the run.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { instanceRoot, readTaskManifest } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);

const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });
// Fresh start: clear runtime locks leaked by a previous (interrupted) run —
// gpu-pool slots, leaderboard-update, etc. No other run shares this cwd.
await fs.rm(path.join(outDir, "locks"), { recursive: true, force: true });
await fs.mkdir(path.join(outDir, "locks"), { recursive: true });

// Stable per-campaign-run tag: instances are named agk-<runTag>-<task>. Idempotent
// across checkpoint restarts (only generated when missing); delete the file (or set
// AGK_FRESH_INSTANCES=1) to materialize fresh instances on the next start.
const runTagPath = path.join(outDir, "run-tag.txt");
let runTag = "";
try {
	runTag = (await fs.readFile(runTagPath, "utf8")).trim();
} catch {
	/* missing */
}
if (!runTag || process.env.AGK_FRESH_INSTANCES === "1") {
	runTag = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 12);
	await fs.writeFile(runTagPath, runTag + "\n");
}

// Fresh campaign start: clear stale task locks (contract path runs/active-task-locks).
const lockRoot = path.join(root, "runs", "active-task-locks");
await fs.rm(lockRoot, { recursive: true, force: true });
await fs.mkdir(lockRoot, { recursive: true });

const checks = {
	root,
	startedAt: new Date().toISOString(),
	runTag,
	requiredPaths: {},
	warnings: [],
	commands: {},
	gpu: {},
	tasks: {},
};

for (const relPath of ["task.md", "tasks.json", "leaderboard.json", "wiki", "runs"]) {
	checks.requiredPaths[relPath] = await exists(path.join(root, relPath));
}

const tasks = await readTaskManifest(fs, path, root);
checks.tasks.count = tasks.length;
checks.tasks.missing_dirs = [];
for (const task of tasks) {
	if (!(await exists(path.join(root, task.task_dir)))) checks.tasks.missing_dirs.push(task.task_dir);
}

// Writable locations required by the task.md contract.
checks.requiredPaths[instanceRoot()] = await isWritableDir(instanceRoot());
checks.requiredPaths["runs/ (writable)"] = await isWritableDir(path.join(root, "runs"));

// Python + core wheels.
checks.commands.python = await run(["python3", "-c", "import sys, pandas, sklearn, numpy; print(sys.version.split()[0], pandas.__version__, sklearn.__version__, numpy.__version__)"]);
if (checks.commands.python.exitCode !== 0) {
	checks.warnings.push("python3 with pandas/scikit-learn/numpy is not importable — MLE tasks will fail until instance pip installs succeed");
}

// Kaggle credentials: access_token is required for score polling; the kaggle CLI
// enables uploads. Missing upload auth is a WARNING (submissions become pending).
checks.requiredPaths["~/.kaggle/access_token"] = await exists(path.join(process.env.HOME ?? "/root", ".kaggle", "access_token"));
checks.commands.kaggleCli = await run(["kaggle", "--version"]);
checks.kaggleUploadReady = checks.commands.kaggleCli.exitCode === 0;
const kagglePython = process.env.AGK_KAGGLE_PYTHON || "python3";
checks.commands.kagglePython = await run([kagglePython, "-c", "import kaggle; print(getattr(kaggle, '__version__', kaggle.__file__))"]);
checks.kagglePythonReady = checks.commands.kagglePython.exitCode === 0;
if (!checks.kaggleUploadReady) {
	checks.warnings.push("kaggle CLI unavailable — remote submissions will be recorded as pending_submission");
}
if (!checks.kagglePythonReady) {
	checks.warnings.push("Kaggle Python API unavailable — kernel/dataset submission routes will fail");
}

// GPU inventory (informational only).
checks.commands.nvidiaSmi = await run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"]);
checks.gpu.devices = checks.commands.nvidiaSmi.exitCode === 0
	? checks.commands.nvidiaSmi.stdout.split(/\r?\n/u).filter((line) => line.trim())
	: [];
checks.gpu.pool_capacity = 2;

const preflightPath = path.join(outDir, "preflight-campaign.json");
await fs.writeFile(preflightPath, JSON.stringify(checks, null, 2) + "\n");

const missing = Object.entries(checks.requiredPaths)
	.filter(([, ok]) => !ok)
	.map(([relPath]) => relPath);
if (missing.length > 0) {
	throw new Error(`missing required campaign paths: ${missing.join(", ")}`);
}
if (checks.tasks.count === 0) {
	throw new Error("tasks.json lists no tasks");
}
if (checks.tasks.missing_dirs.length > 0) {
	throw new Error(`tasks.json references missing task dirs: ${checks.tasks.missing_dirs.join(", ")}`);
}
if (!checks.requiredPaths["~/.kaggle/access_token"]) {
	throw new Error("~/.kaggle/access_token missing — remote score polling (the campaign's primary signal) is impossible");
}

return {
	summary: `preflight passed: ${checks.tasks.count} tasks, ${checks.gpu.devices.length} GPU(s), ${checks.warnings.length} warning(s)`,
	data: compactChecks(checks, preflightPath),
	statePatch: [
		{ op: "set", path: "/campaign/root", value: root },
		{ op: "set", path: "/campaign/preflight", value: compactChecks(checks, preflightPath) },
		{ op: "set", path: "/campaign/validationReady", value: true },
		{ op: "set", path: "/campaign/continue", value: true },
		{ op: "set", path: "/workerPool", value: { lanes: ["A", "B", "C"], activeTasks: {}, initialized_at: checks.startedAt } },
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

async function isWritableDir(dirPath) {
	try {
		await fs.mkdir(dirPath, { recursive: true });
		const probe = path.join(dirPath, `.write-probe-${Date.now()}`);
		await fs.writeFile(probe, "ok");
		await fs.rm(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

async function run(cmd) {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { cmd, exitCode, stdout: stdout.trim().slice(0, 2000), stderr: stderr.trim().slice(0, 2000) };
	} catch (error) {
		return { cmd, exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function compactChecks(value, filePath) {
	return {
		root: value.root,
		startedAt: value.startedAt,
		run_tag: value.runTag,
		task_count: value.tasks.count,
		gpu: value.gpu,
		kaggle_upload_ready: Boolean(value.kaggleUploadReady),
		kaggle_python_ready: Boolean(value.kagglePythonReady),
		warnings: value.warnings,
		missingRequiredPaths: Object.entries(value.requiredPaths ?? {})
			.filter(([, ok]) => !ok)
			.map(([relPath]) => relPath),
		detail_file: path.relative(root, filePath),
		note: "Full command stdout/stderr is stored in detail_file, not workflow state.",
	};
}
