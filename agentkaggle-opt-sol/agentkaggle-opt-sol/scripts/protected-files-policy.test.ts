import { describe, expect, test } from "bun:test";
import { normalizedProtectedFileContent } from "./protected-files-policy.js";

describe("protected file normalization", () => {
	test("ignores only the workflow-managed progressive goal block", () => {
		const before = Buffer.from("# Task\n<!-- progressive-goal:start -->\nTop 5\n<!-- progressive-goal:end -->\nContract\n");
		const after = Buffer.from("# Task\n<!-- progressive-goal:start -->\nTop 3\n<!-- progressive-goal:end -->\nContract\n");
		expect(normalizedProtectedFileContent("x10-demo/TASK.md", before)).toEqual(
			normalizedProtectedFileContent("x10-demo/TASK.md", after),
		);
	});

	test("preserves task contract changes outside the managed block", () => {
		const before = Buffer.from("# Task\n<!-- progressive-goal:start -->\nTop 5\n<!-- progressive-goal:end -->\nContract\n");
		const after = Buffer.from("# Task\n<!-- progressive-goal:start -->\nTop 3\n<!-- progressive-goal:end -->\nChanged contract\n");
		expect(normalizedProtectedFileContent("x10-demo/TASK.md", before)).not.toEqual(
			normalizedProtectedFileContent("x10-demo/TASK.md", after),
		);
	});
});
