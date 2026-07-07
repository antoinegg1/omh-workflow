const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outputDir = path.join(root, "workflow-output");
await fs.mkdir(outputDir, { recursive: true });
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const {
	activeTaskDirs,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	normalizeTaskDir,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);

const baselinePath = path.join(root, "workflow-output", "protected-files-baseline.json");
const baseline = await readJson(baselinePath, null);
if (!baseline || !baseline.files) {
	throw new Error("protected file baseline missing; run protectedFilesBaseline before write-capable nodes");
}

const state = workflowContext.state ?? {};
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = normalizeTaskDir(taskContext.task_dir ?? "");
const activeDirs = Array.from(new Set([taskDirRel, ...activeTaskDirs(state)].filter(Boolean)));
// Tasks already promoted/completed by any lane (from the on-disk leaderboard and campaign state).
// Their evidence and candidate-source files are legitimate finished work — a later lane's revision
// check must not flag them as cross-task violations just because they changed after this run's
// snapshot baseline. (The intended git-checkpoint baseline refresh is not wired into the graph.)
const completedDirs = await completedTaskDirs(state);
const current = {
	root,
	createdAt: new Date().toISOString(),
	gitHead: await currentGitHead(),
	files: await snapshot(root),
};

const snapshotChanges = diffSnapshots(baseline.files, current.files);
const gitStatusChanges = await currentGitStatusChanges();
const baselineMode =
	baseline.gitHead && baseline.gitHead === current.gitHead
		? "snapshot"
		: "git-status-after-head-advance";
