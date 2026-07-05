const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outputDir = path.join(root, "workflow-output");
await fs.mkdir(outputDir, { recursive: true });
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);

const baselinePath = path.join(root, "workflow-output", "protected-files-baseline.json");
const baseline = await readJson(baselinePath, null);
if (!baseline || !baseline.files) {
	throw new Error("protected file baseline missing; run protectedFilesBaseline before write-capable nodes");
}

const state = workflowContext.state ?? {};
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir || "tasks/kernel_opt";

const current = {
	root,
	createdAt: new Date().toISOString(),
	gitHead: await currentGitHead(),
	files: await snapshot(root),
};

const snapshotChanges = diffSnapshots(baseline.files, current.files);
const gitStatusChanges = await currentGitStatusChanges();
const baselineMode =
	baseline.gitHead && baseline.gitHead === current.gitHead ? "snapshot" : "git-status-after-head-advance";
const changes = baselineMode === "snapshot" ? snapshotChanges : gitStatusChanges;
const allowed = [];
const violations = [];
for (const change of changes) {
	const verdict = classifyChange(change.path, taskDirRel, change.kind);
	const item = { ...change, reason: verdict.reason };
	if (verdict.allowed) allowed.push(item);
	else violations.push(item);
}

const report = {
	status: violations.length === 0 ? "pass" : "failed",
	task_dir: taskDirRel,
	checked_at: current.createdAt,
	baseline_mode: baselineMode,
	baseline_git_head: baseline.gitHead ?? "",
	current_git_head: current.gitHead,
	ignored_committed_change_count: baselineMode === "snapshot" ? 0 : Math.max(0, snapshotChanges.length - gitStatusChanges.length),
	total_changes: changes.length,
	allowed_count: allowed.length,
	violation_count: violations.length,
	violations,
	allowed_changes: allowed.slice(0, 200),
};

const reportDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, "protected-files-check.json");
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

if (violations.length > 0) {
	throw new Error(
		`protected file check failed: ${violations
			.slice(0, 12)
			.map((item) => `${item.kind}:${item.path} (${item.reason})`)
			.join("; ")}`,
	);
}

return {
	summary: `protected file check passed (${allowed.length} allowed change(s))`,
	data: report,
	statePatch: [lane ? lanePatch(lane, "protectedFiles", compact(report)) : { op: "set", path: "/protectedFiles/latest", value: compact(report) }],
	artifacts: [`local://${path.relative(root, reportPath)}`],
};

// Perf-takehome allowlist: only perf_takehome.py (the scored file), the task bookkeeping dir
// (tasks/kernel_opt/**), leaderboard.json, and workflow runtime output may change. Everything else —
// especially problem.py, tests/**, frozen_problem.py, Readme.md — is protected.
function classifyChange(relPath, taskDir, kind) {
	if (!isSafeRelPath(relPath)) return deny("unsafe path");

	if (relPath === "problem.py") return deny("reference simulator problem.py is protected");
	if (relPath === "tests" || relPath.startsWith("tests/")) return deny("tests/ (incl. frozen_problem.py) is protected");
	if (/^(scripts|workflows|\.omp\/agents|\.omp\/skills)\//u.test(relPath)) {
		return deny("campaign infrastructure is protected");
	}

	if (relPath === "perf_takehome.py") return allow("scored kernel file is the intended edit target");
	if (relPath === "leaderboard.json" || relPath === "leaderboard.csv") return allow("leaderboard evidence is script-managed runtime output");
	if (taskDir && (relPath === taskDir || relPath.startsWith(`${taskDir}/`))) {
		return allow("task bookkeeping (docs, candidates, benchmark, runs) is allowed");
	}
	if (relPath.startsWith("workflow-output/")) return allow("workflow runtime output");
	if (relPath.startsWith("wiki/")) return allow("wiki notes are allowed");
	if (relPath.startsWith("notes/")) return allow("scratch notes are allowed");

	// A stray transient scratch/temp file dropped at the repo root is harmless. During an unattended
	// run the implementer often writes probe/experiment scripts (tmp_*.py, probe_*.py, sweep_*.py,
	// scratch_*, etc.) to measure candidate variants. These are NOT edits to protected reference files
	// (problem.py / tests/ / infra — hard-denied above), so an ADDED root-level file must not kill the
	// campaign. We still DENY modifications to pre-existing tracked root files (Readme.md,
	// watch_trace.py, etc.) — only newly-added stray files are tolerated.
	if (!relPath.includes("/") && kind === "added") {
		return allow("newly-added stray root-level file (agent scratch/probe byproduct; not a protected path)");
	}
	return deny("path is outside the perf-takehome write allowlist");
}

