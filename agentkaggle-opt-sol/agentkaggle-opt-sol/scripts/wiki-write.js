// Search-lane join: write-scope guard + indexer. The single searcher edits the
// wiki DIRECTLY and drops its round report as a sidecar file inside the wiki
// (wiki/.reports/searcher.json) — no chat-output state contract, so a
// drifting final message can never kill the run. This node reads the sidecars,
// verifies declared+observed changes stayed inside wiki/**, registers sources,
// refreshes wiki/index.md, and archives the processed reports.
// Runs after the searcher. Idempotent.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { checkWriteScope, diffTree, readJsonSafe, snapshotTree } = await import(
	`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`
);
const topic = state.lanes?.W?.searchTopic ?? {};

const wikiRoot = process.env.SOL_H800_FLOW_WIKI_DIR || path.join(root, "wiki");
await fs.mkdir(path.join(wikiRoot, "tasks"), { recursive: true });
await fs.mkdir(path.join(wikiRoot, "meetings"), { recursive: true });
const reportsDir = path.join(wikiRoot, ".reports");
await fs.mkdir(path.join(reportsDir, "processed"), { recursive: true });

// --- Load searcher sidecar reports -------------------------------------------
const reports = {};
for (const name of ["searcher"]) {
	const reportPath = path.join(reportsDir, `${name}.json`);
	const report = await readJsonSafe(fs, reportPath, null);
	reports[name] = report;
	if (report) {
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		await fs.rename(reportPath, path.join(reportsDir, "processed", `${stamp}-${name}.json`)).catch(() => {});
	}
}
const missing = Object.entries(reports)
	.filter(([, report]) => !report)
	.map(([name]) => name);

// --- Write-scope guard -------------------------------------------------------
// 1. Declared changes from the searcher report must be inside wiki/**.
const declared = []
	.concat(Array.isArray(reports.searcher?.files_changed) ? reports.searcher.files_changed : [])
	.map((item) => String(item ?? "").trim())
	.filter(Boolean);
const declaredVerdict = checkWriteScope(declared, "searcher");

// 1b. The search-dispatch coordinator (wikiSelectTopic) may only have written
// its runs/_campaign/** dispatch files.
const coordinatorDeclared = (Array.isArray(topic.files_changed) ? topic.files_changed : [])
	.map((item) => String(item ?? "").trim())
	.filter(Boolean);
const coordinatorVerdict = checkWriteScope(coordinatorDeclared, "campaignCoordinator");

// 2. Observed changes: diff the wiki tree against the last post-merge snapshot.
const snapshotPath = path.join(root, "workflow-output", "wiki-snapshot.json");
const previousSnapshot = await readJsonSafe(fs, snapshotPath, null);
const currentSnapshot = await snapshotTree(fs, path, wikiRoot, root);
const observedChanges = previousSnapshot
	? diffTree(previousSnapshot, currentSnapshot)
			.map((item) => `${item.kind}:${item.path}`)
			.filter((line) => !line.includes("wiki/.reports/"))
	: [];

const violation = !declaredVerdict.ok || !coordinatorVerdict.ok;
const guard = {
	declared_count: declared.length,
	declared_violations: declaredVerdict.violations.slice(0, 12),
	coordinator_declared_count: coordinatorDeclared.length,
	coordinator_violations: coordinatorVerdict.violations.slice(0, 12),
	observed_wiki_changes: observedChanges.slice(0, 40),
	missing_reports: missing,
	policy: declaredVerdict.policy,
	status: violation ? "violation" : "ok",
};

// --- Source registry + index refresh -----------------------------------------
const sources = []
	.concat(Array.isArray(reports.searcher?.sources) ? reports.searcher.sources : [])
	.slice(0, 24);
if (sources.length > 0) {
	const rows = sources.map((source) =>
		JSON.stringify({
			ts: new Date().toISOString(),
			topic: topic.topic ?? "",
			task_id: topic.task_id ?? topic.operator ?? "",
			ref: source?.ref ?? "",
			kind: source?.kind ?? "",
			note: String(source?.note ?? "").slice(0, 240),
		}),
	);
	await fs.appendFile(path.join(wikiRoot, "sources.jsonl"), rows.join("\n") + "\n");
}

