// Snapshot the campaign root's protection surface: root coordination files
// (task.md, tasks.json, top1_targets.json) plus every raw task package's
// symlink structure. High-churn runtime trees (runs/, wiki/, workflow-output/,
// leaderboard.*) are excluded — they have their own dedicated guards. Symlinks
// are recorded by target and never followed, so multi-GB data is never hashed.
// The campaign root is not a git repository; no git is used.
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outputDir = path.join(root, "workflow-output");
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { normalizedProtectedFileContent } = await import(
	`file://${path.join(resourceRoot, "scripts", "protected-files-policy.js")}`
);
await fs.mkdir(outputDir, { recursive: true });

const baseline = {
	root,
	createdAt: new Date().toISOString(),
	policy: "campaign-root-baseline-plus-allowlist (no git; symlinks recorded by target, never followed)",
	ignoredPrefixes: ["workflow-output/", "runs/", "wiki/", "leaderboard.json", "leaderboard.csv", "**/__pycache__/"],
	files: await snapshot(root),
};

const baselinePath = path.join(outputDir, "protected-files-baseline.json");
await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");

return {
	summary: `protected file baseline captured (${Object.keys(baseline.files).length} entries)`,
	data: {
		status: "baseline",
		file_count: Object.keys(baseline.files).length,
		baseline_path: path.relative(root, baselinePath),
		policy: baseline.policy,
	},
	statePatch: [
		{
			op: "set",
			path: "/protectedFiles",
			value: {
				status: "baseline",
				file_count: Object.keys(baseline.files).length,
				baseline_path: path.relative(root, baselinePath),
				policy: baseline.policy,
			},
		},
	],
	artifacts: ["local://workflow-output/protected-files-baseline.json"],
};

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
		const relPath = toRel(filePath);
		if (ignored(relPath, entry)) continue;
		if (entry.isSymbolicLink()) {
			await visit(filePath, relPath, entry);
		} else if (entry.isDirectory()) {
			await walk(filePath, visit);
		} else {
			await visit(filePath, relPath, entry);
		}
	}
}

function toRel(filePath) {
	return path.relative(root, filePath).split(path.sep).join("/");
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
