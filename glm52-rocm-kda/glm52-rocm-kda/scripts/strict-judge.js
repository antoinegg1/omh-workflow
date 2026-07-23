const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.env.GLM52_KDA_CAMPAIGN_ROOT || process.cwd();
const lane = process.env.GLM52_KDA_LANE || "A";
const task = process.env.GLM52_KDA_TASK;
const submission = process.env.GLM52_KDA_SUBMISSION;
if (!task || !submission) {
	throw new Error("GLM52_KDA_TASK and GLM52_KDA_SUBMISSION are required");
}

const python = process.env.ROCM_TORCH_PYTHON ||
	(process.env.ROCM_TORCH_VENV ? `${process.env.ROCM_TORCH_VENV}/bin/python` : "/home/lichangye/venvs/rocm-torch/bin/python");

const outDir = path.join(root, "workflow-output", "lanes", lane);
await fs.mkdir(outDir, { recursive: true });
const reportPath = path.join(outDir, "strict-judge.json");
const stdoutPath = path.join(outDir, "strict-judge.stdout.log");
const stderrPath = path.join(outDir, "strict-judge.stderr.log");

const proc = Bun.spawn(
	[
		python,
		"tools/formal_eval.py",
		"--task",
		task,
		"--submission",
		submission,
		"--json-out",
		reportPath,
	],
	{ cwd: root, stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);
await fs.writeFile(stdoutPath, stdout);
await fs.writeFile(stderrPath, stderr);
let data = null;
try {
	data = JSON.parse(await fs.readFile(reportPath, "utf8"));
} catch {
	try {
		data = JSON.parse(stdout);
	} catch {
		data = { status: exitCode === 0 ? "passed" : "failed", stdout_tail: stdout.slice(-2000), stderr_tail: stderr.slice(-2000) };
	}
}
if (exitCode !== 0) {
	const aggregate = data?.aggregate ? JSON.stringify(data.aggregate) : "no aggregate";
	const status = data?.status || "failed";
	const stderrTail = stderr ? ` stderr_tail=${stderr.trim().slice(-500)}` : "";
	throw new Error(`formal strict judge failed for ${task}: status=${status} exit=${exitCode} aggregate=${aggregate}${stderrTail}`);
}
return {
	summary: `formal strict judge ${data.status} for ${task}`,
	data,
	statePatch: [{ op: "set", path: `/lanes/${lane}/strictJudge`, value: data }],
	artifacts: [
		`local://workflow-output/lanes/${lane}/strict-judge.json`,
		`local://workflow-output/lanes/${lane}/strict-judge.stdout.log`,
		`local://workflow-output/lanes/${lane}/strict-judge.stderr.log`,
	],
};
