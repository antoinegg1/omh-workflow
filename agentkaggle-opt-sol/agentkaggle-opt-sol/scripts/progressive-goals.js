export const PROGRESSIVE_TARGETS_FILE = "progressive_targets.json";
export const MILESTONES = ["top5", "top3", "top1"];

export function finiteNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function targetReached(score, target, higherIsBetter) {
	const actual = finiteNumber(score);
	const cutoff = finiteNumber(target);
	if (actual === null || cutoff === null) return false;
	return higherIsBetter ? actual >= cutoff : actual <= cutoff;
}

export function targetGap(score, target, higherIsBetter) {
	const actual = finiteNumber(score);
	const cutoff = finiteNumber(target);
	if (actual === null || cutoff === null) return null;
	return Math.max(0, higherIsBetter ? cutoff - actual : actual - cutoff);
}

export function percentileCutoff(scores, percent) {
	const values = (scores ?? []).map(finiteNumber).filter((value) => value !== null);
	if (values.length === 0) throw new Error("cannot compute a percentile cutoff from an empty leaderboard");
	const rank = Math.max(1, Math.ceil(Number(percent) * values.length));
	return { rank, score: values[rank - 1], n_teams: values.length };
}

export function taskTargets(task, snapshotTask = null) {
	const source = snapshotTask ?? {};
	return {
		target_top5: finiteNumber(source.target_top5 ?? task?.target_top5),
		target_top3: finiteNumber(source.target_top3 ?? task?.target_top3),
		target_top1: finiteNumber(source.target_top1 ?? task?.target_top1),
	};
}

export function milestoneState(task, score, snapshotTask = null) {
	const enabled = task?.enabled !== false && snapshotTask?.enabled !== false;
	const higherIsBetter = Boolean(task?.higher_is_better);
	const targets = taskTargets(task, snapshotTask);
	const reached = {
		top5: enabled && targetReached(score, targets.target_top5, higherIsBetter),
		top3: enabled && targetReached(score, targets.target_top3, higherIsBetter),
		top1: enabled && targetReached(score, targets.target_top1, higherIsBetter),
	};
	const points = reached.top1 ? 3 : reached.top3 ? 2 : reached.top5 ? 1 : 0;
	const highest = points === 3 ? "top1" : points === 2 ? "top3" : points === 1 ? "top5" : null;
	const activeGoal = !enabled || reached.top1 ? null : reached.top3 ? "top1" : reached.top5 ? "top3" : "top5";
	const activeTarget = activeGoal ? targets[`target_${activeGoal}`] : null;
	return {
		enabled,
		...targets,
		reached_top5: reached.top5,
		reached_top3: reached.top3,
		reached_top1: reached.top1,
		highest_milestone: highest,
		milestone_points: points,
		active_goal: activeGoal,
		active_target: activeTarget,
		active_gap: activeGoal ? targetGap(score, activeTarget, higherIsBetter) : null,
		goal_complete: enabled && reached.top1,
	};
}

export function decorateScoreRow(row, task, snapshotTask = null, snapshotId = "") {
	return {
		...row,
		...milestoneState(task, row?.kaggle_public, snapshotTask),
		threshold_snapshot_id: snapshotId || row?.threshold_snapshot_id || "",
	};
}

export function summarizeMilestones(tasks, rows, snapshot = null) {
	const snapshotByDir = new Map((snapshot?.tasks ?? []).map((task) => [task.task_dir, task]));
	const rowByDir = new Map((rows ?? []).map((row) => [row.task_dir, row]));
	const states = tasks.map((task) => milestoneState(task, rowByDir.get(task.task_dir)?.kaggle_public, snapshotByDir.get(task.task_dir)));
	const enabled = states.filter((state) => state.enabled);
	return {
		enabled_task_count: enabled.length,
		disabled_task_count: states.length - enabled.length,
		top5_count: enabled.filter((state) => state.reached_top5).length,
		top3_count: enabled.filter((state) => state.reached_top3).length,
		top1_count: enabled.filter((state) => state.reached_top1).length,
		milestone_points: enabled.reduce((sum, state) => sum + state.milestone_points, 0),
		milestone_max_points: enabled.length * 3,
	};
}

export function snapshotTaskFor(snapshot, taskDir) {
	return (snapshot?.tasks ?? []).find((task) => task.task_dir === taskDir) ?? null;
}

export async function readProgressiveTargets(fs, path, root) {
	try {
		return JSON.parse(await fs.readFile(path.join(root, PROGRESSIVE_TARGETS_FILE), "utf8"));
	} catch {
		return { snapshot_id: "", generated_at: "", tasks: [] };
	}
}
