// Wiki-search lane: write the reviewer's synthesized findings into
// wiki/tasks/<operator>.md and refresh a compact wiki summary in state.
// Reuses the upsert-section pattern from scout-wiki-update.js.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const topic = state.lanes?.W?.searchTopic ?? {};
const review = state.lanes?.W?.searchReview ?? {};

const operator = sanitizeName(review.operator || topic.operator || "unknown-operator");
const wikiRoot = path.join(root, "wiki");
const taskWiki = path.join(wikiRoot, "tasks", `${operator}.md`);

const markdown =
	typeof review.wiki_markdown === "string" && review.wiki_markdown.trim()
		? review.wiki_markdown.trim()
		: fallbackMarkdown(topic, review);

const previous = await readText(taskWiki, `# ${operator}\n`);
const stamped = [`Last updated: ${nowIso()}`, "", markdown].join("\n");
const next = upsertSection(previous, "## Search Findings", stamped);

await fs.mkdir(path.dirname(taskWiki), { recursive: true });
await fs.writeFile(taskWiki, next);

// Refresh the wiki index with a one-line pointer per operator.
const indexPath = path.join(wikiRoot, "index.md");
const pointer = `- [${operator}](tasks/${operator}.md) — updated ${nowIso()}`;
const indexPrev = await readText(indexPath, "# Campaign Wiki Index\n");
const indexNext = upsertPointer(indexPrev, operator, pointer);
await fs.mkdir(wikiRoot, { recursive: true });
await fs.writeFile(indexPath, indexNext);

const report = {
	operator,
	taskWiki: path.relative(root, taskWiki),
	bytes: Buffer.byteLength(next, "utf8"),
	confidence: typeof review.confidence === "string" ? review.confidence : "unknown",
	key_directions: Array.isArray(review.key_directions) ? review.key_directions.slice(0, 6) : [],
	lastUpdated: nowIso(),
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(
	path.join(root, "workflow-output", "wiki-write.json"),
	JSON.stringify(report, null, 2) + "\n",
);

return {
	summary: `wiki updated for ${operator} (${report.bytes} bytes)`,
	data: report,
	statePatch: [
		{ op: "set", path: "/lanes/W/wikiWrite", value: report },
		{ op: "set", path: "/wiki/lastUpdatedOperator", value: operator },
	],
	artifacts: [
		"local://workflow-output/wiki-write.json",
		`local://${path.relative(root, taskWiki)}`,
	],
};

function nowIso() {
	return new Date().toISOString();
}

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

function sanitizeName(value) {
	return String(value).replace(/[^A-Za-z0-9_.-]+/gu, "_").replace(/^_+|_+$/gu, "") || "unknown-operator";
}

function fallbackMarkdown(topic, review) {
	return [
		`Topic: ${topic.topic || "(unspecified)"}`,
		"",
		"No reviewer markdown was produced; recording raw review object.",
		"",
		"```json",
		JSON.stringify(review, null, 2),
		"```",
	].join("\n");
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

function upsertPointer(indexText, operator, pointer) {
	const base = (indexText.trim() ? indexText : "# Campaign Wiki Index\n").trimEnd();
	const lines = base.split("\n");
	const marker = `(tasks/${operator}.md)`;
	const idx = lines.findIndex(line => line.includes(marker));
	if (idx >= 0) {
		lines[idx] = pointer;
		return lines.join("\n") + "\n";
	}
	return base + "\n" + pointer + "\n";
}
