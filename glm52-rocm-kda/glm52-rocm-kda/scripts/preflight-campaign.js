const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.env.GLM52_KDA_CAMPAIGN_ROOT || process.cwd();
const outDir = path.join(root, "workflow-output");
await fs.mkdir(outDir, { recursive: true });

const python = process.env.ROCM_TORCH_PYTHON ||
	(process.env.ROCM_TORCH_VENV ? `${process.env.ROCM_TORCH_VENV}/bin/python` : "/home/lichangye/venvs/rocm-torch/bin/python");

const proc = Bun.spawn([python, "tools/validate_campaign.py", "--formal-canary"], {
	cwd: root,
	stdout: "pipe",
	stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);
const report = {
	root,
	exitCode,
	stdout: stdout.trim().slice(-4000),
	stderr: stderr.trim().slice(-4000),
	started_at: new Date().toISOString(),
};
await fs.writeFile(path.join(outDir, "omh-preflight.json"), JSON.stringify(report, null, 2) + "\n");
if (exitCode !== 0) {
	throw new Error(`campaign preflight failed: ${stderr || stdout}`);
}

const tasks = JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));
return {
	summary: `GLM52 KDA formal preflight passed for ${tasks.tasks.length} operator tasks`,
	data: report,
	statePatch: [
		{ op: "set", path: "/campaign/root", value: root },
		{ op: "set", path: "/campaign/tasks", value: tasks.tasks },
		{ op: "set", path: "/campaign/baseline", value: tasks.baseline },
		{ op: "set", path: "/config", value: {
			workerLanes: 3,
			searchAgents: 2,
			strictJudge: "kernel_harness_rocm_formal",
			formalTestScript: "scripts/formal-test.js",
			formalTestCommand: "tools/workflow_formal_test.sh <operator_id> <smoke|visible-probe|shape|full> [M]",
		} },
		{ op: "set", path: "/wiki/index", value: "wiki/index.md" },
	],
	artifacts: ["local://workflow-output/omh-preflight.json"],
};
