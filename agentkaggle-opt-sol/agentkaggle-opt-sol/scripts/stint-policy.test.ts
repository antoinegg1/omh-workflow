import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const scriptsDir = import.meta.dir;
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("stint and submission policy", () => {
	test("shares a 16-hour optimization budget and a 2-hour finalization grace", async () => {
		const fixture = await makeFixture("stint-budget-");
		const acquiredAt = new Date(Date.now() - 17 * 60 * 60 * 1000).toISOString();
		const outputDir = path.join(fixture.root, "workflow-output", "lanes", "A", "x01-demo");
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(path.join(outputDir, "stint.json"), JSON.stringify({ acquired_at: acquiredAt }));

		const activeGrace = await executeScript(fixture, "stint-budget-gate.js", {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, selectionGuard: { stint_started_at: acquiredAt } } },
		}, "stintBudgetGateA");
		expect(activeGrace.data).toMatchObject({
			can_optimize: false,
			optimization_expired: true,
			finalization_expired: false,
			round_index: 1,
		});

		const expiredAt = new Date(Date.now() - 19 * 60 * 60 * 1000).toISOString();
		await fs.writeFile(path.join(outputDir, "stint.json"), JSON.stringify({ acquired_at: expiredAt }));
		const expiredGrace = await executeScript(fixture, "stint-budget-gate.js", {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, selectionGuard: { stint_started_at: expiredAt } } },
		}, "stintBudgetGateA");
		expect(expiredGrace.data.finalization_expired).toBe(true);
	});

	test("authorizes automatic direct calibration only above five remaining submissions", async () => {
		const fixture = await makeFixture("direct-gate-");
		await fs.writeFile(
			path.join(fixture.root, "tasks.json"),
			JSON.stringify({ tasks: [{ task_dir: "x01-demo", daily_cap: 20 }] }),
		);
		const artifactDir = path.join(fixture.root, "runs", "x01-demo");
		await fs.mkdir(artifactDir, { recursive: true });
		const today = new Date().toISOString();
		await fs.writeFile(
			path.join(artifactDir, "submission_log.jsonl"),
			Array.from({ length: 14 }, (_, index) => JSON.stringify({ submitted_at: today, uploaded: true, status: "scored", kaggle_public: index, candidate: `old-${index}` })).join("\n") + "\n",
		);
		const state = directState();
		const authorized = await executeScript(fixture, "direct-submission-gate.js", state, "directSubmissionGateA");
		expect(authorized.data).toMatchObject({ authorized: true, remaining_today: 6, direct_threshold: 5 });
		const missingHash = structuredClone(state) as any;
		missingHash.lanes.A.validation.solution_hash = "";
		missingHash.lanes.A.stintCandidate.solution_hash = "";
		const unhashed = await executeScript(fixture, "direct-submission-gate.js", missingHash, "directSubmissionGateA");
		expect(unhashed.data).toMatchObject({ authorized: false, reason: "validated candidate has no solution hash" });

		await fs.appendFile(
			path.join(artifactDir, "submission_log.jsonl"),
			JSON.stringify({ submitted_at: today, uploaded: true, status: "scored", kaggle_public: 15, candidate: "fifteenth" }) + "\n",
		);
		const reserved = await executeScript(fixture, "direct-submission-gate.js", state, "directSubmissionGateA");
		expect(reserved.data).toMatchObject({ authorized: false, remaining_today: 5 });

		const skipped = structuredClone(state) as any;
		skipped.lanes.A.implementation = { skip_submit: true };
		expect((await executeScript(fixture, "direct-submission-gate.js", skipped, "directSubmissionGateA")).data.authorized).toBe(false);
	});

	test("does not treat a reward revise verdict as a pass", async () => {
		const fixture = await makeFixture("reward-review-");
		const recorded = await executeScript(fixture, "record-stint-candidate.js", {
			lanes: {
				A: {
					taskContext: { task_dir: "x01-demo" },
					stintBudget: { stint_ts: "s1", round_id: "r1", round_index: 1 },
					validation: { status: "passed", candidate: "c1", solution_hash: "h1", metrics: { score: 0.8, cost: -0.8, metric: "auc" } },
					rewardHackReview: { verdict: "revise" },
					implementation: { skip_submit: false },
				},
			},
		}, "recordStintCandidateA");
		expect(recorded.data).toMatchObject({ reward_passed: false, improved_in_stint: false });
	});

	test("increments only validation-passed outer rounds and stops after five", async () => {
		const fixture = await makeFixture("outer-rounds-");
		const taskDir = "x01-demo";
		const acquiredAt = new Date().toISOString();
		const outputDir = path.join(fixture.root, "workflow-output", "lanes", "A", taskDir);
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(path.join(outputDir, "stint.json"), JSON.stringify({ acquired_at: acquiredAt }));
		const state: any = {
			campaign: { controls: { max_no_improve_rounds: 5, started_at: acquiredAt } },
			lanes: {
				A: {
					taskContext: { task_dir: taskDir },
					stintBudget: { optimization_deadline_at: new Date(Date.now() + 60_000).toISOString() },
					validation: { status: "passed", candidate: "c1" },
					rewardHackReview: { verdict: "pass" },
					performanceReview: { verdict: "revise", optimization_limit_reached: false },
					stintCandidate: { improved_in_round: true },
					taskBestUpdate: { improved_this_round: true, candidate_cost: 1 },
					leaderboardUpdate: {},
				},
			},
		};
		for (let round = 1; round <= 5; round += 1) {
			const gate = await executeScript(fixture, "task-local-loop-gate.js", state, "taskLocalLoopGateA");
			expect(gate.data.round).toBe(round);
			expect(gate.data.continueSameTask).toBe(round < 5);
			state.lanes.A.localLoop = gate.data;
		}
	});

	test("releases the lane on a newly reached progressive milestone", async () => {
		const fixture = await makeFixture("milestone-release-");
		const taskDir = "x01-demo";
		const acquiredAt = new Date().toISOString();
		const outputDir = path.join(fixture.root, "workflow-output", "lanes", "A", taskDir);
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(path.join(outputDir, "stint.json"), JSON.stringify({ acquired_at: acquiredAt }));
		await fs.writeFile(path.join(fixture.root, "leaderboard.json"), JSON.stringify({ best_by_task: [{ task_dir: taskDir, reached_top5: true, reached_top1: false, goal_complete: false, active_goal: "top3" }] }));
		const gate = await executeScript(fixture, "task-local-loop-gate.js", {
			campaign: { controls: { max_no_improve_rounds: 5, started_at: acquiredAt } },
			lanes: { A: {
				taskContext: { task_dir: taskDir },
				stintBudget: { optimization_deadline_at: new Date(Date.now() + 60_000).toISOString() },
				validation: { status: "passed", candidate: "c1" },
				rewardHackReview: { verdict: "pass" },
				performanceReview: { verdict: "promote", optimization_limit_reached: false },
				stintCandidate: { improved_in_round: false },
				taskBestUpdate: { improved_this_round: false },
				leaderboardUpdate: { promoted_this_round: true, promotion: { submission_status: "scored", reached_new_milestone: true, highest_milestone: "top5", active_goal: "top3" } },
			} },
		}, "taskLocalLoopGateA");
		expect(gate.data).toMatchObject({ continueSameTask: false, status: "milestone_reached", reached_new_milestone: true, window_no_improve_streak: 0 });
	});

	test("blocks a second upload in the same round when five submissions remain", async () => {
		const fixture = await makeFixture("low-quota-round-");
		const taskDir = "x01-demo";
		const instanceDir = path.join(fixture.root, "instance");
		await fs.mkdir(path.join(instanceDir, "solution"), { recursive: true });
		await fs.mkdir(path.join(instanceDir, "evaluation"), { recursive: true });
		await fs.writeFile(path.join(instanceDir, "solution", "model.py"), "print('new')\n");
		await fs.writeFile(path.join(instanceDir, "solution", "submission.csv"), "id,pred\n1,1\n");
		await fs.writeFile(path.join(instanceDir, "evaluation", "check_integrity.py"), "print('integrity OK')\n");
		await fs.writeFile(path.join(fixture.root, "tasks.json"), JSON.stringify({ tasks: [{ order: 1, task_dir: taskDir, metric: "auc", higher_is_better: true, daily_cap: 6, edit_file: "model.py", submission_file: "submission.csv", submission_mode: "file" }] }));
		await fs.writeFile(path.join(fixture.root, "progressive_targets.json"), JSON.stringify({ snapshot_id: "s1", tasks: [{ task_dir: taskDir, target_top5: 0.8, target_top3: 0.9, target_top1: 1 }] }));
		await fs.writeFile(path.join(fixture.root, "leaderboard.json"), JSON.stringify({ best_by_task: [] }));
		await fs.mkdir(path.join(fixture.root, "workflow-output", "locks"), { recursive: true });
		const artifactDir = path.join(fixture.root, "runs", taskDir);
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.writeFile(path.join(artifactDir, "submission_log.jsonl"), JSON.stringify({ submitted_at: new Date().toISOString(), uploaded: true, status: "scored", kaggle_public: 0.7, round_id: "r1", solution_hash: "old-solution", submission_hash: "old-payload" }) + "\n");

		const promoted = await executeScript(fixture, "promote-and-update-leaderboard.js", {
			lanes: { A: {
				taskContext: { task_dir: taskDir, instance_dir: instanceDir, objective: { metric: "auc", higher_is_better: true }, submissions: { mode: "file", artifact: "submission.csv" }, commands: { local_eval_fast: "", local_eval_full: "" } },
				stintBudget: { round_id: "r1", round_index: 1 },
				validation: { status: "passed", candidate: "c2", metrics: { metric: "auc", score: 0.75, cost: -0.75 }, summary_path: "" },
				rewardHackReview: { verdict: "pass" },
				performanceReview: { verdict: "promote", optimization_limit_reached: false },
				directSubmission: { authorized: false },
				implementation: { skip_submit: false, use_last_submission: false },
			} },
		}, "promoteAndUpdateLeaderboardA");
		expect(promoted.data.promotion).toMatchObject({ submission_status: "low_quota_round_limit" });
		const logs = (await fs.readFile(path.join(artifactDir, "submission_log.jsonl"), "utf8")).trim().split("\n");
		expect(logs).toHaveLength(1);
	});

	test("continues a direct loop only after a real upload", async () => {
		const fixture = await makeFixture("direct-loop-");
		await fs.writeFile(
			path.join(fixture.root, "tasks.json"),
			JSON.stringify({ tasks: [{ task_dir: "x01-demo", daily_cap: 20 }] }),
		);
		const base = {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, stintBudget: { stint_ts: "s1", round_id: "r1", optimization_deadline_at: new Date(Date.now() + 60_000).toISOString() }, leaderboardUpdate: { promoted_this_round: true, promotion: { submission_status: "kernel_assets_missing" } } } },
		};
		const missing = await executeScript(fixture, "direct-loop-gate.js", base, "directLoopGateA");
		expect(missing.data).toMatchObject({ scored: false, continue_inner: false });
		const scoredState = structuredClone(base) as any;
		scoredState.lanes.A.leaderboardUpdate.promotion.submission_status = "scored";
		const scored = await executeScript(fixture, "direct-loop-gate.js", scoredState, "directLoopGateA");
		expect(scored.data).toMatchObject({ scored: true, continue_inner: true });
		scoredState.lanes.A.leaderboardUpdate.promotion.reached_new_milestone = true;
		const milestone = await executeScript(fixture, "direct-loop-gate.js", scoredState, "directLoopGateA");
		expect(milestone.data).toMatchObject({ continue_inner: false, reached_new_milestone: true });
	});

	test("routes functional review until ready or the stint deadline", async () => {
		const fixture = await makeFixture("functional-review-");
		const future = new Date(Date.now() + 60_000).toISOString();
		const ready = await executeScript(fixture, "functional-review-gate.js", {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, stintBudget: { round_id: "r1", optimization_deadline_at: future }, functionalReview: { verdict: "ready" } } },
		}, "functionalReviewGateA");
		expect(ready.data.decision).toBe("finalize");

		const improve = await executeScript(fixture, "functional-review-gate.js", {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, stintBudget: { round_id: "r1", optimization_deadline_at: future }, functionalReview: { verdict: "improve" } } },
		}, "functionalReviewGateA");
		expect(improve.data.decision).toBe("rework");

		const expired = await executeScript(fixture, "functional-review-gate.js", {
			lanes: { A: { taskContext: { task_dir: "x01-demo" }, stintBudget: { round_id: "r1", optimization_deadline_at: new Date(Date.now() - 1_000).toISOString() }, functionalReview: { verdict: "improve" } } },
		}, "functionalReviewGateA");
		expect(expired.data).toMatchObject({ decision: "finalize", expired: true });
	});

	test("restores the remote-best candidate and ignores null remote scores", async () => {
		const fixture = await makeFixture("restore-best-");
		const taskDir = "x01-demo";
		const instanceDir = path.join(fixture.root, "instance");
		const candidatesDir = path.join(fixture.root, "runs", taskDir, "candidates");
		await fs.mkdir(path.join(instanceDir, "solution"), { recursive: true });
		await fs.writeFile(path.join(instanceDir, "solution", "model.txt"), "current\n");
		const rows = [
			{ candidate: "local-only", cost: 0.1, kaggle_public: null },
			{ candidate: "remote-best", cost: 0.8, kaggle_public: 0.9 },
			{ candidate: "remote-worse", cost: 0.2, kaggle_public: 0.8 },
		].map((row) => ({ ...row, status: "passed", reward_passed: true, stint_ts: "s1", round_id: "r1", artifact: `runs/${taskDir}/candidates/${row.candidate}` }));
		for (const row of rows) {
			const solutionDir = path.join(candidatesDir, row.candidate, "solution");
			await fs.mkdir(solutionDir, { recursive: true });
			await fs.writeFile(path.join(solutionDir, "model.txt"), `${row.candidate}\n`);
		}
		await fs.writeFile(path.join(fixture.root, "runs", taskDir, "candidates.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");

		const restored = await executeScript(fixture, "restore-best-candidate.js", {
			lanes: { A: { taskContext: { task_dir: taskDir, instance_dir: instanceDir, objective: { higher_is_better: true } }, stintBudget: { stint_ts: "s1", round_id: "r1" } } },
		}, "restoreStintBestA");
		expect(restored.data).toMatchObject({ candidate: "remote-best", restored: true, scope: "stint" });
		expect(await fs.readFile(path.join(instanceDir, "solution", "model.txt"), "utf8")).toBe("remote-best\n");
	});
});

