const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const activations = workflowContext.completedActivations ?? [];
const validationActivations = activations.filter((activation) => activation.nodeId === "validateH800" && activation.status === "completed");
const latestValidation = workflowContext.state?.validation ?? {};
const profile = workflowContext.state?.profile ?? {};

const validationCount = validationActivations.length;
const recentFailed = validationActivations
	.slice(-2)
	.every((activation) => activation.output?.data?.status === "failed" || activation.output?.summary?.includes("failed"));
const required =
	(validationCount > 0 && validationCount % 5 === 0) ||
	recentFailed ||
	profile.status === "planned" ||
	latestValidation.status === "failed" && validationCount >= 2;

const meeting = {
	required,
	reason: required
		? validationCount > 0 && validationCount % 5 === 0
			? "cadence"
			: recentFailed
				? "stalled"
				: profile.status === "planned"
					? "profile"
					: "validation-failure"
		: "not-needed",
	validationCount,
	task_dir: workflowContext.state?.taskContext?.task_dir ?? "",
	candidate: latestValidation.candidate ?? "",
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "meeting-gate.json"), JSON.stringify(meeting, null, 2) + "\n");

return {
	summary: `meeting ${meeting.required ? "required" : "not required"} (${meeting.reason})`,
	data: meeting,
	statePatch: [{ op: "set", path: "/meeting", value: meeting }],
	artifacts: ["local://workflow-output/meeting-gate.json"],
};
