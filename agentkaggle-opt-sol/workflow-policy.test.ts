import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = import.meta.dir;

describe("active workflow policy", () => {
	test("contains four worker lanes and one searcher", async () => {
		const flow = await fs.readFile(path.join(root, "agentkaggle-opt-sol.omhflow"), "utf8");
		for (const lane of ["A", "B", "C", "D"]) {
			expect(flow).toContain(`- id: selectTaskWorkload${lane}`);
			expect(flow).toContain(`- id: planImplementCandidate${lane}`);
			expect(flow).toContain(`- id: functionalReview${lane}`);
			expect(flow).toContain(`- id: restoreRoundBest${lane}`);
			expect(flow).toContain(`- id: restoreStintBest${lane}`);
		}
		expect(flow.match(/- id: wikiSearchW\n/gu)).toHaveLength(1);
		expect(flow).not.toContain("wikiSearchAW");
		expect(flow).not.toContain("wikiSearchBW");
		expect(flow).not.toContain("meetingGateD");
	});

	test("does not reference the archived plan chain", async () => {
		const flow = await fs.readFile(path.join(root, "agentkaggle-opt-sol.omhflow"), "utf8");
		for (const id of ["draftPlan", "planReview", "revisePlan", "finalizeImplementationPlan", "implementFinalPlan"]) {
			expect(flow).not.toContain(`- id: ${id}`);
		}
		for (const resource of ["simple-draft-plan", "simple-plan-review", "simple-revise-plan", "simple-implement-final-plan", "plan-review-gate", "finalize-implementation-plan"]) {
			expect(flow).not.toContain(resource);
		}
	});

	test("uses the new defaults and direct-loop round semantics", async () => {
		const loader = await fs.readFile(path.join(root, "agentkaggle-opt-sol", "scripts", "load-campaign-state.js"), "utf8");
		const loop = await fs.readFile(path.join(root, "agentkaggle-opt-sol", "scripts", "task-local-loop-gate.js"), "utf8");
		const flow = await fs.readFile(path.join(root, "agentkaggle-opt-sol.omhflow"), "utf8");
		expect(loader).toContain("SOL_H800_WORKER_LANES, 4, 1, 4");
		expect(loader).toContain("SOL_H800_SEARCH_AGENTS, 1, 0, 1");
		expect(loader).toContain("SOL_H800_ENABLE_MEETING, false");
		expect(loop).toContain("SOL_H800_TASK_LOCAL_MAX_ROUNDS, 5");
		expect(await fs.readFile(path.join(root, "agentkaggle-opt-sol", "scripts", "task-selection-guard.js"), "utf8")).toContain('SOL_H800_TASK_LOCK_STALE_H ?? "24"');
		expect(flow).toContain("to: compactTaskContextA\n    when: state.lanes.A.directLoop.continue_inner == true");
		expect(flow).toContain("to: taskLocalLoopGateA\n    when: state.lanes.A.directLoop.continue_inner != true && state.lanes.A.directLoop.reached_new_milestone == true");
		expect(flow).toContain("to: releaseWorkerSlotD\n    when: state.lanes.D.stintBudget.finalization_expired == true");
	});

	test("keeps PlanImplement autonomous while exposing milestone and quota policy", async () => {
		const promptsDir = path.join(root, "agentkaggle-opt-sol", "prompts");
		const planImplement = await fs.readFile(path.join(promptsDir, "plan-implement.md"), "utf8");
		const functionalReview = await fs.readFile(path.join(promptsDir, "functional-review.md"), "utf8");
		const performanceReview = await fs.readFile(path.join(promptsDir, "performance-review.md"), "utf8");
		const coordinator = await fs.readFile(path.join(promptsDir, "select-task-workload.md"), "utf8");
		const searchDispatch = await fs.readFile(path.join(promptsDir, "wiki-select-topic.md"), "utf8");
		const searcher = await fs.readFile(path.join(promptsDir, "wiki-search.md"), "utf8");

		expect(planImplement).toContain("Implement according to that task's `TASK.md`");
		expect(planImplement).toContain("Choose the technical approach, experiment sequence, and depth yourself");
		expect(planImplement).toContain("With more than five submissions remaining");
		expect(planImplement).not.toContain("# Exploration depth contract");
		expect(planImplement).not.toContain("For MLE tasks");
		expect(functionalReview).toContain("Review exploration depth as well as the final code");
		expect(performanceReview).toContain("temporarily score below the historical best");
		expect(coordinator).toContain("You alone decide task switching");
		expect(coordinator).toContain("assignment_mode");
		expect(coordinator).toContain("hours_to_utc_reset");
		expect(searchDispatch).toContain("significant full-local or remote gain");
		expect(searcher).toContain("original bottleneck, hypothesis sequence, decisive experiments");
	});
});
