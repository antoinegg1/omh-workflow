const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const validation = localState.validation ?? state.validation ?? {};

// No external profiler for the pure-Python simulator. Profiling here means inspecting the instruction
// schedule / cycle breakdown via the Perfetto trace (python perf_takehome.py Tests.test_kernel_trace),
// which the agent can run itself. This node is a no-op that records that guidance.
const profile = {
	task_dir: taskContext.task_dir ?? "tasks/kernel_opt",
	candidate: validation.candidate ?? "",
	required: false,
	status: "skipped",
	reason: "No external profiler for the simulator. To inspect the schedule, run `python perf_takehome.py Tests.test_kernel_trace` then `python watch_trace.py` (Chrome/Perfetto).",
	report_path: "",
};

const outputDir = laneOutputDir(path, root, lane, taskContext.task_dir ?? "");
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "optional-profile.json");
await fs.writeFile(outputPath, JSON.stringify(profile, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}profile skipped (simulator: use test_kernel_trace)`,
	data: profile,
	statePatch: [lanePatch(lane, "profile", profile)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};
