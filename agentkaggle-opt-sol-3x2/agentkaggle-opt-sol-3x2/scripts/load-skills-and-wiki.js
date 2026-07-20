const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const skillRoot = path.join(root, ".omp", "skills");
const wikiRoot = process.env.SOL_H800_FLOW_WIKI_DIR || path.join(root, "wiki");
const skills = [];
for (const name of await listDirs(skillRoot)) {
	const skillPath = path.join(skillRoot, name, "SKILL.md");
	const text = await readText(skillPath, "");
	if (!text) continue;
	skills.push({
		name,
		path: path.relative(root, skillPath),
		description: frontmatterField(text, "description"),
		references: await globMd(path.join(skillRoot, name, "references")),
	});
}

const wikiFull = {
	index: await readText(path.join(wikiRoot, "index.md"), ""),
	sourcesCount: (await readText(path.join(wikiRoot, "sources.jsonl"), ""))
		.split(/\r?\n/u)
		.filter((line) => line.trim()).length,
	patternFiles: await globMd(path.join(wikiRoot, "patterns")),
	taskFiles: await globMd(path.join(wikiRoot, "tasks")),
	meetingFiles: await globMd(path.join(wikiRoot, "meetings")),
};
const wiki = compactWiki(wikiFull);
const skillsState = { count: skills.length, items: skills };

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "skills-wiki.json"), JSON.stringify({ skills: skillsState, wiki: wikiFull }, null, 2) + "\n");

return {
	summary: `loaded ${skills.length} project skills and ${wikiFull.sourcesCount} wiki source records`,
	data: { skillCount: skills.length, sourcesCount: wikiFull.sourcesCount, detail_file: "workflow-output/skills-wiki.json" },
	statePatch: [
		{ op: "set", path: "/skills", value: skillsState },
		{ op: "set", path: "/wiki", value: wiki },
	],
	artifacts: ["local://workflow-output/skills-wiki.json"],
};

async function listDirs(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch {
		return [];
	}
}

async function readText(filePath, fallback) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}
}

function frontmatterField(text, field) {
	const match = new RegExp(`^${field}:\\s*(.*)$`, "imu").exec(text);
	return match?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";
}

async function globMd(dir) {
	const rows = [];
	for (const name of await listFiles(dir)) {
		if (name.endsWith(".md")) rows.push(path.relative(process.cwd(), path.join(dir, name)));
	}
	return rows.sort();
}

async function listFiles(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

function compactWiki(value) {
	return {
		index_excerpt: excerpt(value.index, 1200),
		sourcesCount: value.sourcesCount,
		patternFiles: value.patternFiles,
		taskFiles: value.taskFiles.slice(-20),
		taskFileCount: value.taskFiles.length,
		meetingFiles: value.meetingFiles.slice(-20),
		meetingFileCount: value.meetingFiles.length,
		detail_file: "workflow-output/skills-wiki.json",
		note: "Full wiki index and file lists are stored in detail_file.",
	};
}

function excerpt(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars; read detail_file]`;
}