// Refresh index (progressive disclosure L0): one pointer line per note with a
// short hook extracted from its TL;DR so agents can triage without opening files.
const indexPath = path.join(wikiRoot, "index.md");
const taskFiles = (await listFiles(path.join(wikiRoot, "tasks"))).filter((name) => name.endsWith(".md"));
const meetingCount = (await listFiles(path.join(wikiRoot, "meetings"))).filter((name) => name.endsWith(".md")).length;
const entryLines = [];
for (const name of taskFiles.sort()) {
	const noteText = await readTextSafe(path.join(wikiRoot, "tasks", name));
	entryLines.push(`- [${name.replace(/\.md$/u, "")}](tasks/${name}) — ${noteHook(noteText)}`);
}
const indexBody = [
	"# Campaign Wiki Index",
	"",
	"Maintained by the search lane. Layers: this index (L0 hooks) → each note's top `## TL;DR` (L1, ≤15 lines) → addressable body sections (L2) → round details (L3). Sections: tasks/, meetings/, patterns/.",
	"",
	`Last refreshed: ${new Date().toISOString()} — ${taskFiles.length} task note(s), ${meetingCount} meeting record(s).`,
	"",
	"## Entries",
	"",
	...(entryLines.length ? entryLines : ["(none yet)"]),
	"",
].join("\n");
await fs.writeFile(indexPath, indexBody);

function noteHook(text) {
	const value = String(text ?? "");
	const heading = /^##\s+(?:TL;DR|.*current consensus.*|Runnable spec.*)$/im.exec(value);
	const scope = heading ? value.slice(heading.index + heading[0].length) : value;
	for (const line of scope.split(/\r?\n/u)) {
		const clean = line.replace(/^[-*#\s>]+/u, "").trim();
		if (clean.length > 20 && !clean.startsWith("[")) return clean.slice(0, 110);
	}
	return "(no hook yet)";
}

async function readTextSafe(filePath) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

// Post-merge snapshot for the next round's guard diff.
const postSnapshot = await snapshotTree(fs, path, wikiRoot, root);
await fs.writeFile(snapshotPath, JSON.stringify(postSnapshot) + "\n");

const compactReport = (name) => {
	const report = reports[name];
	if (!report) return { present: false };
	return {
		present: true,
		status: report.status ?? "",
		directive: report.directive ?? "",
		confidence: report.confidence ?? "",
		files_changed: (report.files_changed ?? []).slice(0, 8),
		outcome: String(report.outcome ?? "").slice(0, 300),
	};
};

const report = {
	topic: topic.topic ?? "",
	task_id: topic.task_id ?? topic.operator ?? "",
	directive: topic.directive ?? "research",
	searcher: compactReport("searcher"),
	sources_registered: sources.length,
	task_note_count: taskFiles.length,
	guard,
	lastUpdated: new Date().toISOString(),
};

await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "wiki-write.json"), JSON.stringify(report, null, 2) + "\n");

return {
	summary: violation
		? `wiki guard VIOLATION: out-of-scope writes declared (${declaredVerdict.violations.concat(coordinatorVerdict.violations).slice(0, 3).join(", ")})`
		: `wiki updated (${report.task_id || report.topic}): ${observedChanges.length} change(s), ${sources.length} source(s)${missing.length ? `; missing report: ${missing.join(",")}` : ""}`,
	data: report,
	statePatch: [
		{ op: "set", path: "/lanes/W/wikiWrite", value: report },
		{ op: "set", path: "/wiki/lastUpdatedOperator", value: report.task_id || report.topic },
	],
	artifacts: ["local://workflow-output/wiki-write.json", `local://${path.relative(root, indexPath)}`],
};

async function listFiles(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
	} catch {
		return [];
	}
}
