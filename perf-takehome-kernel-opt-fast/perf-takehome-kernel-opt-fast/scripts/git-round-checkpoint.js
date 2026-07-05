const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });

const state = workflowContext.state ?? {};
const taskContext = state.taskContext ?? {};
const validation = state.validation ?? {};
const leaderboardUpdate = state.leaderboardUpdate ?? {};
const skillHarvest = state.skillHarvest ?? {};
const taskDirRel = normalizeRel(taskContext.task_dir ?? "");

const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.exitCode !== 0) {
	throw new Error(`git status failed: ${status.stderr || status.stdout}`);
}

const changedPaths = parsePorcelain(status.stdout);
const allowed = [];
const blocked = [];
const ignoredPaths = [];
for (const relPath of changedPaths) {
	const verdict = classifyCheckpointPath(relPath, taskDirRel, skillHarvest);
	if (verdict.allowed) allowed.push({ path: relPath, reason: verdict.reason });
	else if (verdict.ignored) ignoredPaths.push({ path: relPath, reason: verdict.reason });
	else blocked.push({ path: relPath, reason: verdict.reason });
}

const result = {
	status: "pending",
	task_dir: taskDirRel,
	candidate: validation.candidate ?? "",
	validation_status: validation.status ?? "",
	leaderboard_status: leaderboardUpdate.status ?? "",
	allowed_count: allowed.length,
	blocked_count: blocked.length,
	ignored_count: ignoredPaths.length,
	allowed,
	blocked,
	ignored: ignoredPaths,
	normalized_docs: [],
	normalized_files: [],
	protected_baseline: null,
	commit: "",
	message: "",
};

if (blocked.length > 0) {
	result.status = "blocked";
	await writeReport(result);
	throw new Error(
		`git round checkpoint blocked by uncheckpointable changes: ${blocked
			.slice(0, 12)
			.map((item) => `${item.path} (${item.reason})`)
			.join("; ")}`,
	);
}

if (allowed.length === 0) {
	result.status = "skipped";
	result.message = "no checkpointable changes";
	await writeReport(result);
	return response(result);
}

result.normalized_files = await normalizeCheckpointTextFiles(allowed);
result.normalized_docs = result.normalized_files.filter((relPath) => isCheckpointDoc(relPath));
await gitOrThrow(["add", "--", ...allowed.map((item) => item.path)]);
const stagedCheck = await git(["diff", "--cached", "--check"]);
if (stagedCheck.exitCode !== 0) {
	result.status = "blocked";
	result.message = stagedCheck.stderr || stagedCheck.stdout;
	await git(["reset", "--", ...allowed.map((item) => item.path)]);
	await writeReport(result);
	throw new Error(`git diff --cached --check failed: ${result.message}`);
}

const staged = await git(["diff", "--cached", "--name-only"]);
const stagedPaths = staged.stdout.split(/\r?\n/u).filter(Boolean);
if (stagedPaths.length === 0) {
	result.status = "skipped";
	result.message = "allowed changes produced no staged diff";
	await writeReport(result);
	return response(result);
}

const subject = makeSubject(taskDirRel, validation);
const body = makeBody(taskDirRel, validation, leaderboardUpdate, stagedPaths);
const commit = await git([
	"-c",
	"user.name=kernel-opt workflow",
	"-c",
	"user.email=kernel-opt-workflow@local",
	"commit",
	"-m",
	subject,
	"-m",
	body,
]);
if (commit.exitCode !== 0) {
	result.status = "failed";
	result.message = commit.stderr || commit.stdout;
	await writeReport(result);
	throw new Error(`git commit failed: ${result.message}`);
}

const rev = await gitOrThrow(["rev-parse", "--short", "HEAD"]);
result.status = "committed";
result.commit = rev.stdout.trim();
result.message = subject;
result.protected_baseline = await refreshProtectedBaseline();
await writeReport(result);
return response(result);

function response(result) {
	return {
		summary:
			result.status === "committed"
				? `round checkpoint ${result.commit}: ${result.message}`
				: `round checkpoint ${result.status}: ${result.message}`,
		data: result,
		statePatch: [
			{
				op: "set",
				path: "/campaign/lastGitCheckpoint",
				value: {
					status: result.status,
					commit: result.commit,
					message: result.message,
					task_dir: result.task_dir,
					candidate: result.candidate,
				},
			},
		],
		artifacts: ["local://workflow-output/git-round-checkpoint.json"],
	};
}

