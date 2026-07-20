import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const resourceRoot = path.dirname(import.meta.dir);
const runner = path.join(import.meta.dir, "run-js-workflow-script.js");
const flowPath = path.join(resourceRoot, "..", "agentkaggle-opt-sol-3x2.omhflow");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agk-plan-review-"));
	roots.push(root);
	await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
	return root;
}

async function runScript(root: string, script: string, context: unknown) {
	const child = Bun.spawn(["bun", runner, script], {
		cwd: root,
		env: {
			...process.env,
			OMP_WORKFLOW_RESOURCE_DIR: resourceRoot,
			OMP_WORKFLOW_CONTEXT: JSON.stringify(context),
			SOL_H800_PLAN_REVIEW_MAX_ROUNDS: "2",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return JSON.parse(stdout.trim());
}

describe("plan review exhaustion", () => {
	it("returns a twice-rejected plan to the coordinator", async () => {
		const root = await fixture();
		const result = await runScript(root, "scripts/plan-review-gate.js", {
			node: { id: "planReviewGateA" },
			state: {
				lanes: {
					A: {
						taskContext: { task_dir: "x06-widsdatathon2024-challenge1" },
						planReview: { verdict: "revise" },
						planReviewMeta: { round: 1 },
					},
				},
			},
		});

		expect(result.data).toMatchObject({
			round: 2,
			verdict: "revise",
			decision: "abandon",
			forced_finalize: false,
			review_budget_exhausted: true,
		});
		expect(result.summary).toContain("returning task to coordinator");
	});

	it("still finalizes an approved plan on the last review", async () => {
		const root = await fixture();
		const result = await runScript(root, "scripts/plan-review-gate.js", {
			node: { id: "planReviewGateB" },
			state: {
				lanes: {
					B: {
						taskContext: { task_dir: "x02-hashcode-photo-slideshow" },
						planReview: { verdict: "approve" },
						planReviewMeta: { round: 1 },
					},
				},
			},
		});

		expect(result.data).toMatchObject({
			round: 2,
			verdict: "approve",
			decision: "finalize",
			review_budget_exhausted: false,
		});
	});

	it("accepts the agent output wrapper used by plan reviewers", async () => {
		const root = await fixture();
		const result = await runScript(root, "scripts/plan-review-gate.js", {
			node: { id: "planReviewGateC" },
			state: {
				lanes: {
					C: {
						taskContext: { task_dir: "x09-electricity-consumption" },
						planReview: {
							summary: "approved",
							data: { verdict: "approve", required_changes: [] },
						},
					},
				},
			},
		});

		expect(result.data).toMatchObject({
			round: 1,
			verdict: "approve",
			decision: "finalize",
		});
	});

	it("records plan exhaustion without inheriting stale validation state", async () => {
		const root = await fixture();
		const taskDir = "x06-widsdatathon2024-challenge1";
		const lockDir = path.join(root, "runs", "active-task-locks", `${taskDir}.lock`);
		await fs.mkdir(lockDir, { recursive: true });
		await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ lane: "A", task_dir: taskDir }));
		const result = await runScript(root, "scripts/release-worker-slot.js", {
			node: { id: "releaseWorkerSlotA" },
			state: {
				lanes: {
					A: {
						selectionGuard: { task_dir: taskDir, stint_started_at: "2026-07-18T22:08:38Z" },
						taskContext: { task_dir: taskDir },
						planReviewMeta: { decision: "abandon", review_budget_exhausted: true, round: 2, max_rounds: 2 },
						validation: { status: "passed", task_dir: "x11-stale" },
						localLoop: { status: "stalled_after_no_improvement", window_no_improve_streak: 3 },
					},
				},
			},
		});

		expect(result.data).toMatchObject({
			task_dir: taskDir,
			status: "released",
			stint_ts: "2026-07-18T22:08:38Z",
			local_loop_status: "plan_review_exhausted",
			validation_status: "not_run",
			window_no_improve_streak: 0,
			stalled: false,
		});
		expect(result.data.failure_fingerprint).toContain("plan_review_exhausted");
	});

	it("routes plan exhaustion to release on every worker lane", async () => {
		const flow = await fs.readFile(flowPath, "utf8");
		for (const lane of ["A", "B", "C"]) {
			expect(flow).toContain(`from: planReviewGate${lane}\n    to: releaseWorkerSlot${lane}`);
			expect(flow).toContain(`state.lanes.${lane}.planReviewMeta.decision == "abandon"`);
		}
	});
});
