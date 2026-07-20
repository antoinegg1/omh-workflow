import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dir, "optional-profile-h800.js");
const laneUtilsPath = path.resolve(import.meta.dir, "lane-utils.js");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("optional profile h800", () => {
	test("profiles the no-subset evaluator instead of the export-only full-fit command", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "profile-full-native-"));
		temporaryRoots.push(root);
		const resourceRoot = path.join(root, "resources");
		const instanceDir = path.join(root, "instance");
		await mkdir(path.join(resourceRoot, "scripts"), { recursive: true });
		await writeFile(path.join(resourceRoot, "scripts", "lane-utils.js"), await readFile(laneUtilsPath));
		await mkdir(path.join(instanceDir, "evaluation"), { recursive: true });
		await writeFile(
			path.join(instanceDir, "evaluation", "local_eval.py"),
			[
				"import sys",
				"print('FULL_FIT' if '--full-fit' in sys.argv else 'FULL_NATIVE 0.69274')",
			].join("\n") + "\n",
		);

		await executeScript(root, resourceRoot, {
			lanes: {
				B: {
					taskContext: {
						task_dir: "x08-home-credit-stability",
						task_name: "x08-home-credit-stability",
						instance_dir: instanceDir,
						commands: { local_eval_full: "python evaluation/local_eval.py --full-fit" },
					},
					validation: { status: "passed", candidate: "candidate-b" },
					performanceReview: { profile_required: true },
				},
			},
		});

		const profile = JSON.parse(
			await readFile(
				path.join(root, "workflow-output", "lanes", "B", "x08-home-credit-stability", "optional-profile-h800.json"),
				"utf8",
			),
		);
		expect(profile.status).toBe("completed");
		const report = await readFile(path.join(root, profile.report_path), "utf8");
		expect(report).toContain("Command: python3 evaluation/local_eval.py");
		expect(report).toContain("FULL_NATIVE 0.69274");
		expect(report).not.toContain("Command: python3 evaluation/local_eval.py --full-fit");
	});
});

async function executeScript(root: string, resourceRoot: string, state: Record<string, unknown>) {
	const source = await readFile(scriptPath, "utf8");
	const runner = new Function("workflowContext", `return (async () => { ${source} })();`);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		return await runner({ state, resources: { root: resourceRoot }, node: { id: "optionalProfileH800B" } });
	} finally {
		process.chdir(previousCwd);
	}
}
