// Verify the campaign root's protection surface against the baseline snapshot.
// Any change to root coordination files (task.md, tasks.json, top1_targets.json)
// or to the raw xNN task packages' symlink structure fails the run. Runtime
// trees (runs/, wiki/, workflow-output/, leaderboard.*) are excluded from the
// walk — their write-scopes are enforced by the dedicated guard scripts.
// No git: the campaign root is not a git repository.
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outputRoot = path.join(root, "workflow-output");
await fs.mkdir(outputRoot, { recursive: true });
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, normalizeTaskDir } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const { normalizedProtectedFileContent } = await import(
	`file://${path.join(resourceRoot, "scripts", "protected-files-policy.js")}`
);

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

const current = {
	createdAt: new Date().toISOString(),
	files: await snapshot(root),
};

const changes = diffSnapshots(baseline.files, current.files);
const allowed = [];
const violations = [];
const quarantined = [];
for (const change of changes) {
	const verdict = classifyChange(change.path);
	// ADDED unknown top-level entries are agent-tool byproducts (e.g. onnxruntime
	// profiling JSONs dropped into the process cwd), not tampering: quarantine them
	// instead of killing the run. Modifications/deletions of protected files and any
	// change inside the raw xNN packages remain fatal.
	if (!verdict.allowed && change.kind === "added" && isQuarantinableAddition(change.path)) {
		const moved = await quarantine(change.path);
		quarantined.push({ ...change, quarantined_to: moved });
		allowed.push({ ...change, reason: `unknown added file quarantined to ${moved}` });
		continue;
	}
	const item = { ...change, reason: verdict.reason };
	if (verdict.allowed) allowed.push(item);
	else violations.push(item);
}

const report = {
	status: violations.length === 0 ? "pass" : "failed",
	task_dir: taskDirRel,
	checked_at: current.createdAt,
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

function classifyChange(relPath) {
	if (!isSafeRelPath(relPath)) return deny("unsafe path");
	if (relPath === "task.md" || relPath === "tasks.json" || relPath === "top1_targets.json") {
		return deny("campaign contract/manifest files are protected");
	}
	if (/^x[0-9]{2}-[^/]+(\/|$)/u.test(relPath)) {
		return deny("raw task packages are immutable (symlink structure changed)");
	}
	// A stray transient scratch file at the campaign root is a harmless agent
	// byproduct — do not abort the run over it. Protected files are matched above.
	if (!relPath.includes("/") && /(^local_|_next\.txt$|\.tmp$|\.scratch$|~$|\.bak$|\.log$)/u.test(relPath)) {
		return allow("transient scratch/temp file at campaign root (harmless agent byproduct)");
	}
	return deny("path is outside the campaign write allowlist (runs/, wiki/, workflow-output/, leaderboard.* are handled by dedicated guards)");
}

// An ADDED path is quarantinable when its top-level segment is a NEW name at the
// campaign root — i.e. not a protected file and not inside a raw xNN package.
function isQuarantinableAddition(relPath) {
	if (!isSafeRelPath(relPath)) return false;
	const top = relPath.split("/")[0];
	if (["task.md", "tasks.json", "top1_targets.json"].includes(top)) return false;
	if (/^x[0-9]{2}-/u.test(top)) return false;
	return true;
}

async function quarantine(relPath) {
	try {
		const destDir = path.join(root, "workflow-output", "quarantine", current.createdAt.slice(0, 13).replace(/[:T]/gu, "-"));
		await fs.mkdir(destDir, { recursive: true });
		const dest = path.join(destDir, relPath.replaceAll("/", "__"));
		await fs.rename(path.join(root, relPath), dest);
		return path.relative(root, dest);
	} catch (error) {
		return `quarantine-failed: ${error instanceof Error ? error.message : String(error)}`;
	}
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
		const normalized = normalizedProtectedFileContent(relPath, data);
		result[relPath] = {
			type: "file",
			size: normalized.length,
			sha256: crypto.createHash("sha256").update(normalized).digest("hex"),
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
		if (ignored(relPath)) continue;
		if (entry.isSymbolicLink()) {
			await visit(filePath, relPath, entry);
		} else if (entry.isDirectory()) {
			await walk(filePath, visit);
		} else {
			await visit(filePath, relPath, entry);
		}
	}
}

function ignored(relPath) {
	if (relPath === ".git" || relPath.startsWith(".git/")) return true;
	if (relPath === "workflow-output" || relPath.startsWith("workflow-output/")) return true;
	if (relPath === "runs" || relPath.startsWith("runs/")) return true;
	if (relPath === "wiki" || relPath.startsWith("wiki/")) return true;
	if (relPath === "leaderboard.json" || relPath === "leaderboard.csv") return true;
	if (relPath.includes("/__pycache__") || relPath.endsWith("__pycache__")) return true;
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
