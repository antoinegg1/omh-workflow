const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "sol-h800-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const shouldProfile =
	process.env.SOL_H800_RUN_NCU === "1" ||
	(validation.status === "passed" && validation.metrics?.median_ms && profileRequested(performanceReview));

const profile = {
	task_dir: taskContext.task_dir ?? "",
	candidate: validation.candidate ?? "",
	required: Boolean(shouldProfile),
	status: "skipped",
	reason: "Set SOL_H800_RUN_NCU=1 or have the reviewer request profile_required=true to run NCU.",
	report_path: "",
};

if (shouldProfile) {
	const candidate = validation.candidate || `candidate_${Date.now()}`;
	const runTag = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
	const profileDir = path.join(root, taskContext.task_dir, "profile", candidate, runTag);
	await fs.mkdir(path.join(profileDir, "harness"), { recursive: true });
	await fs.mkdir(path.join(profileDir, "reports"), { recursive: true });
	await fs.mkdir(path.join(profileDir, "analysis"), { recursive: true });
	const command = [
		"# Fill in a workload-specific NCU command before running manually.",
		"# See .omp/skills/ncu-h800-report/references/kda-ncu-h800.md.",
		"HELPERS=/mnt/public/lichangye/kernel-design-agents/skills/ncu-report-skill/helpers",
		`PROFILE_RUN_DIR=${path.relative(root, profileDir)}`,
		`python3 /mnt/public/lichangye/kernel-opt/scripts/run_h800_task.py ${taskContext.task_dir} --solution-name ${validation.solution ?? "solution.json"} --candidate ${candidate}`,
	].join("\n");
	await fs.writeFile(path.join(profileDir, "command.txt"), command + "\n");
	await fs.writeFile(
		path.join(profileDir, "REPORT.md"),
		[
			`# NCU Profile Plan: ${taskContext.task_name ?? taskContext.task_dir}`,
			"",
			"- Status: pending-manual-ncu",
			"- Hardware: H800 / SM90",
			"- Candidate: " + candidate,
			"- Run tag: " + runTag,
			"- Adapted instructions: `.omp/skills/ncu-h800-report/references/kda-ncu-h800.md`",
			"",
			"Record NCU metrics, diagnosis, next experiments, and reward-hack concerns here.",
			"",
		].join("\n"),
	);
	profile.status = "planned";
	profile.reason = "profile requested; NCU command scaffold created";
	profile.report_path = path.relative(root, path.join(profileDir, "REPORT.md"));
}

const outputDir = laneOutputDir(path, root, lane, taskContext.task_dir ?? "");
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "optional-profile-h800.json");
await fs.writeFile(outputPath, JSON.stringify(profile, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}H800 profile ${profile.status}: ${profile.reason}`,
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