const changes = baselineMode === "snapshot" ? snapshotChanges : gitStatusChanges;
const allowed = [];
const violations = [];
for (const change of changes) {
	const verdict = classifyChange(change.path, taskDirRel, activeDirs, completedDirs);
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

function classifyChange(relPath, taskDir, activeDirs, completedDirs = []) {
	if (!isSafeRelPath(relPath)) return deny("unsafe path");

	if (relPath === "task.md" || relPath === "tasks.json") return deny("campaign contract is protected");
	// The flow's own knowledge base lives under workflows/<flow>/wiki/ and is maintained by the
	// wiki-search lane at runtime — allow it BEFORE the general workflows/ infra deny below.
	if (/^workflows\/[^/]+\/wiki\//u.test(relPath)) return allow("flow wiki knowledge base is allowed");
	if (/^(scripts|workflows|\.omp\/agents|\.omp\/skills)\//u.test(relPath)) {
		return deny("campaign infrastructure is protected");
	}
	if (/^tasks\/[^/]+\/(definition\.json|workload\.jsonl|reference\.py|task\.md)$/u.test(relPath)) {
		return deny("task definition, workload, reference, and task contract are protected");
	}

	if (relPath.startsWith("wiki/")) return allow("wiki notes are allowed");
	if (/^tasks\/[^/]+\/docs\//u.test(relPath)) return allow("task documentation is allowed");
	if (relPath === "leaderboard.json" || relPath === "leaderboard.csv" || relPath === "workload_latency.csv") {
		return allow("leaderboard evidence is script-managed runtime output");
	}
	// A task already promoted/completed by any lane is legitimate finished work; allow its evidence
	// and candidate-source files so a later lane's revision check does not flag them as cross-task
	// violations (they changed after this run's snapshot baseline but were produced by a real promote).
	for (const doneDir of completedDirs) {
		if (doneDir && relPath.startsWith(`${doneDir}/`)) {
			const local = relPath.slice(doneDir.length + 1);
			if (
				/^(benchmark\.csv|candidates\.jsonl|leaderboard\.jsonl|workload_latency\.csv)$/u.test(local) ||
				local.startsWith("docs/") ||
				isAllowedSelectedTaskFile(local)
			) {
				return allow("completed task evidence/solution is legitimate finished work");
			}
		}
	}
	if (/^tasks\/[^/]+\/(benchmark\.csv|candidates\.jsonl|leaderboard\.jsonl|workload_latency\.csv)$/u.test(relPath)) {
		return taskDirMatchesAny(relPath, activeDirs)
			? allow("active task evidence is script-managed runtime output")
			: deny("inactive task evidence changed during this lane");
	}
	if (/^tasks\/[^/]+\/(runs|profile)\//u.test(relPath)) return allow("validation/profile artifacts are runtime output");
	if (relPath.startsWith("workflow-output/")) return allow("workflow runtime output");

	if (taskDir && relPath.startsWith(`${taskDir}/docs/`)) return allow("selected task documentation is allowed");
	if (taskDir && relPath.startsWith(`${taskDir}/`)) {
		const local = relPath.slice(taskDir.length + 1);
		if (isAllowedSelectedTaskFile(local)) return allow("selected task candidate source is allowed");
		return deny("selected task change is outside the candidate-source allowlist");
	}
	for (const activeDir of activeDirs) {
		if (!activeDir || activeDir === taskDir || !relPath.startsWith(`${activeDir}/`)) continue;
		const local = relPath.slice(activeDir.length + 1);
		if (isAllowedSelectedTaskFile(local)) return allow("another active worker task candidate source is allowed");
	}

	if (/^tasks\/[^/]+\//u.test(relPath)) return deny("cross-task changes are not allowed");
	// A stray transient scratch/temp file dropped at the campaign root by an implementer agent
	// (e.g. local_*.txt, *_next.txt, *.tmp) is a harmless byproduct, not a protected campaign file.
	// Do not abort the whole run over it — the protected contract files (task.md, tasks.json,
	// leaderboard.*, scripts/, workflows/) are matched by explicit rules above and stay protected.
	if (!relPath.includes("/") && /(^local_|_next\.txt$|\.tmp$|\.scratch$|~$|\.bak$)/u.test(relPath)) {
		return allow("transient scratch/temp file at campaign root (harmless agent byproduct)");
	}
	return deny("path is outside the campaign write allowlist");
}

function taskDirMatchesAny(relPath, taskDirs) {
	return taskDirs.some((taskDir) => taskDir && relPath.startsWith(`${taskDir}/`));
}

// Task dirs already promoted or parked as done, so their evidence/solution is legitimate finished
// work. Sources: campaign task_status (final_best / parked_current_best / parked_after_local_limit)
// and the on-disk leaderboard.json best_by_task. Robust to either being absent.
async function completedTaskDirs(state) {
	const dirs = new Set();
	const doneStatuses = new Set(["final_best", "parked_current_best", "parked_after_local_limit"]);
	const statuses = state.campaign?.taskUpdates?.task_status ?? state.taskUpdates?.task_status ?? [];
	const baseTasks = state.campaign?.tasks ?? state.tasks ?? [];
	const orderToDir = new Map(baseTasks.map((t) => [Number(t.order), normalizeTaskDir(t.task_dir ?? "")]));
	for (const item of statuses) {
		if (!doneStatuses.has(item?.status ?? "")) continue;
		const dir = normalizeTaskDir(item.task_dir ?? orderToDir.get(Number(item.order)) ?? "");
		if (dir) dirs.add(dir);
	}
	const lb = await readJson(path.join(root, "leaderboard.json"), null);
	for (const row of lb?.best_by_task ?? []) {
		const dir = normalizeTaskDir(row?.task_dir ?? "");
		if (dir) dirs.add(dir);
	}
	return Array.from(dirs);
}

function isAllowedSelectedTaskFile(localPath) {
	if (localPath.startsWith("docs/")) return true;
	if (/^(src|include)\//u.test(localPath)) return isAllowedSourceExt(localPath);
	if (/^(solution|candidate|kernel|wrapper|helper|main)[A-Za-z0-9_.-]*\.(json|py|cu|cuh|cpp|cc|c|h|hpp|txt|md)$/u.test(localPath)) return true;
	// Any source file with an allowed extension at the task root is a legitimate candidate source.
	// Implementers pick descriptive kernel names (e.g. mla_decode_kernel.cu) that don't match the
	// fixed name-prefix allowlist above. The protected definition/workload/reference/task.md files
	// are already denied upstream, and this rule is task-scoped (single path segment, no subdirs),
	// so it cannot touch other tasks or campaign infrastructure.
	if (!localPath.includes("/") && isAllowedSourceExt(localPath)) return true;
	// Tolerate an extensionless candidate file at the task root (e.g. "padded_bmm_v1"): implementers
	// occasionally drop a source file without an extension. Protected files (definition.json,
	// reference.py, workload.jsonl, task.md) all have extensions and are denied upstream, so an
	// extensionless single-segment file in a task dir is safely a stray candidate artifact — do not
	// abort the whole run over it.
	if (!localPath.includes("/") && !localPath.includes(".") && localPath.length > 0) return true;
	return false;
}

function isAllowedSourceExt(localPath) {
	return /\.(py|cu|cuh|cpp|cc|c|h|hpp|json|txt|md)$/u.test(localPath);
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
			result[relPath] = {
				type: "symlink",
				target: await fs.readlink(filePath),
			};
			return;
		}
		if (!dirent.isFile()) return;
		const data = await fs.readFile(filePath);
		result[relPath] = {
			type: "file",
			size: data.length,
			sha256: crypto.createHash("sha256").update(data).digest("hex"),
		};
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
	if (entry.isDirectory() && /^tasks\/[^/]+\/(runs|profile)$/u.test(relPath)) return true;
	if (/^tasks\/[^/]+\/(runs|profile)\//u.test(relPath)) return true;
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
