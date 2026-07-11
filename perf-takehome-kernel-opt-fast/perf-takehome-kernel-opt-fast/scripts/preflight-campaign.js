const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });
await fs.rm(path.join(outDir, "active-task-locks"), { recursive: true, force: true });
await fs.mkdir(path.join(outDir, "active-task-locks"), { recursive: true });
await fs.mkdir(path.join(outDir, "locks"), { recursive: true });

// Single bookkeeping "task" for the perf take-home. The scored file (perf_takehome.py) lives at the
// repo root; this directory only holds the agent's plans (docs/) and candidate/leaderboard evidence.
const taskDirRel = "tasks/kernel_opt";
await fs.mkdir(path.join(root, taskDirRel, "docs"), { recursive: true });

const checks = {
	root,
	startedAt: new Date().toISOString(),
	requiredPaths: {},
	commands: {},
};

for (const relPath of [
	"perf_takehome.py",
	"problem.py",
	"tests/submission_tests.py",
	"tests/frozen_problem.py",
]) {
	checks.requiredPaths[relPath] = await exists(path.join(root, relPath));
}

checks.commands.python = await run(["python3", "--version"]);
checks.pythonReady = checks.commands.python.exitCode === 0;
checks.validationReady = checks.pythonReady;

const preflightPath = path.join(outDir, "preflight-campaign.json");
await fs.writeFile(preflightPath, JSON.stringify(checks, null, 2) + "\n");

const missing = Object.entries(checks.requiredPaths)
	.filter(([, ok]) => !ok)
	.map(([relPath]) => relPath);
if (missing.length > 0) {
	throw new Error(`missing required perf-takehome paths: ${missing.join(", ")}`);
}
if (!checks.pythonReady) {
	throw new Error(`python3 is not available: ${checks.commands.python.stderr || checks.commands.python.stdout}`);
}

return {
	summary: `preflight passed (${checks.commands.python.stdout || "python ok"})`,
	data: compactChecks(checks, preflightPath),
	statePatch: [
		{ op: "set", path: "/campaign/root", value: root },
		{ op: "set", path: "/campaign/preflight", value: compactChecks(checks, preflightPath) },
		{ op: "set", path: "/campaign/validationReady", value: checks.validationReady },
		{ op: "set", path: "/campaign/continue", value: true },
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
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { cmd, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		return { cmd, exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function compactChecks(value, filePath) {
	return {
		root: value.root,
		startedAt: value.startedAt,
		validationReady: Boolean(value.validationReady),
		pythonReady: Boolean(value.pythonReady),
		python: value.commands?.python?.stdout ?? "",
		missingRequiredPaths: Object.entries(value.requiredPaths ?? {})
			.filter(([, ok]) => !ok)
			.map(([relPath]) => relPath),
		detail_file: path.relative(root, filePath),
		note: "Full command stdout/stderr is stored in detail_file, not workflow state.",
	};
}
