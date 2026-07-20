import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncAllTaskGoals } from "./sync-progressive-goals.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("progressive TASK goal sync", () => {
	test("localizes a shared TASK symlink and discloses only the next milestone", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-goal-"));
		roots.push(root);
		const shared = path.join(root, "shared.md");
		const taskDir = path.join(root, "x01-demo");
		await fs.mkdir(taskDir);
		await fs.writeFile(shared, "# Demo\n\n## Goal\nLegacy goal.\n");
		await fs.symlink(shared, path.join(taskDir, "TASK.md"));
		await fs.writeFile(path.join(root, "tasks.json"), JSON.stringify({ tasks: [{ task_dir: "x01-demo", enabled: true, higher_is_better: true, target_top5: 5, target_top3: 7, target_top1: 9 }] }));
		await fs.writeFile(path.join(root, "progressive_targets.json"), JSON.stringify({ snapshot_id: "s1", tasks: [{ task_dir: "x01-demo", enabled: true, target_top5: 5, target_top3: 7, target_top1: 9 }] }));
		await fs.writeFile(path.join(root, "leaderboard.json"), JSON.stringify({ best_by_task: [{ task_dir: "x01-demo", kaggle_public: 6 }] }));

		await syncAllTaskGoals(root);
		const stat = await fs.lstat(path.join(taskDir, "TASK.md"));
		const text = await fs.readFile(path.join(taskDir, "TASK.md"), "utf8");
		expect(stat.isSymbolicLink()).toBe(false);
		expect(text).toContain("reach Top 3%");
		expect(text).not.toContain("Current progressive target: reach Top 1%");
		expect(await fs.readFile(shared, "utf8")).toBe("# Demo\n\n## Goal\nLegacy goal.\n");
	});
});

