const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir;
if (!taskDirRel) throw new Error("implementation-precheck requires /taskContext.task_dir");
const taskDir = path.join(root, taskDirRel);

const candidates = [];
for (const name of ["solution.json", "solution.py"]) {
	const filePath = path.join(taskDir, name);
	if (await exists(filePath)) candidates.push(filePath);
}
for (const entry of await listFiles(taskDir)) {
	if (/^solution.*\.(json|py|cu|cpp|cc|h|hpp)$/u.test(entry) && !candidates.includes(path.join(taskDir, entry))) {
		candidates.push(path.join(taskDir, entry));
	}
}

const warnings = [];
const severe = [];
const forbidden = [
	{ pattern: /traces\.json|h800_latency_summary|workflow-output/u, message: "solution references local benchmark artifacts" },
	{ pattern: /workload[_-]?id|workloadIndex|workload_index/u, message: "solution appears to branch on workload identity" },
	{ pattern: /monkey[_-]?patch|setattr\(torch|torch\.[A-Za-z0-9_]+\s*=/u, message: "solution may monkey patch torch/evaluator behavior" },
	{ pattern: /inspect\.stack|sys\._getframe|traceback\.extract_stack/u, message: "solution appears to inspect evaluator call stack" },
	{ pattern: /\/root\/kernel-opt|\/root\/SOL-ExecBench/u, message: "solution references local absolute paths" },
];

for (const filePath of candidates) {
	const text = await readText(filePath, "");
	for (const rule of forbidden) {
		if (rule.pattern.test(text)) {
			const item = { file: path.relative(root, filePath), message: rule.message };
			warnings.push(item);
			if (!/solution\.json$/u.test(filePath)) severe.push(item);
		}
	}
}

const report = {
	task_dir: taskDirRel,
	candidate_files: candidates.map((filePath) => path.relative(root, filePath)),
	warnings,
	severe,
	status: severe.length > 0 ? "warn" : "pass",
};

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "implementation-precheck.json");
await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${report.status}: checked ${candidates.length} candidate file(s), ${warnings.length} warning(s)`,
	data: report,
	statePatch: [lanePatch(lane, "implementationPrecheck", report)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function listFiles(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}
