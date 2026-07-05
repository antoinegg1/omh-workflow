const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const proposal = workflowContext.state?.skillProposal;
const result = {
	status: "skipped",
	reason: "no valid /skillProposal present",
	skill_path: "",
};

if (proposal && typeof proposal === "object") {
	const name = safeSkillName(proposal.name);
	const body = typeof proposal.body === "string" ? proposal.body.trim() : "";
	const description = typeof proposal.description === "string" ? proposal.description.trim() : "";
	if (name && body && description) {
		const skillDir = path.join(root, ".omp", "skills", name);
		await fs.mkdir(skillDir, { recursive: true });
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(
			skillPath,
			[
				"---",
				`name: ${name}`,
				`description: ${JSON.stringify(description)}`,
				"---",
				"",
				body,
				"",
			].join("\n"),
		);
		result.status = "updated";
		result.reason = "created or updated project-local skill from workflow proposal";
		result.skill_path = path.relative(root, skillPath);
	}
}

await fs.mkdir(path.join(root, "wiki"), { recursive: true });
await fs.appendFile(
	path.join(root, "wiki", "skills-harvest.jsonl"),
	JSON.stringify({ ...result, at: new Date().toISOString() }, null, 0) + "\n",
);
await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "skill-harvest.json"), JSON.stringify(result, null, 2) + "\n");

return {
	summary: `skill harvest ${result.status}: ${result.reason}`,
	data: result,
	statePatch: [{ op: "set", path: "/skillHarvest", value: result }],
	artifacts: ["local://workflow-output/skill-harvest.json", "local://wiki/skills-harvest.jsonl"].concat(
		result.skill_path ? [`local://${result.skill_path}`] : [],
	),
};

function safeSkillName(value) {
	if (typeof value !== "string") return "";
	const name = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9-]{0,62}$/u.test(name) ? name : "";
}
