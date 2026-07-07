const fs = await import("node:fs/promises");
const path = await import("node:path");

const scriptRel = Bun.argv[2];
if (!scriptRel) {
	throw new Error("run-js-workflow-script.js requires a script path argument");
}

const resourceRoot = process.env.OMP_WORKFLOW_RESOURCE_DIR;
if (!resourceRoot) {
	throw new Error("OMP_WORKFLOW_RESOURCE_DIR is not set");
}

const rawContext = process.env.OMP_WORKFLOW_CONTEXT_FILE
	? await fs.readFile(process.env.OMP_WORKFLOW_CONTEXT_FILE, "utf8")
	: (process.env.OMP_WORKFLOW_CONTEXT ?? "{}");
const workflowContext = JSON.parse(rawContext);
if (!workflowContext.resources) {
	workflowContext.resources = { root: resourceRoot };
}

const scriptPath = path.resolve(resourceRoot, scriptRel);
const relative = path.relative(resourceRoot, scriptPath);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
	throw new Error(`workflow script escapes resource root: ${scriptRel}`);
}

const code = await fs.readFile(scriptPath, "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("workflowContext", "OMP_WORKFLOW_CONTEXT", code);
const result = await run(workflowContext, workflowContext);
if (result !== undefined) {
	console.log(JSON.stringify(result));
}