function classifyCheckpointPath(relPath, taskDir, skillHarvest) {
	if (!isSafeRelPath(relPath)) return deny("unsafe path");

	// Runtime output / caches / debug artifacts: not committed, but must NOT block the checkpoint.
	// (This repo's .gitignore does not cover these, so git status lists them as untracked.)
	if (relPath.startsWith("workflow-output/")) return ignore("workflow runtime output is ignored");
	if (/^tasks\/[^/]+\/(runs|profile)\//u.test(relPath)) return ignore("large runtime evidence stays out of git");
	if (relPath.includes("/__pycache__/") || relPath.endsWith("__pycache__")) return ignore("cache artifact");
	if (relPath.endsWith(".pyc")) return ignore("cache artifact");
	if (relPath === "trace.json") return ignore("debug trace artifact stays out of git");
	if (relPath === ".hypothesis" || relPath.startsWith(".hypothesis/")) return ignore("hypothesis cache");

	// Protected reference/infra files must never be checkpointed — these HARD-BLOCK the run.
	if (relPath === "problem.py") return deny("reference simulator problem.py is protected");
	if (relPath === "tests" || relPath.startsWith("tests/")) return deny("tests/ is protected");
	if (/^(scripts|workflows|\.omp\/agents|\.omp\/skills)\//u.test(relPath)) return deny("campaign infrastructure is protected");

	if (relPath === "perf_takehome.py") return allow("scored kernel file is checkpointable");
	if (relPath === "leaderboard.json" || relPath === "leaderboard.csv") return allow("root leaderboard evidence is checkpointable");
	if (relPath.startsWith("wiki/")) return allow("wiki notes are checkpointable");
	if (relPath.startsWith("notes/")) return allow("scratch notes are checkpointable");
	if (taskDir && (relPath === taskDir || relPath.startsWith(`${taskDir}/`))) {
		return allow("task bookkeeping (docs, candidates, benchmark) is checkpointable");
	}
	// Any other stray untracked file (launch logs, editor scratch, agent temp files) must NOT be
	// fatal during an unattended multi-hour campaign. The hard-block above is reserved for tampering
	// with protected reference files; unknown files are simply left out of the commit.
	return ignore("path is outside checkpoint allowlist; left untracked");
}

function isAllowedSelectedTaskFile(localPath) {
	if (localPath.startsWith("docs/")) return true;
	if (/^(src|include)\//u.test(localPath)) return isAllowedSourceExt(localPath);
	if (/^(solution|candidate|kernel|wrapper|helper|main)[A-Za-z0-9_.-]*\.(json|py|cu|cuh|cpp|cc|c|h|hpp|txt|md)$/u.test(localPath)) return true;
	return false;
}

function isAllowedSourceExt(localPath) {
	return /\.(py|cu|cuh|cpp|cc|c|h|hpp|json|txt|md)$/u.test(localPath);
}

function makeSubject(taskDir, validation) {
	const taskName = taskDir ? path.basename(taskDir) : "unknown-task";
	const candidate = String(validation.candidate ?? "candidate").replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 80);
	const status = String(validation.status ?? "unknown").replace(/[^A-Za-z0-9_.-]+/gu, "_");
	return `Round checkpoint: ${taskName} ${candidate} ${status}`.slice(0, 180);
}

function makeBody(taskDir, validation, leaderboardUpdate, stagedPaths) {
	return [
		`Task: ${taskDir || "unknown"}`,
		`Candidate: ${validation.candidate ?? ""}`,
		`Validation: ${validation.status ?? ""}`,
		`Summary: ${validation.summary_path ?? ""}`,
		`Leaderboard update: ${leaderboardUpdate.status ?? ""}`,
		`Promoted: ${leaderboardUpdate.promoted_this_round ?? false}`,
		"",
		"Checkpointed paths:",
		...stagedPaths.slice(0, 200).map((item) => `- ${item}`),
	].join("\n");
}

function parsePorcelain(text) {
	const paths = [];
	for (const line of text.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const firstPath = line.slice(3).split(" -> ").pop();
		if (firstPath) paths.push(normalizeRel(firstPath));
	}
	return Array.from(new Set(paths)).sort();
}

function allow(reason) {
	return { allowed: true, reason };
}

function ignore(reason) {
	return { allowed: false, ignored: true, reason };
}

function deny(reason) {
	return { allowed: false, reason };
}

function normalizeRel(value) {
	return String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function isSafeRelPath(relPath) {
	return relPath && !path.isAbsolute(relPath) && !relPath.split("/").includes("..");
}

async function normalizeCheckpointTextFiles(allowed) {
	const normalized = [];
	for (const item of allowed) {
		const relPath = item.path;
		if (!isCheckpointTextFile(relPath)) continue;
		const absPath = path.join(root, relPath);
		let text = "";
		try {
			text = await fs.readFile(absPath, "utf8");
		} catch {
			continue;
		}
		const next = normalizeCheckpointText(text);
		if (next === text) continue;
		await fs.writeFile(absPath, next);
		normalized.push(relPath);
	}
	return normalized;
}

function isCheckpointTextFile(relPath) {
	return /\.(?:c|cc|cpp|cu|cuh|csv|h|hpp|json|jsonl|md|py|txt)$/u.test(relPath);
}

function isCheckpointDoc(relPath) {
	return /(?:^wiki\/|\/docs\/).*\.(?:md|txt)$/u.test(relPath);
}

function normalizeCheckpointText(text) {
	if (!text) return text;
	const lines = text
		.replace(/\r\n/gu, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function writeReport(result) {
	await fs.writeFile(path.join(outDir, "git-round-checkpoint.json"), JSON.stringify(result, null, 2) + "\n");
}

async function refreshProtectedBaseline() {
	const head = await gitOrThrow(["rev-parse", "HEAD"]);
	const files = await snapshot(root);
	const baseline = {
		root,
		createdAt: new Date().toISOString(),
		gitHead: head.stdout.trim(),
		policy: "humanize-style-baseline-plus-allowlist",
		ignoredPrefixes: [
			".git/",
			"workflow-output/",
			"tasks/*/runs/",
			"tasks/*/profile/",
			"**/__pycache__/",
		],
		files,
	};
	const baselinePath = path.join(outDir, "protected-files-baseline.json");
	await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
	return {
		status: "refreshed",
		file_count: Object.keys(files).length,
		baseline_path: path.relative(root, baselinePath),
		git_head: baseline.gitHead,
	};
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
	if (relPath === "trace.json") return true;
	return false;
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

async function gitOrThrow(args) {
	const result = await git(args);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result;
}