function allow(reason) {
	return { allowed: true, reason };
}

function deny(reason) {
	return { allowed: false, reason };
}

function compact(report) {
	return {
		status: report.status,
		task_dir: report.task_dir,
		total_changes: report.total_changes,
		allowed_count: report.allowed_count,
		violation_count: report.violation_count,
		baseline_mode: report.baseline_mode,
		violations: report.violations.slice(0, 20),
	};
}

function diffSnapshots(before, after) {
	const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
	const changes = [];
	for (const relPath of paths) {
		const left = before[relPath];
		const right = after[relPath];
		if (!left) {
			changes.push({ path: relPath, kind: "added" });
		} else if (!right) {
			changes.push({ path: relPath, kind: "deleted" });
		} else if (left.type !== right.type) {
			changes.push({ path: relPath, kind: "type_changed" });
		} else if (left.type === "file" && left.sha256 !== right.sha256) {
			changes.push({ path: relPath, kind: "modified" });
		} else if (left.type === "symlink" && left.target !== right.target) {
			changes.push({ path: relPath, kind: "modified_symlink" });
		}
	}
	return changes;
}

async function currentGitHead() {
	const result = await git(["rev-parse", "HEAD"]);
	if (result.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

async function currentGitStatusChanges() {
	const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
	return parsePorcelain(status.stdout);
}

function parsePorcelain(text) {
	const changes = [];
	for (const line of text.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const status = line.slice(0, 2);
		const relPath = normalizeRel(line.slice(3).split(" -> ").pop());
		if (!relPath) continue;
		changes.push({
			path: relPath,
			kind: status.includes("D") ? "deleted" : status === "??" ? "added" : "modified",
		});
	}
	const deduped = new Map();
	for (const change of changes) deduped.set(change.path, change);
	return Array.from(deduped.values()).sort((a, b) => a.path.localeCompare(b.path));
}

async function git(args) {
	const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr: stderr.trim() };
}

async function snapshot(dir) {
	const result = {};
	await walk(dir, async (filePath, relPath, dirent) => {
		if (dirent.isSymbolicLink()) {
			result[relPath] = { type: "symlink", target: await fs.readlink(filePath) };
			return;
		}
		if (!dirent.isFile()) return;
		const data = await fs.readFile(filePath);
		result[relPath] = { type: "file", size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
	});
	return result;
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
		const relPath = normalizeRel(path.relative(root, filePath));
		if (ignored(relPath, entry)) continue;
		if (entry.isDirectory()) await walk(filePath, visit);
		else await visit(filePath, relPath, entry);
	}
}

function ignored(relPath, entry) {
	if (relPath === ".git" || relPath.startsWith(".git/")) return true;
	if (relPath === "workflow-output" || relPath.startsWith("workflow-output/")) return true;
	if (relPath.includes("/__pycache__") || relPath.endsWith("__pycache__")) return true;
	if (/^tasks\/[^/]+\/runs(\/|$)/u.test(relPath)) return true;
	if (relPath === "trace.json") return true;
	return false;
}

function normalizeRel(value) {
	return String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function isSafeRelPath(relPath) {
	return relPath && !path.isAbsolute(relPath) && !relPath.split("/").includes("..");
}

async function readJson(filePath, fallback) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return fallback;
	}
}
