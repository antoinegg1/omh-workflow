import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotTree } from "./lane-utils.js";

const resourceRoot = path.dirname(import.meta.dir);
const runner = path.join(import.meta.dir, "run-js-workflow-script.js");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agk-meeting-record-"));
	roots.push(root);
	const taskDir = "x03-santa-2023";
	await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
	await fs.mkdir(path.join(root, "runs", taskDir), { recursive: true });
	await fs.mkdir(path.join(root, "wiki"), { recursive: true });
	await fs.writeFile(path.join(root, "runs", taskDir, "baseline.md"), "stable\n");
	await fs.writeFile(path.join(root, "wiki", "baseline.md"), "stable\n");
	const runs = await snapshotTree(fs, path, path.join(root, "runs", taskDir), root);
	const wiki = await snapshotTree(fs, path, path.join(root, "wiki"), root);
	await fs.writeFile(
		path.join(root, "workflow-output", "meeting-snapshot-C.json"),
		JSON.stringify({ task_dir: taskDir, runs, wiki }),
	);
	return { root, taskDir };
}

async function runArchiver(root: string, taskDir: string, meetingDecision: unknown) {
	const context = {
		node: { id: "appendMeetingRecordC" },
		state: {
			lanes: {
				C: {
					meeting: { task_dir: taskDir, reason: "test stall", round: 2, noImproveStreak: 2 },
					meetingBrief: { task_dir: taskDir, summary: "test" },
					meetingSpeakers: {},
					meetingDecision,
					taskContext: { task_dir: taskDir },
				},
			},
		},
	};
	const child = Bun.spawn(["bun", runner, "scripts/append-meeting-record.js"], {
		cwd: root,
		env: {
			...process.env,
			OMP_WORKFLOW_RESOURCE_DIR: resourceRoot,
			OMP_WORKFLOW_CONTEXT: JSON.stringify(context),
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

describe("meeting record archiver", () => {
	it("unwraps moderator data and ignores concurrent wiki writes", async () => {
		const { root, taskDir } = await fixture();
		await fs.writeFile(path.join(root, "wiki", "concurrent-searcher.md"), "legitimate\n");

		const result = await runArchiver(root, taskDir, {
			summary: "Choose the reducer",
			data: {
				decision: "revise_candidate",
				next_candidate_direction: "Implement the routed reducer",
				must_do_next: ["repin validation"],
				risks_to_watch: ["timeout"],
			},
		});

		expect(result.data.decision).toBe("revise_candidate");
		expect(result.data.read_only_check).toMatchObject({
			checked: true,
			ok: true,
			scope: `runs/${taskDir}`,
		});
		const guidance = JSON.parse(
			await fs.readFile(path.join(root, "workflow-output", "meeting-guidance", `${taskDir}.json`), "utf8"),
		);
		expect(guidance).toMatchObject({
			decision: "revise_candidate",
			next_candidate_direction: "Implement the routed reducer",
			must_do_next: ["repin validation"],
		});
	});

	it("still flags changes to the lane-locked task run", async () => {
		const { root, taskDir } = await fixture();
		await fs.writeFile(path.join(root, "runs", taskDir, "unexpected.md"), "changed\n");

		const result = await runArchiver(root, taskDir, { decision: "rotate_task" });

		expect(result.data.read_only_check.checked).toBe(true);
		expect(result.data.read_only_check.ok).toBe(false);
		expect(result.data.read_only_check.changes).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: `runs/${taskDir}/unexpected.md` })]),
		);
	});
});
