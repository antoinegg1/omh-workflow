const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, lanePatch, laneState, readJsonlSafe, remotePrimaryBeats, taskArtifactDir } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const taskContext = local.taskContext ?? {};
const taskDir = taskContext.task_dir ?? "";
if (!taskDir) throw new Error("restore-best-candidate requires taskContext.task_dir");
const scope = /StintBest/u.test(String(workflowContext.node?.id ?? "")) ? "stint" : "round";
const stintTs = local.stintBudget?.stint_ts ?? "";
const roundId = local.stintBudget?.round_id ?? "";
const artifactDir = taskArtifactDir(path, root, taskDir);
const rows = (await readJsonlSafe(fs, path.join(artifactDir, "candidates.jsonl"))).filter(
	(row) => row?.stint_ts === stintTs && row?.reward_passed === true && (scope === "stint" || row?.round_id === roundId),
);
const best = chooseBest(rows, Boolean(taskContext.objective?.higher_is_better));
let restored = false;
if (best?.artifact && taskContext.instance_dir) {
	const sourceDir = path.join(root, best.artifact, "solution");
	const targetDir = path.join(taskContext.instance_dir, "solution");
	if (await exists(sourceDir)) {
		await fs.rm(targetDir, { recursive: true, force: true });
		await fs.cp(sourceDir, targetDir, { recursive: true });
		restored = true;
	} else if (taskContext.edit_file && (await exists(path.join(root, best.artifact, taskContext.edit_file)))) {
		await fs.copyFile(path.join(root, best.artifact, taskContext.edit_file), path.join(targetDir, taskContext.edit_file));
		restored = true;
	}
}
const result = {
	task_dir: taskDir,
	scope,
	stint_ts: stintTs,
	round_id: roundId,
	candidate: best?.candidate ?? "",
	artifact: best?.artifact ?? "",
	score: best?.score ?? null,
	cost: best?.cost ?? null,
	kaggle_public: best?.kaggle_public ?? null,
	solution_hash: best?.solution_hash ?? "",
	restored,
	closing: true,
	eligible_candidates: rows.length,
};
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `restore-${scope}-best-candidate.json`);
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: `${lane ? `slot ${lane}: ` : ""}${restored ? `restored ${scope} best ${result.candidate}` : `no ${scope} best snapshot to restore`}`,
	data: result,
	statePatch: [lanePatch(lane, "roundBest", result)],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function chooseBest(rows, higherIsBetter) {
	return rows.reduce((best, row) => (remotePrimaryBeats(row, best, higherIsBetter) ? row : best), null);
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
