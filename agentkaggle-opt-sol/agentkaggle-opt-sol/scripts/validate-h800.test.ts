import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dir, "validate-h800.js");
const laneUtilsPath = path.resolve(import.meta.dir, "lane-utils.js");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validate h800", () => {
	test("uses the official full evaluator for NeuroGolf", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "validate-neurogolf-"));
		temporaryRoots.push(root);
		const resourceRoot = path.join(root, "resources");
		const instanceDir = path.join(root, "instance");
		await mkdir(path.join(resourceRoot, "scripts"), { recursive: true });
		await writeFile(path.join(resourceRoot, "scripts", "lane-utils.js"), await readFile(laneUtilsPath));
		await mkdir(path.join(instanceDir, "solution"), { recursive: true });
		await mkdir(path.join(instanceDir, "evaluation"), { recursive: true });
		await writeFile(path.join(instanceDir, ".agk-deps-installed"), "cached\n");
		await writeFile(path.join(instanceDir, "solution", "build_networks.py"), "# candidate\n");
		await writeFile(path.join(instanceDir, "evaluation", "check_integrity.py"), "print('integrity OK')\n");
		await writeFile(
			path.join(instanceDir, "evaluation", "local_eval.py"),
			[
				"import json, pathlib, sys",
				"is_full = '--limit' not in sys.argv",
				"payload = {'local_score': 904.3628 if is_full else 217.704, 'metric': 'neurogolf_points', 'n_tasks': 400 if is_full else 100, 'solved': 56 if is_full else 14, 'official': is_full}",
				"pathlib.Path('solution/local_score.json').write_text(json.dumps(payload))",
				"print('full' if is_full else 'fast')",
			].join("\n") + "\n",
		);

		await executeScript(root, resourceRoot, {
			lanes: {
				C: {
					taskContext: {
						task_dir: "x01-neurogolf-2026",
						instance_dir: instanceDir,
						edit_file: "build_networks.py",
						objective: { metric: "neurogolf_points", higher_is_better: true },
						commands: {
							local_eval_fast: "python evaluation/local_eval.py --limit 100",
							local_eval_full: "python evaluation/local_eval.py",
						},
					},
				},
			},
		});

		const validation = JSON.parse(
			await readFile(
				path.join(root, "workflow-output", "lanes", "C", "x01-neurogolf-2026", "validate-h800.json"),
				"utf8",
			),
		);
		expect(validation.command).toBe("python3 evaluation/local_eval.py");
		expect(validation.metrics).toMatchObject({
			score: 904.3628,
			cost: -904.3628,
			mode: "full",
			official: true,
			n_tasks: 400,
			solved: 56,
		});
		const score = JSON.parse(await readFile(path.join(instanceDir, "solution", "local_score.json"), "utf8"));
		expect(score).toMatchObject({ official: true, n_tasks: 400, solved: 56 });
		expect(validation.solution_hash).toHaveLength(64);
		const snapshotSolution = path.join(root, validation.summary_path, "solution");
		expect(await readFile(path.join(snapshotSolution, "build_networks.py"), "utf8")).toContain("# candidate");
		expect(JSON.parse(await readFile(path.join(snapshotSolution, "local_score.json"), "utf8"))).toMatchObject({
			official: true,
			n_tasks: 400,
		});
	});
});

async function executeScript(root: string, resourceRoot: string, state: Record<string, unknown>) {
	const source = await readFile(scriptPath, "utf8");
	const runner = new Function("workflowContext", `return (async () => { ${source} })();`);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		return await runner({ state, resources: { root: resourceRoot }, node: { id: "validateH800C" } });
	} finally {
		process.chdir(previousCwd);
	}
}
