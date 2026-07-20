import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	activeTaskLocks,
	applyStintControls,
	continuousCampaignControls,
	parseFinalWorkflowJson,
	shouldCircuitBreak,
} from "./supervise-campaign";
import {
	directionNormalizedImprovement,
	preferredCoverageTasks,
	summarizeWindowTaskEvents,
} from "./agentkaggle-opt-sol/scripts/campaign-controls.js";

const controls = {
	version: 2,
	window_id: "w1",
	started_at: "2026-07-17T00:00:00Z",
	expires_at: "2026-07-17T08:00:00Z",
	phase: "continuous",
	priority_tasks: [],
	coverage_mode: "hybrid",
	max_no_improve_rounds: 3,
	max_recovery_attempts: 1,
	task_quarantine: {},
	submission_freeze: {},
};

describe("campaign supervisor", () => {
	it("tracks direction-normalized improvement and resets a three-round window stall", () => {
		expect(directionNormalizedImprovement(null, 10, true)).toBe(true);
		expect(directionNormalizedImprovement(10, 11, true)).toBe(false);
		expect(directionNormalizedImprovement(10, 9, true)).toBe(true);
		const stats = summarizeWindowTaskEvents([
			{ event: "acquired", at: "2026-07-18T00:01:00Z", task_dir: "x01" },
			{ event: "validated_round", at: "2026-07-18T00:02:00Z", task_dir: "x01", improved: false },
			{ event: "validated_round", at: "2026-07-18T00:03:00Z", task_dir: "x01", improved: false },
			{ event: "validated_round", at: "2026-07-18T00:04:00Z", task_dir: "x01", improved: false },
			{ event: "recovery_started", at: "2026-07-18T00:05:00Z", task_dir: "x01" },
		], "2026-07-18T00:00:00Z").get("x01");
		expect(stats).toMatchObject({ visit_count: 1, no_improve_streak: 3, stalled: true, recovery_count: 1 });

		const recovered = summarizeWindowTaskEvents([
			{ event: "validated_round", at: "2026-07-18T00:04:00Z", task_dir: "x01", improved: false },
			{ event: "validated_round", at: "2026-07-18T00:05:00Z", task_dir: "x01", improved: true },
		], "2026-07-18T00:00:00Z").get("x01");
		expect(recovered).toMatchObject({ no_improve_streak: 0, stalled: false });
	});

	it("prioritizes global unstarted coverage before current-window gaps", () => {
		expect(preferredCoverageTasks(["x03"], ["x04", "x05"])).toEqual(["x03"]);
		expect(preferredCoverageTasks([], ["x04", "x05"])).toEqual(["x04", "x05"]);
	});

	it("creates one continuous hybrid-coverage window", () => {
		const value = continuousCampaignControls("w2", "2026-07-18T00:00:00Z", "2026-07-18T08:00:00Z");
		expect(value.phase).toBe("continuous");
		expect(value.priority_tasks).toEqual([]);
		expect(value.max_no_improve_rounds).toBe(3);
		expect(value.max_recovery_attempts).toBe(1);
	});

	it("discovers active task locks for recovery rotation", async () => {
		const dir = await fs.mkdtemp("/tmp/omh-supervisor-locks-");
		const lock = path.join(dir, "runs", "active-task-locks", "x02-demo.lock");
		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ task_dir: "x02-demo", lane: "A" }));
		await expect(activeTaskLocks(dir)).resolves.toEqual([
			{ task_dir: "x02-demo", lane: "A", lock_dir: lock },
		]);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("quarantines three repeated stint failures and freezes failed submissions", () => {
		const events = [1, 2, 3].flatMap(index => [
			{
				event: "released",
				at: `2026-07-17T0${index}:00:00Z`,
				task_dir: "x06-widsdatathon2024-challenge1",
				failure_fingerprint: "validation: dependency failure",
				submission_status: index === 2 ? "upload_failed" : "",
			},
			{
				event: "validated_round",
				at: `2026-07-17T0${index}:30:00Z`,
				task_dir: "x06-widsdatathon2024-challenge1",
				improved: false,
			},
		]);
		const next = applyStintControls(structuredClone(controls), events, "2026-07-17T03:01:00Z");
		expect(next.task_quarantine["x06-widsdatathon2024-challenge1"]).toBeDefined();
		expect(next.submission_freeze["x06-widsdatathon2024-challenge1"]).toBeDefined();
	});

	it("requires three identical quick failures for the global circuit breaker", () => {
		expect(shouldCircuitBreak([
			{ fingerprint: "quota", quick: true },
			{ fingerprint: "quota", quick: true },
			{ fingerprint: "quota", quick: true },
		])).toBe(true);
		expect(shouldCircuitBreak([
			{ fingerprint: "quota", quick: true },
			{ fingerprint: "network", quick: true },
			{ fingerprint: "quota", quick: true },
		])).toBe(false);
	});

	it("parses the final workflow JSON line from mixed output", () => {
		expect(parseFinalWorkflowJson('log line\n{"run":{"status":"completed"}}\n')).toEqual({
			run: { status: "completed" },
		});
	});

	it("passes the submission artifact into both kernel submission routes", async () => {
		const source = await fs.readFile(
			path.join(import.meta.dir, "agentkaggle-opt-sol", "scripts", "promote-and-update-leaderboard.js"),
			"utf8",
		);
		expect(source).toContain("kernelRouteSubmit(kernelMetaPath, submissionFile, {");
		expect(source).toContain("kernelRouteSubmit(kernelMetaPath, submissionFile);");
		expect(source).toContain("async function kernelRouteSubmit(kernelMetaPath, submissionFile,");
	});
});