function directState() {
	return {
		lanes: {
			A: {
				taskContext: { task_dir: "x01-demo" },
				stintBudget: { stint_ts: "s1", round_id: "r1", optimization_expired: false },
					validation: { status: "passed", candidate: "candidate-1", solution_hash: "hash-1", submission_hash: "payload-1" },
					stintCandidate: { reward_passed: true, improved_in_stint: false, solution_hash: "hash-1", submission_hash: "payload-1" },
				roundBest: { closing: false },
			},
		},
	};
}

async function makeFixture(prefix: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(root);
	const resourceRoot = path.join(root, "resources");
	await fs.mkdir(path.join(resourceRoot, "scripts"), { recursive: true });
	await fs.copyFile(path.join(scriptsDir, "lane-utils.js"), path.join(resourceRoot, "scripts", "lane-utils.js"));
	await fs.copyFile(path.join(scriptsDir, "campaign-controls.js"), path.join(resourceRoot, "scripts", "campaign-controls.js"));
	await fs.copyFile(path.join(scriptsDir, "progressive-goals.js"), path.join(resourceRoot, "scripts", "progressive-goals.js"));
	await fs.copyFile(path.join(scriptsDir, "sync-progressive-goals.js"), path.join(resourceRoot, "scripts", "sync-progressive-goals.js"));
	await fs.copyFile(path.join(scriptsDir, "submission-hash.js"), path.join(resourceRoot, "scripts", "submission-hash.js"));
	return { root, resourceRoot };
}

async function executeScript(
	fixture: { root: string; resourceRoot: string },
	name: string,
	state: Record<string, unknown>,
	nodeId: string,
) {
	const source = await fs.readFile(path.join(scriptsDir, name), "utf8");
	const runner = new Function("workflowContext", `return (async () => { ${source} })();`);
	const previousCwd = process.cwd();
	process.chdir(fixture.root);
	try {
		return await runner({ state, resources: { root: fixture.resourceRoot }, node: { id: nodeId } });
	} finally {
		process.chdir(previousCwd);
	}
}
