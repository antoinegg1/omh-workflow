const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const outputDir = path.join(root, "workflow-output");
await fs.mkdir(outputDir, { recursive: true });

const baseline = {
	root,
	createdAt: new Date().toISOString(),
	gitHead: await currentGitHead(),
	policy: "humanize-style-baseline-plus-allowlist",
	ignoredPrefixes: [
		".git/",
		"workflow-output/",
		"tasks/*/runs/",
		"tasks/*/profile/",
		"**/__pycache__/",
	],
	files: await snapshot(root),
};

const baselinePath = path.join(outputDir, "protected-files-baseline.json");
await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");

return {
	summary: `protected file baseline captured (${Object.keys(baseline.files).length} files)`,
	data: {
		status: "baseline",
		file_count: Object.keys(baseline.files).length,
		baseline_path: path.relative(root, baselinePath),
		git_head: baseline.gitHead,
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
				git_head: baseline.gitHead,
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
		const relPath = toRel(filePath);
		if (ignored(relPath, entry)) continue;
		if (entry.isDirectory()) {
			await walk(filePath, visit);
		} else {
			await visit(filePath, relPath, entry);
		}
	}
}

function toRel(filePath) {
	return path.relative(root, filePath).split(path.sep).join("/");
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

async function currentGitHead() {
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${stderr || stdout}`);
	return stdout.trim();
}
