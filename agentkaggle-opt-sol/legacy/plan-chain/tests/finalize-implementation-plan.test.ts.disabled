import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dir, "finalize-implementation-plan.js");
const laneUtilsPath = path.resolve(import.meta.dir, "lane-utils.js");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("finalize implementation plan", () => {
	test("unwraps the planner activation output wrapper", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "finalize-plan-"));
		temporaryRoots.push(root);
		const resourceRoot = path.join(root, "resources");
		await mkdir(path.join(resourceRoot, "scripts"), { recursive: true });
		await writeFile(path.join(resourceRoot, "scripts", "lane-utils.js"), await readFile(laneUtilsPath));
		await mkdir(path.join(root, "runs", "x11-task", "docs"), { recursive: true });
		await writeFile(path.join(root, "runs", "x11-task", "docs", "plan.md"), "# Candidate plan\n");
		await writeFile(path.join(root, "runs", "x11-task", "docs", "draft.md"), "# Draft\n");

		const result = await executeScript(root, resourceRoot, {
			lanes: {
				A: {
					taskContext: {
						task_dir: "x11-task",
						instance_dir: "/tmp/x11-task",
						commands: { local_eval_fast: "python evaluation/local_eval.py --subset 20000" },
					},
					plan: {
						summary: "Planned stack_a1.",
						data: {
							task_dir: "x11-task",
							candidate_name: "stack_a1",
							plan_path: "runs/x11-task/docs/plan.md",
							draft_path: "runs/x11-task/docs/draft.md",
							files_to_edit: ["/tmp/x11-task/solution/model.py"],
							validation_command: "python evaluation/local_eval.py --subset 20000",
							success_criteria: ["score improves"],
							risk_summary: "train-only selection",
						},
					},
					planReview: { summary: "Approved.", data: { verdict: "approve", required_changes: [] } },
					planReviewMeta: { round: 1, max_rounds: 2 },
				},
			},
		});

		expect(result.data.candidate_name).toBe("stack_a1");
		const output = JSON.parse(
			await readFile(path.join(root, "workflow-output", "lanes", "A", "x11-task", "implementation-plan.json"), "utf8"),
		);
		expect(output.candidate_name).toBe("stack_a1");
		expect(output.files_to_edit).toEqual(["/tmp/x11-task/solution/model.py"]);
		expect(output.success_criteria).toEqual(["score improves"]);
		expect(output.risk_summary).toBe("train-only selection");
	});
});

async function executeScript(root: string, resourceRoot: string, state: Record<string, unknown>) {
	const source = await readFile(scriptPath, "utf8");
	const runner = new Function(
		"workflowContext",
		`return (async () => { ${source} })();`,
	);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		return await runner({ state, resources: { root: resourceRoot }, node: { id: "finalizeImplementationPlanA" } });
	} finally {
		process.chdir(previousCwd);
	}
}
