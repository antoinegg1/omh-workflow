import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { milestoneState, percentileCutoff } from "./progressive-goals.js";
import { syncAllTaskGoals } from "./sync-progressive-goals.js";

const argv = process.argv.slice(2);
const root = path.resolve(valueAfter("--root") || process.cwd());
const kaggleBin = valueAfter("--kaggle-bin") || process.env.KAGGLE_BIN || "/root/agentkaggle-v2/runtime-venv/bin/kaggle";
const manifestPath = path.join(root, "tasks.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const enabledTasks = (manifest.tasks ?? []).filter((task) => task.enabled !== false);
const generatedAt = new Date().toISOString();
const snapshotId = generatedAt.replaceAll(":", "").replaceAll(".", "");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentkaggle-progressive-"));
const rawDir = path.join(tempRoot, "raw");
await fs.mkdir(rawDir, { recursive: true });

try {
	const targets = [];
	for (const task of enabledTasks) {
		const downloadDir = path.join(tempRoot, "download", task.comp_slug);
		await fs.mkdir(downloadDir, { recursive: true });
		await run([kaggleBin, "competitions", "leaderboard", task.comp_slug, "--download", "--path", downloadDir, "--quiet"]);
		const zipPath = (await fs.readdir(downloadDir)).map((name) => path.join(downloadDir, name)).find((file) => file.endsWith(".zip"));
		if (!zipPath) throw new Error(`leaderboard download produced no zip for ${task.comp_slug}`);
		const member = (await run(["unzip", "-Z1", zipPath])).stdout.trim().split("\n")[0];
		const csvText = (await run(["unzip", "-p", zipPath, member])).stdout.replace(/^\uFEFF/u, "");
		const rows = parseCsv(csvText);
		if (rows.length === 0 || !("Score" in rows[0])) throw new Error(`invalid leaderboard CSV for ${task.comp_slug}`);
		const scores = rows.map((row) => Number(row.Score)).filter(Number.isFinite);
		if (scores.length !== rows.length) throw new Error(`non-numeric leaderboard score for ${task.comp_slug}`);
		const target = {
			order: task.order,
			sol_id: task.sol_id,
			task_dir: task.task_dir,
			competition: task.comp_slug,
			metric: task.metric,
			higher_is_better: Boolean(task.higher_is_better),
			enabled: true,
			n_teams: scores.length,
			...cutoffFields(scores, 0.05, "top5"),
			...cutoffFields(scores, 0.03, "top3"),
			...cutoffFields(scores, 0.01, "top1"),
			downloaded_at: generatedAt,
			source: "Kaggle public leaderboard download",
		};
		targets.push(target);
		await fs.writeFile(path.join(rawDir, `${task.comp_slug}.csv`), csvText);
	}
	for (const task of (manifest.tasks ?? []).filter((item) => item.enabled === false)) {
		targets.push({
			order: task.order,
			sol_id: task.sol_id,
			task_dir: task.task_dir,
			competition: task.comp_slug,
			metric: task.metric,
			higher_is_better: Boolean(task.higher_is_better),
			enabled: false,
			disabled_reason: task.disabled_reason ?? "disabled in tasks.json",
		});
	}
	targets.sort((a, b) => Number(a.order) - Number(b.order));
	const snapshot = {
		snapshot_id: snapshotId,
		generated_at: generatedAt,
		rank_rule: "rank=max(1, ceil(percent * n_teams)); equality reaches the cutoff",
		score_authority: "Kaggle public leaderboard score",
		tasks: targets,
	};
	const targetByDir = new Map(targets.map((task) => [task.task_dir, task]));
	const nextManifest = {
		...manifest,
		generated_at: generatedAt,
		note: "AgentKaggle campaign manifest; progressive target fields are synchronized from progressive_targets.json",
		tasks: (manifest.tasks ?? []).map((task) => {
			const target = targetByDir.get(task.task_dir);
			return {
				...task,
				enabled: target?.enabled !== false,
				target_top5: target?.target_top5 ?? task.target_top5 ?? null,
				target_top3: target?.target_top3 ?? task.target_top3 ?? null,
				target_top1: target?.target_top1 ?? task.target_top1 ?? null,
				target_snapshot_id: snapshotId,
			};
		}),
	};
	const leaderboardPath = path.join(root, "leaderboard.json");
	const leaderboard = await readJson(leaderboardPath, { best_by_task: [] });
	const taskByDir = new Map(nextManifest.tasks.map((task) => [task.task_dir, task]));
	const bestByTask = (leaderboard.best_by_task ?? []).map((row) => {
		const task = taskByDir.get(row.task_dir);
		if (!task) return row;
		return { ...row, ...milestoneState(task, row.kaggle_public, targetByDir.get(row.task_dir)), threshold_snapshot_id: snapshotId };
	});
	const nextLeaderboard = {
		...leaderboard,
		generated_at: generatedAt,
		best_count: bestByTask.length,
		best_by_task: bestByTask,
	};
	const snapshotRoot = path.join(root, "leaderboard-snapshots");
	await fs.mkdir(snapshotRoot, { recursive: true });
	const latestStaging = path.join(snapshotRoot, `.latest-${snapshotId}`);
	await fs.rm(latestStaging, { recursive: true, force: true });
	await fs.cp(rawDir, latestStaging, { recursive: true });
	await replaceDirectory(latestStaging, path.join(snapshotRoot, "latest"));
	await writeAtomic(path.join(root, "progressive_targets.json"), JSON.stringify(snapshot, null, 2) + "\n");
	await writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 1) + "\n");
	await writeAtomic(leaderboardPath, JSON.stringify(nextLeaderboard, null, 1) + "\n");
	await writeAtomic(path.join(root, "leaderboard.csv"), leaderboardCsv(nextLeaderboard));
	await syncAllTaskGoals(root);
	console.log(JSON.stringify({ snapshot_id: snapshotId, enabled_tasks: enabledTasks.length, leaderboard_rows: bestByTask.length }, null, 2));
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true });
}

