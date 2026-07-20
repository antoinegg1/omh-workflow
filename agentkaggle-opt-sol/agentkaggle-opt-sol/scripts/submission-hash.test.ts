import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashSolutionTree, hashSubmissionPayload } from "./submission-hash.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("submission payload hashing", () => {
	test("distinguishes the upload payload from the full solution", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "submission-hash-"));
		roots.push(root);
		await fs.writeFile(path.join(root, "model.py"), "v1\n");
		await fs.writeFile(path.join(root, "submission.csv"), "id,pred\n1,0\n");
		const solution1 = await hashSolutionTree(fs, path, root);
		const payload1 = await hashSubmissionPayload(fs, path, root, { mode: "file", artifact: "submission.csv" });
		await fs.writeFile(path.join(root, "model.py"), "v2\n");
		const solution2 = await hashSolutionTree(fs, path, root);
		const payload2 = await hashSubmissionPayload(fs, path, root, { mode: "file", artifact: "submission.csv" });
		expect(solution2).not.toBe(solution1);
		expect(payload2).toBe(payload1);
	});
});

