// Optional diagnostics (filename kept from the kernel fork; NCU is gone).
// When the performance reviewer sets profile_required=true (or AGK_RUN_DIAG=1),
// run a fuller local evaluation inside the GPU pool and archive the output as a
// diagnostics report under runs/<task>/<candidate>/ for the next planning round.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, taskArtifactDir, withGpuPool } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const instanceDir = taskContext.instance_dir ?? "";
const shouldProfile =
	process.env.AGK_RUN_DIAG === "1" ||
	(validation.status === "passed" && Boolean(instanceDir) && profileRequested(performanceReview));

const profile = {
	task_dir: taskContext.task_dir ?? "",
	candidate: validation.candidate ?? "",
	required: Boolean(shouldProfile),
	status: "skipped",
	reason: "Diagnostics run only when the performance reviewer sets profile_required=true.",
	report_path: "",
};

if (shouldProfile) {
	const candidate = validation.candidate || `candidate_${Date.now()}`;
	const runTag = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
	const diagDir = path.join(taskArtifactDir(path, root, taskContext.task_dir), "diagnostics", candidate);
	await fs.mkdir(diagDir, { recursive: true });

	// A fuller evaluation pass than the fast iteration signal (no subset truncation).
	const configuredEval = String(
		taskContext.commands?.local_eval_profile ?? taskContext.commands?.local_eval_full ?? "python evaluation/local_eval.py",
	)
		.replace(/\s+--full-fit\b/gu, "")
		.trim();
	const evalCmd = (configuredEval || "python evaluation/local_eval.py")
		.replace(/^python3?\s+/u, "")
		.split(/\s+/u)
		.filter(Boolean);
	const run = await withGpuPool(
		fs,
		path,
		root,
		{ lane, task_dir: taskContext.task_dir, kind: "diagnostics", candidate },
		async (slot) => {
			const proc = Bun.spawn(["python3", ...evalCmd], {
				cwd: instanceDir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CUDA_VISIBLE_DEVICES: String(slot) },
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { stdout, stderr, exitCode };
		},
	);

	const reportPath = path.join(diagDir, `REPORT-${runTag}.md`);
	await fs.writeFile(
		reportPath,
		[
			`# Diagnostics: ${taskContext.task_name ?? taskContext.task_dir}`,
			"",
			`- Candidate: ${candidate}`,
			`- Run tag: ${runTag}`,
			`- Command: python3 ${evalCmd.join(" ")}`,
			`- Exit code: ${run.exitCode}`,
			"",
			"## Full evaluation stdout",
			"",
			"```",
			run.stdout.slice(-12000),
			"```",
			"",
			"## stderr tail",
			"",
			"```",
			run.stderr.slice(-4000),
			"```",
			"",
		].join("\n"),
	);
	profile.status = run.exitCode === 0 ? "completed" : "failed";
	profile.reason = run.exitCode === 0 ? "full-evaluation diagnostics captured" : "diagnostics evaluation exited non-zero";
	profile.report_path = path.relative(root, reportPath);
}

const outputDir = laneOutputDir(path, root, lane, taskContext.task_dir ?? "");
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "optional-profile-h800.json");
await fs.writeFile(outputPath, JSON.stringify(profile, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}diagnostics ${profile.status}: ${profile.reason}`,
	data: profile,
	statePatch: [lanePatch(lane, "profile", profile)],
	artifacts: [`local://${path.relative(root, outputPath)}`].concat(profile.report_path ? [`local://${profile.report_path}`] : []),
};

function profileRequested(value) {
	if (!value) return false;
	if (value.profile_required === true) return true;
	if (value.data?.profile_required === true) return true;
	if (typeof value === "string") return /\bprofile_required\b\s*[:=]\s*true\b/u.test(value.toLowerCase());
	return false;
}
