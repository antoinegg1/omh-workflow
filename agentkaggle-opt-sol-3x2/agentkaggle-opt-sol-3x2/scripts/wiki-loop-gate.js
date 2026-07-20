// Wiki-search lane gate. Serves two roles with one node:
//   - entry (from loadSkillsAndWiki): campaign.continue is truthy at start -> proceed to topic selection.
//   - loop tail (from wikiWrite): re-check campaign.continue; loop or end the lane.
// Also assembles a compact snapshot of what each worker lane is currently
// optimizing, so the topic selector can prefer active operators.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const campaign = state.campaign ?? {};

// campaign.continue is set false only when all selected tasks are done/parked.
// undefined (very first entry) is treated as "continue".
const cont = campaign.continue !== false;

const laneTasks = [];
for (const lane of ["A", "B", "C"]) {
	const tc = state.lanes?.[lane]?.taskContext ?? {};
	const dir = tc.task_dir || tc.task_name || "";
	if (dir) {
		laneTasks.push({
			lane,
			task_dir: dir,
			operator: tc.operator || tc.task_name || basename(dir),
		});
	}
}

const loop = {
	continue: cont,
	laneTasks,
	stalledTasks: campaign.taskUpdates?.coverage?.stalled_tasks ?? [],
	coverageGaps: campaign.taskUpdates?.coverage?.preferred_tasks ?? [],
	coverage: campaign.taskUpdates?.coverage ?? {},
	openCount: campaign.progress?.openCount ?? null,
	reason: cont ? "campaign in progress" : "campaign complete — ending wiki lane",
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", "wiki-loop-gate.json"),
	JSON.stringify(loop, null, 2) + "\n",
);

return {
	summary: `wiki lane ${cont ? "continue" : "end"} (${laneTasks.length} active lane task(s))`,
	data: loop,
	statePatch: [{ op: "set", path: "/lanes/W/loop", value: loop }],
	artifacts: ["local://workflow-output/wiki-loop-gate.json"],
};

function basename(p) {
	const parts = String(p).split("/").filter(Boolean);
	return parts.length ? parts[parts.length - 1] : String(p);
}
