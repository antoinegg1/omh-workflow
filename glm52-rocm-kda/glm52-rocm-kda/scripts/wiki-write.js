const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.env.GLM52_KDA_CAMPAIGN_ROOT || process.cwd();
const reportsDir = path.join(root, "wiki", ".reports");
await fs.mkdir(path.join(reportsDir, "processed"), { recursive: true });
const reports = [];
for (const name of ["searcher-a", "searcher-b"]) {
	const reportPath = path.join(reportsDir, `${name}.json`);
	try {
		const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
		reports.push(report);
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		await fs.rename(reportPath, path.join(reportsDir, "processed", `${stamp}-${name}.json`)).catch(() => {});
	} catch {
		reports.push({ searcher: name, status: "missing", files_changed: [] });
	}
}

const violations = [];
for (const report of reports) {
	for (const file of report.files_changed ?? []) {
		const normalized = String(file).replace(/\\/gu, "/");
		if (!normalized.startsWith("wiki/") || normalized.includes("..")) {
			violations.push(normalized);
		}
	}
}
const summary = {
	status: violations.length ? "violation" : "ok",
	reports,
	violations,
	updated_at: new Date().toISOString(),
};
await fs.mkdir(path.join(root, "workflow-output"), { recursive: true });
await fs.writeFile(path.join(root, "workflow-output", "wiki-write.json"), JSON.stringify(summary, null, 2) + "\n");
if (violations.length) {
	throw new Error(`wiki write-scope violation: ${violations.join(", ")}`);
}
	return {
		summary: `wiki reports processed: ${reports.map((r) => `${r.searcher}:${r.status}`).join(", ")}`,
		data: summary,
		statePatch: [
			{ op: "set", path: "/lanes/W/wikiWrite", value: summary },
			{ op: "set", path: "/wiki/lastUpdated", value: summary.updated_at },
		],
		artifacts: ["local://workflow-output/wiki-write.json"],
	};
