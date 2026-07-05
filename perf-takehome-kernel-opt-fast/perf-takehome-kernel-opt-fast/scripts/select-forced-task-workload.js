const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "perf-takehome-kernel-opt");
const { laneFromContext, laneOutputDir, lanePatch } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const campaign = workflowContext.state?.campaign ?? {};
const leaderboard = workflowContext.state?.leaderboard ?? {};

// Single perf-takehome task. Always the same bookkeeping dir; the scored file is perf_takehome.py.
const forcedTaskDir = campaign.forcedTaskDir || "tasks/kernel_opt";
const taskDir = path.join(root, forcedTaskDir);
await fs.mkdir(path.join(taskDir, "docs"), { recursive: true });

const existingBest = (leaderboard.best_by_task ?? []).find((row) => row.task_dir === forcedTaskDir);
const selection = {
	task_dir: forcedTaskDir,
	reason: "single perf-takehome kernel optimization task",
	workload_focus: "do_kernel_test(forest_height=10, rounds=16, batch_size=256) on the frozen simulator",
	expected_bottleneck: "instruction-bundle (cycle) count: scalar per-lane work not vectorized/packed across VLIW slots",
	profile_policy: "no external profiler; use the cycle count and the Perfetto trace (perf_takehome.py Tests.test_kernel_trace) if needed",
	reward_hack_watchlist: [
		"do not edit problem.py, tests/, or frozen_problem.py",
		"do not hard-code reference outputs or precompute per-seed answers",
		"do not bypass the simulator or break the pause/yield contract",
	],
	forced: true,
	ordered: false,
	lane,
	order: 1,
	group: "perf-takehome",
	existing_best_candidate: existingBest?.candidate ?? "",
};

const outputDir = laneOutputDir(path, root, lane, forcedTaskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "forced-task-selection.json");
await fs.writeFile(outputPath, JSON.stringify(selection, null, 2) + "\n");

return {
	summary: `selected ${forcedTaskDir} (perf take-home)`,
	data: selection,
	statePatch: [lanePatch(lane, "selection", selection)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};
