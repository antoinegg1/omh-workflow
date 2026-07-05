const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const wikiRoot = path.join(root, "wiki");
const taskContext = workflowContext.state?.taskContext ?? {};
const taskName = taskContext.task_name ?? (taskContext.task_dir ? path.basename(taskContext.task_dir) : "unknown-task");
const taskWiki = path.join(wikiRoot, "tasks", `${taskName}.md`);
const scoutDispatch = workflowContext.state?.scoutDispatch ?? {};
const scoutResearch = workflowContext.state?.scoutResearch ?? {};
const missingScouts = missingEnabledScouts(scoutDispatch, scoutResearch);
if (missingScouts.length > 0) {
	throw new Error(`missing scout research state for enabled scout(s): ${missingScouts.join(", ")}`);
}
const previousText = await readText(taskWiki, `# ${taskName}\n`);
const nextText = upsertSection(
	previousText,
	"## Scout Research",
	renderScoutResearch({ scoutDispatch, scoutResearch }),
);
const report = {
	task: taskName,
	taskWiki: path.relative(root, taskWiki),
	lastUpdated: new Date().toISOString(),
	bytes: Buffer.byteLength(nextText, "utf8"),
	fullScoutArchive: `${path.relative(root, taskWiki)}#scout-research`,
	scouts: {
		glm: summarizeScout(scoutResearch.glm),
		deepseek: summarizeScout(scoutResearch.deepseek),
	},
	note: "Scout research is archived for wiki/audit only. The main planning path does not read /scoutWiki.",
};

await fs.mkdir(path.dirname(taskWiki), { recursive: true });
await fs.writeFile(taskWiki, nextText);
await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "scout-wiki-update.json"), JSON.stringify(report, null, 2) + "\n");

return {
	summary: `recorded scout wiki status for ${taskName}`,
	data: report,
	statePatch: [{ op: "set", path: "/scoutWiki", value: report }],
	artifacts: ["local://workflow-output/scout-wiki-update.json", `local://${path.relative(root, taskWiki)}`],
};

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

function renderScoutResearch({ scoutDispatch, scoutResearch }) {
	return [
		`Last updated: ${new Date().toISOString()}`,
		"",
		"```json",
		JSON.stringify({ dispatch: scoutDispatch, scouts: scoutResearch }, null, 2),
		"```",
	].join("\n");
}

function summarizeScout(scout) {
	if (!scout || typeof scout !== "object") return { status: "missing" };
	return {
		status: stringValue(scout.status, "unknown"),
		topic: truncateText(stringValue(scout.topic, ""), 180),
		confidence: truncateText(stringValue(scout.confidence, ""), 80),
		sources_checked: compactList(scout.sources_checked, 5, 220),
		findings: compactList(scout.findings, 4, 280),
		implementation_implications: compactList(scout.implementation_implications, 4, 260),
		correctness_risks: compactList(scout.correctness_risks, 4, 240),
		reward_hack_risks: compactList(scout.reward_hack_risks, 3, 220),
		profile_or_validation_needed: truncateText(stringValue(scout.profile_or_validation_needed, ""), 360),
	};
}

function compactList(value, limit, maxStringLength) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, limit).map(item => compactScoutItem(item, maxStringLength));
}

function compactScoutItem(value, maxStringLength) {
	if (typeof value === "string") return truncateText(value, maxStringLength);
	if (!isObject(value)) return value;
	const result = {};
	for (const [key, entry] of Object.entries(value).slice(0, 6)) {
		result[key] = typeof entry === "string" ? truncateText(entry, maxStringLength) : entry;
	}
	return result;
}

function stringValue(value, fallback) {
	return typeof value === "string" ? value : fallback;
}

function truncateText(value, maxLength) {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function missingEnabledScouts(dispatch, research) {
	const missing = [];
	if (dispatch?.glm?.enabled !== false && !isObject(research.glm)) missing.push("glm");
	if (dispatch?.deepseek?.enabled !== false && !isObject(research.deepseek)) missing.push("deepseek");
	return missing;
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function upsertSection(text, heading, body) {
	const base = (text.trim() ? text : "# Task Notes\n").trimEnd();
	const headingLine = `${heading}\n`;
	const section = `${heading}\n\n${body.trimEnd()}\n`;
	const start = base.indexOf(headingLine);
	if (start < 0) return `${base}\n\n${section}`;

	const afterStart = start + headingLine.length;
	const rest = base.slice(afterStart);
	const nextHeading = /\n##\s/u.exec(rest);
	const end = nextHeading ? afterStart + nextHeading.index : base.length;
	const before = base.slice(0, start).trimEnd();
	const after = base.slice(end).trimStart();
	return [before, section.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
}
