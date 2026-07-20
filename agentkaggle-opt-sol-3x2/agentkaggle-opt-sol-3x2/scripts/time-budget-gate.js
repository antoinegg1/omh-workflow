const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const { laneFromContext, laneOutputDir, laneState } = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(workflowContext.state ?? {}, lane);
const outDir = laneOutputDir(path, root, lane, localState.taskContext?.task_dir ?? "");
await fs.mkdir(outDir, { recursive: true });

const campaign = workflowContext.state?.campaign ?? {};
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const configuredAfter = env("SOL_H800_PAUSE_AFTER");
const configuredAt = env("SOL_H800_PAUSE_AT");
const existingStart = campaign.pause?.started_at || campaign.preflight?.startedAt || nowIso;
const startedMs = parseTimestamp(existingStart) ?? nowMs;

const deadlines = [];
if (configuredAfter) {
	const afterMs = parseDurationMs(configuredAfter);
	if (!Number.isFinite(afterMs) || afterMs <= 0) {
		throw new Error(`invalid SOL_H800_PAUSE_AFTER=${configuredAfter}; use examples like 6h, 360m, 21600s, or a plain minute count`);
	}
	deadlines.push({
		kind: "relative",
		value: configuredAfter,
		deadline_ms: startedMs + afterMs,
		deadline_at: new Date(startedMs + afterMs).toISOString(),
	});
}
if (configuredAt) {
	const atMs = parseTimestamp(configuredAt);
	if (!Number.isFinite(atMs)) {
		throw new Error(`invalid SOL_H800_PAUSE_AT=${configuredAt}; use ISO time with timezone, epoch seconds, or epoch milliseconds`);
	}
	deadlines.push({
		kind: "absolute",
		value: configuredAt,
		deadline_ms: atMs,
		deadline_at: new Date(atMs).toISOString(),
	});
}

const enabled = deadlines.length > 0;
const reached = deadlines.filter((deadline) => nowMs >= deadline.deadline_ms);
const campaignWantedContinue = campaign.continue !== false;
const shouldPause = enabled && reached.length > 0 && campaignWantedContinue;
const continueCampaign = campaignWantedContinue && !shouldPause;

const result = {
	enabled,
	continue: continueCampaign,
	paused: shouldPause,
	reason: reason(),
	now: nowIso,
	started_at: new Date(startedMs).toISOString(),
	config: {
		SOL_H800_PAUSE_AFTER: configuredAfter || null,
		SOL_H800_PAUSE_AT: configuredAt || null,
	},
	deadlines,
	reached,
};

const outputPath = path.join(outDir, "time-budget-gate.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

return {
	summary: shouldPause
		? `timed pause reached (${result.reason})`
		: enabled
			? `time budget ok (${result.reason})`
			: "time budget gate disabled",
	data: result,
	statePatch: [
		{ op: "set", path: "/campaign/continue", value: continueCampaign },
		{ op: "set", path: "/campaign/pause", value: result },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

function reason() {
	if (!campaignWantedContinue) return "campaign already finalized before time budget gate";
	if (!enabled) return "no timed pause configured";
	if (shouldPause) {
		return `deadline reached: ${reached.map((item) => `${item.kind}:${item.deadline_at}`).join(", ")}`;
	}
	const next = deadlines.reduce((best, item) => (!best || item.deadline_ms < best.deadline_ms ? item : best), null);
	return next ? `next deadline ${next.kind}:${next.deadline_at}` : "no active deadline";
}

function env(name) {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseTimestamp(value) {
	if (typeof value !== "string" || !value.trim()) return NaN;
	const trimmed = value.trim();
	if (/^\d+$/u.test(trimmed)) {
		const numeric = Number(trimmed);
		return trimmed.length <= 10 ? numeric * 1000 : numeric;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function parseDurationMs(value) {
	const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/iu);
	if (!match) return NaN;
	const amount = Number(match[1]);
	const unit = (match[2] || "m").toLowerCase();
	const multipliers = {
		ms: 1,
		s: 1000,
		m: 60 * 1000,
		h: 60 * 60 * 1000,
		d: 24 * 60 * 60 * 1000,
	};
	return amount * multipliers[unit];
}
