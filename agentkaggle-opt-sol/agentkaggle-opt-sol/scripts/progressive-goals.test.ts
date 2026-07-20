import { describe, expect, test } from "bun:test";
import { decorateScoreRow, milestoneState, percentileCutoff, summarizeMilestones, targetReached } from "./progressive-goals.js";

describe("progressive Kaggle goals", () => {
	test("uses inclusive direction-aware cutoffs", () => {
		expect(targetReached(0.9, 0.9, true)).toBe(true);
		expect(targetReached(0.89, 0.9, true)).toBe(false);
		expect(targetReached(10, 10, false)).toBe(true);
		expect(targetReached(11, 10, false)).toBe(false);
	});

	test("uses ceil(percent * teams) with a minimum rank of one", () => {
		expect(percentileCutoff([10, 9, 8], 0.01)).toEqual({ rank: 1, score: 10, n_teams: 3 });
		expect(percentileCutoff(Array.from({ length: 89 }, (_, index) => 100 - index), 0.05).rank).toBe(5);
	});

	test("backfills points when a score jumps milestones", () => {
		const task = { enabled: true, higher_is_better: true, target_top5: 5, target_top3: 7, target_top1: 9 };
		expect(milestoneState(task, 4).milestone_points).toBe(0);
		expect(milestoneState(task, 7)).toMatchObject({ milestone_points: 2, active_goal: "top1", reached_top5: true });
		expect(milestoneState(task, 10)).toMatchObject({ milestone_points: 3, goal_complete: true, active_goal: null });
	});

	test("supports lower-is-better tasks and disabled tasks", () => {
		const task = { enabled: true, higher_is_better: false, target_top5: 20, target_top3: 15, target_top1: 10 };
		expect(milestoneState(task, 14)).toMatchObject({ milestone_points: 2, active_goal: "top1", active_gap: 4 });
		expect(milestoneState({ ...task, enabled: false }, 1)).toMatchObject({ enabled: false, milestone_points: 0, goal_complete: false });
	});

	test("decorates legacy rows and summarizes only enabled tasks", () => {
		const tasks = [
			{ task_dir: "a", enabled: true, higher_is_better: true, target_top5: 1, target_top3: 2, target_top1: 3 },
			{ task_dir: "b", enabled: false, higher_is_better: true, target_top5: 1, target_top3: 2, target_top1: 3 },
		];
		const row = decorateScoreRow({ task_dir: "a", kaggle_public: 2.5 }, tasks[0], null, "s1");
		expect(row).toMatchObject({ reached_top5: true, reached_top3: true, reached_top1: false, threshold_snapshot_id: "s1" });
		expect(summarizeMilestones(tasks, [row])).toMatchObject({ enabled_task_count: 1, disabled_task_count: 1, milestone_points: 2, milestone_max_points: 3 });
	});
});
