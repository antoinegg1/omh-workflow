import fs from "node:fs/promises";
import path from "node:path";
import { milestoneState, readProgressiveTargets, snapshotTaskFor } from "./progressive-goals.js";

const START = "<!-- progressive-goal:start -->";
const END = "<!-- progressive-goal:end -->";

export async function syncAllTaskGoals(root) {
	const manifest = JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));
	const snapshot = await readProgressiveTargets(fs, path, root);
	const leaderboard = await readJson(path.join(root, "leaderboard.json"), { best_by_task: [] });
	const rowByDir = new Map((leaderboard.best_by_task ?? []).map((row) => [row.task_dir, row]));
	for (const task of manifest.tasks ?? []) {
		await syncTaskGoal(root, task.task_dir, { manifest, snapshot, leaderboard, row: rowByDir.get(task.task_dir) ?? null });
	}
}

export async function syncTaskGoal(root, taskDir, loaded = {}) {
	const manifest = loaded.manifest ?? JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"));
	const task = (manifest.tasks ?? []).find((item) => item.task_dir === taskDir);
	if (!task) return;
	const snapshot = loaded.snapshot ?? await readProgressiveTargets(fs, path, root);
	const leaderboard = loaded.leaderboard ?? await readJson(path.join(root, "leaderboard.json"), { best_by_task: [] });
	const row = loaded.row ?? (leaderboard.best_by_task ?? []).find((item) => item.task_dir === taskDir) ?? null;
	const snapshotTask = snapshotTaskFor(snapshot, taskDir);
	const state = milestoneState(task, row?.kaggle_public, snapshotTask);
	const taskPath = path.join(root, taskDir, "TASK.md");
	let text = await fs.readFile(taskPath, "utf8");
	const stat = await fs.lstat(taskPath);
	if (stat.isSymbolicLink()) {
		await fs.unlink(taskPath);
		await fs.writeFile(taskPath, text);
	}
	const block = goalBlock(task, state, row, snapshot);
	const start = text.indexOf(START);
	const end = text.indexOf(END);
	if (start >= 0 && end > start) {
		text = `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
	} else {
		const firstLineEnd = text.indexOf("\n");
		text = firstLineEnd >= 0
			? `${text.slice(0, firstLineEnd + 1)}\n${block}\n${text.slice(firstLineEnd + 1)}`
			: `${text}\n\n${block}\n`;
	}
	await writeAtomic(taskPath, text.replace(/\n{4,}/gu, "\n\n\n"));
}

function goalBlock(task, state, row, snapshot) {
	const lines = [START, "## Current Campaign Goal", ""];
	if (!state.enabled) {
		lines.push(
			"This task is disabled for the current progressive campaign.",
			`Reason: ${task.disabled_reason || "the current scorer or task contract is not reliable enough for an honest percentile milestone"}.`,
		);
	} else if (state.goal_complete) {
		lines.push(
			`Completed: the best Kaggle public score ${formatScore(row?.kaggle_public)} reaches the frozen Top 1% cutoff ${comparison(task)} ${formatScore(state.target_top1)}.`,
			"The task is not eligible for another worker lane unless a later manual leaderboard refresh reclassifies it.",
		);
	} else {
		const label = state.active_goal === "top5" ? "Top 5%" : state.active_goal === "top3" ? "Top 3%" : "Top 1%";
		lines.push(
			`Current progressive target: reach ${label} on the Kaggle public leaderboard (${comparison(task)} ${formatScore(state.active_target)}).`,
			"A scored submission that reaches this cutoff releases the lane; the coordinator then decides whether and when to pursue the next milestone.",
		);
		if (row?.kaggle_public !== null && row?.kaggle_public !== undefined) {
			lines.push(`Current recorded best Kaggle public score: ${formatScore(row.kaggle_public)}.`);
		}
	}
	lines.push(
		`Threshold snapshot: ${snapshot.snapshot_id || "legacy task manifest"}.`,
		"This managed campaign goal overrides older static completion wording elsewhere in this task package. Local evaluation is an iteration signal only.",
		"",
		END,
	);
	return lines.join("\n");
}

function comparison(task) {
	return task.higher_is_better ? ">=" : "<=";
}

function formatScore(value) {
	const number = Number(value);
	return Number.isFinite(number) ? String(number) : "not scored";
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}

async function writeAtomic(file, content) {
	const tmp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(tmp, content);
	await fs.rename(tmp, file);
}

if (import.meta.main) {
	const rootArg = process.argv.indexOf("--root");
	const root = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : process.cwd();
	await syncAllTaskGoals(root);
	console.log(`synchronized progressive TASK goals under ${root}`);
}

