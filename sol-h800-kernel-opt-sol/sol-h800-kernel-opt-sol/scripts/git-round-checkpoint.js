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
for (const relPath of changedPaths) {
	const verdict = classifyCheckpointPath(relPath, taskDirRel, skillHarvest);
	if (verdict.allowed) allowed.push({ path: relPath, reason: verdict.reason });
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
	allowed,
	blocked,
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

	if (relPath.startsWith("workflow-output/")) return deny("workflow runtime output is ignored");
	if (/^tasks\/[^/]+\/(runs|profile)\//u.test(relPath)) return deny("large runtime evidence stays out of git");
	if (relPath.includes("/__pycache__/") || relPath.endsWith("__pycache__")) return deny("cache artifact");

	if (relPath.startsWith("wiki/")) return allow("wiki notes are checkpointable");
	if (relPath === "leaderboard.json" || relPath === "leaderboard.csv" || relPath === "workload_latency.csv") {
		return allow("root leaderboard evidence is checkpointable");
	}

	const harvestedSkill = normalizeRel(skillHarvest?.skill_path ?? "");
	if (harvestedSkill && relPath === harvestedSkill && /^\.omp\/skills\/[a-z0-9][a-z0-9-]{0,62}\/SKILL\.md$/u.test(relPath)) {
		return allow("dedicated skill harvest output is checkpointable");
	}
	if (relPath === "wiki/skills-harvest.jsonl") return allow("skill harvest log is checkpointable");

	if (!taskDir) return deny("no selected task in workflow state");
	if (relPath.startsWith(`${taskDir}/docs/`)) return allow("selected task docs are checkpointable");
	if (/^tasks\/[^/]+\/(benchmark\.csv|candidates\.jsonl|leaderboard\.jsonl|workload_latency\.csv)$/u.test(relPath)) {
		return relPath.startsWith(`${taskDir}/`) ? allow("selected task evidence is checkpointable") : deny("cross-task evidence is not checkpointed");
	}
	if (relPath.startsWith(`${taskDir}/`)) {
		const local = relPath.slice(taskDir.length + 1);
		if (isAllowedSelectedTaskFile(local)) return allow("selected task candidate source is checkpointable");
		return deny("selected task change is outside checkpoint allowlist");
	}
	if (/^tasks\/[^/]+\//u.test(relPath)) return deny("cross-task changes are not checkpointed");
	return deny("path is outside checkpoint allowlist");
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