function cutoffFields(scores, percent, name) {
	const cutoff = percentileCutoff(scores, percent);
	return { [`${name}_rank`]: cutoff.rank, [`target_${name}`]: cutoff.score };
}

function valueAfter(flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : "";
}

async function run(command) {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
	return { stdout, stderr };
}

function parseCsv(text) {
	const records = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field.replace(/\r$/u, ""));
			records.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field || row.length) {
		row.push(field.replace(/\r$/u, ""));
		records.push(row);
	}
	const header = records.shift() ?? [];
	return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(header.map((name, index) => [name, record[index] ?? ""])));
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}

async function writeAtomic(file, content) {
	const temp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(temp, content);
	await fs.rename(temp, file);
}

async function replaceDirectory(source, destination) {
	const backup = `${destination}.previous-${process.pid}`;
	await fs.rm(backup, { recursive: true, force: true });
	try {
		await fs.rename(destination, backup);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	try {
		await fs.rename(source, destination);
		await fs.rm(backup, { recursive: true, force: true });
	} catch (error) {
		try {
			await fs.rename(backup, destination);
		} catch {
			/* preserve the original error */
		}
		throw error;
	}
}

function leaderboardCsv(leaderboard) {
	const legacy = ["order", "task_dir", "candidate", "metric", "kaggle_public", "kaggle_private", "score", "submission_status", "reached_top1", "target_top1", "promoted_at"];
	const added = ["reached_top5", "target_top5", "reached_top3", "target_top3", "highest_milestone", "milestone_points", "active_goal", "active_target", "goal_complete", "threshold_snapshot_id"];
	const fields = [...legacy, ...added];
	const lines = (leaderboard.best_by_task ?? []).map((row) => fields.map((field) => csvValue(field === "metric" ? row.metric_name : row[field])).join(","));
	return [fields.join(","), ...lines].join("\n") + "\n";
}

function csvValue(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
