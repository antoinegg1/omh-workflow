// Shared helpers for the agentkaggle-opt-sol workflow (fork of sol-h800-kernel-opt-sol).
// Task dirs are Kaggle task packages named like "x13-salary-prediction-for-job-postings".
// Conventions used across all scripts:
//   - cost = higher_is_better ? -score : score  (lower cost is always better)
//   - per-task campaign artifacts live in <root>/runs/<xNN-...>/ (candidates.jsonl, docs/, meetings/)
//   - writable run instances live under INSTANCE_ROOT/agk-<runTag>-<xNN-...>/ (solution/ is the edit surface)
//   - agent write permissions are hardcoded here (single source of truth) and enforced by guard scripts

export const WORKER_LANES = ["A", "B", "C", "D"];

export function laneFromContext(workflowContext) {
	const nodeId = String(workflowContext?.node?.id ?? "");
	const match = /([A-E])$/u.exec(nodeId);
	return match ? match[1] : "";
}

export function laneState(state, lane) {
	if (!lane) return state ?? {};
	const lanes = state?.lanes;
	if (!lanes || typeof lanes !== "object") return {};
	const value = lanes[lane];
	return value && typeof value === "object" ? value : {};
}

export function lanePath(lane, path) {
	const suffix = String(path ?? "").replace(/^\/+/u, "");
	return lane ? `/lanes/${lane}/${suffix}` : `/${suffix}`;
}

export function lanePatch(lane, path, value) {
	return { op: "set", path: lanePath(lane, path), value };
}

export function laneOutputDir(pathModule, root, lane, taskDirRel = "") {
	if (!lane) return pathModule.join(root, "workflow-output");
	const taskName = taskDirRel ? pathModule.basename(taskDirRel) : "_selector";
	return pathModule.join(root, "workflow-output", "lanes", lane, taskName);
}

export function localArtifact(root, pathModule, absPath) {
	return `local://${normalizeRel(pathModule.relative(root, absPath))}`;
}

export function normalizeRel(value) {
	return String(value ?? "")
		.replaceAll("\\", "/")
		.replace(/^\.\/+/u, "")
		.replace(/\/+$/u, "");
}

// Kaggle task dirs: "x01-neurogolf-2026" ... "x13-salary-prediction-for-job-postings".
export function normalizeTaskDir(value) {
	const text = normalizeRel(value).trim();
	const match = /x[0-9]{2}-[A-Za-z0-9_.-]+/u.exec(text);
	return match ? match[0] : "";
}

export function extractTaskDir(value) {
	if (!value) return "";
	if (typeof value === "string") return normalizeTaskDir(value);
	if (typeof value !== "object") return "";
	const direct = normalizeTaskDir(value.task_dir ?? value.taskDir ?? value.data?.task_dir ?? value.data?.taskDir ?? "");
	if (direct) return direct;
	if (typeof value.summary === "string") {
		const fromSummary = normalizeTaskDir(value.summary);
		if (fromSummary) return fromSummary;
	}
	try {
		return normalizeTaskDir(JSON.stringify(value));
	} catch {
		return "";
	}
}

export function parseTaskBatch(value) {
	return String(value ?? "")
		.split(",")
		.map((item) => normalizeTaskDir(item))
		.filter(Boolean);
}

export function activeTaskEntries(state) {
	const activeTasks = state?.workerPool?.activeTasks;
	if (!activeTasks || typeof activeTasks !== "object") return [];
	return Object.entries(activeTasks)
		.map(([lane, value]) => {
			if (!value || typeof value !== "object" || value.status !== "active") return null;
			const taskDir = normalizeTaskDir(value.task_dir);
			return taskDir ? { lane, task_dir: taskDir, since: value.since ?? "" } : null;
		})
		.filter(Boolean);
}

export function activeTaskDirs(state) {
	return activeTaskEntries(state).map((entry) => entry.task_dir);
}

// ---------------------------------------------------------------------------
// Campaign layout helpers
// ---------------------------------------------------------------------------

// Per-task campaign artifact dir (task.md contract: <root>/runs/<xNN>/...).
export function taskArtifactDir(pathModule, root, taskDirRel) {
	return pathModule.join(root, "runs", pathModule.basename(taskDirRel));
}

// Root for writable run instances (task.md contract). Override via env for tests.
export function instanceRoot() {
	return process.env.AGK_INSTANCE_ROOT || "/root/autokaggle/omh_runs";
}

export async function readRunTag(fsModule, pathModule, root) {
	try {
		const tag = (await fsModule.readFile(pathModule.join(root, "workflow-output", "run-tag.txt"), "utf8")).trim();
		if (tag) return tag;
	} catch {
		/* missing */
	}
	return "";
}

export function instanceDirFor(pathModule, runTag, taskDirRel) {
	return pathModule.join(instanceRoot(), `agk-${runTag}-${pathModule.basename(taskDirRel)}`);
}

// Direction-aware score: lower cost is always better.
export function costOf(score, higherIsBetter) {
	if (score === null || score === undefined || score === "") return null;
	const value = Number(score);
	if (!Number.isFinite(value)) return null;
	return higherIsBetter ? -value : value;
}

export function finiteNumberOrNull(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

// Remote score dominates local evidence. When neither row is remotely scored,
// compare the already direction-normalized local cost.
export function remotePrimaryBeats(next, previous, higherIsBetter) {
	if (!next) return false;
	if (!previous) return true;
	const nextRemote = finiteNumberOrNull(next.kaggle_public);
	const previousRemote = finiteNumberOrNull(previous.kaggle_public);
	if (nextRemote !== null && previousRemote === null) return true;
	if (nextRemote === null && previousRemote !== null) return false;
	if (nextRemote !== null && previousRemote !== null) {
		return costOf(nextRemote, higherIsBetter) < costOf(previousRemote, higherIsBetter);
	}
	const nextCost = localCost(next, higherIsBetter);
	const previousCost = localCost(previous, higherIsBetter);
	if (nextCost === null) return false;
	if (previousCost === null) return true;
	return nextCost < previousCost;
}

function localCost(row, higherIsBetter) {
	const direct = finiteNumberOrNull(row?.cost);
	if (direct !== null) return direct;
	for (const key of ["full_score", "local_score", "score"]) {
		const score = finiteNumberOrNull(row?.[key]);
		if (score !== null) return costOf(score, higherIsBetter);
	}
	return null;
}

export function metricNumber(row, ...keys) {
	for (const key of keys) {
		const value = finiteNumberOrNull(row?.[key]);
		if (value !== null) return value;
	}
	return null;
}

// Read only metric keys sanctioned by the task contract plus the campaign's
// historical generic score keys. Protected local evaluators legitimately use
// task-specific names such as holdout_hierarchical_f1; do not scan arbitrary
// numeric fields (row counts, timings, etc.) or parse stdout.
export function scoreNumberForMetric(scoreData, metricName = "") {
	if (!scoreData || typeof scoreData !== "object" || Array.isArray(scoreData)) return null;
	const metric = String(metricName ?? "").trim();
	const keys = [
		...(metric ? [metric, `holdout_${metric}`, `oof_${metric}`] : []),
		"oof",
		"local_score",
		"score",
	];
	for (const key of new Set(keys)) {
		const value = finiteNumberOrNull(scoreData[key]);
		if (value !== null) return value;
	}
	return null;
}

export function isPassedCandidate(row) {
	if (!row || typeof row !== "object") return false;
	if (!["passed", "promoted"].includes(String(row.status ?? "").toLowerCase())) return false;
	return Number.isFinite(metricNumber(row, "cost"));
}

// Best = lowest cost among passed/promoted candidates.
export function bestPassedCandidate(rows) {
	return (rows ?? [])
		.filter((row) => isPassedCandidate(row))
		.sort((a, b) => metricNumber(a, "cost") - metricNumber(b, "cost"))[0];
}

export async function readJsonSafe(fsModule, filePath, fallback) {
	try {
		return JSON.parse(await fsModule.readFile(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

export async function readJsonlSafe(fsModule, filePath) {
	try {
		const text = await fsModule.readFile(filePath, "utf8");
		return text
			.split(/\r?\n/u)
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { raw: line.slice(0, 1000) };
				}
			});
	} catch {
		return [];
	}
}

export async function readTaskManifest(fsModule, pathModule, root) {
	const manifest = await readJsonSafe(fsModule, pathModule.join(root, "tasks.json"), { tasks: [] });
	return manifest.tasks ?? [];
}

export async function taskMetaFor(fsModule, pathModule, root, taskDirRel) {
	const tasks = await readTaskManifest(fsModule, pathModule, root);
	return tasks.find((task) => task.task_dir === taskDirRel) ?? null;
}

// Count today's (UTC) uploaded submissions recorded in runs/<xNN>/submission_log.jsonl.
export async function submissionsToday(fsModule, pathModule, root, taskDirRel) {
	const logPath = pathModule.join(taskArtifactDir(pathModule, root, taskDirRel), "submission_log.jsonl");
	const rows = await readJsonlSafe(fsModule, logPath);
	const today = new Date().toISOString().slice(0, 10);
	return rows.filter((row) => String(row?.submitted_at ?? "").slice(0, 10) === today && row?.uploaded !== false).length;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

// Task locks live at the contract path runs/active-task-locks/<xNN>.lock
export function taskLockDir(pathModule, root, taskDirRel) {
	return pathModule.join(root, "runs", "active-task-locks", `${pathModule.basename(taskDirRel)}.lock`);
}

export async function tryAcquireLock(fsModule, lockDir, info) {
	try {
		await fsModule.mkdir(lockDir, { recursive: false });
		await fsModule.writeFile(`${lockDir}/owner.json`, JSON.stringify({ ...info, acquired_at: new Date().toISOString() }, null, 2) + "\n");
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EEXIST") return false;
		throw error;
	}
}

export async function releaseLock(fsModule, lockDir, expectedLane = "") {
	if (expectedLane) {
		try {
			const owner = JSON.parse(await fsModule.readFile(`${lockDir}/owner.json`, "utf8"));
			if (owner.lane && owner.lane !== expectedLane) return false;
		} catch {
			return false;
		}
	}
	await fsModule.rm(lockDir, { recursive: true, force: true });
	return true;
}

export async function withFileLock(fsModule, pathModule, lockDir, info, fn, options = {}) {
	const staleMs = Number(options.staleMs ?? 6 * 60 * 60 * 1000);
	const retryMs = Number(options.retryMs ?? 2000);
	const timeoutMs = Number(options.timeoutMs ?? 12 * 60 * 60 * 1000);
	const started = Date.now();
	let acquired = false;
	while (!acquired) {
		acquired = await tryAcquireLock(fsModule, lockDir, info);
		if (acquired) break;
		await reapStaleLock(fsModule, lockDir, staleMs);
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for workflow lock: ${pathModule.relative(process.cwd(), lockDir)}`);
		}
		await Bun.sleep(retryMs);
	}
	try {
		return await fn();
	} finally {
		await releaseLock(fsModule, lockDir, info?.lane ?? "");
	}
}

async function reapStaleLock(fsModule, lockDir, staleMs) {
	if (!Number.isFinite(staleMs) || staleMs <= 0) return;
	try {
		const stat = await fsModule.stat(lockDir);
		if (Date.now() - stat.mtimeMs > staleMs) {
			await fsModule.rm(lockDir, { recursive: true, force: true });
		}
	} catch {
		// Missing locks are expected when another lane releases between attempts.
	}
}

// GPU pool: capacity-2 semaphore over workflow-output/locks/gpu-pool/slot-{0,1}.
// fn receives the acquired slot index; run training/eval with CUDA_VISIBLE_DEVICES=<slot>.
// Requests beyond capacity queue until a slot frees up.
export async function withGpuPool(fsModule, pathModule, root, info, fn, options = {}) {
	return withGpuPoolSlots(fsModule, pathModule, root, info, 1, async (slots) => fn(slots[0]), options);
}

export async function withGpuPoolSlots(fsModule, pathModule, root, info, requestedSlots, fn, options = {}) {
	const capacity = Number(options.capacity ?? 2);
	const count = Math.max(1, Math.min(capacity, Number(requestedSlots) || 1));
	const staleMs = Number(options.staleMs ?? 15 * 60 * 1000);
	const retryMs = Number(options.retryMs ?? 3000);
	const timeoutMs = Number(options.timeoutMs ?? 16 * 60 * 60 * 1000);
	const heartbeatMs = Number(options.heartbeatMs ?? 30 * 1000);
	const poolRoot = pathModule.join(root, "workflow-output", "locks", "gpu-pool");
	await fsModule.mkdir(poolRoot, { recursive: true });
	const started = Date.now();
	for (;;) {
		const acquired = [];
		for (let slot = 0; slot < capacity && acquired.length < count; slot += 1) {
			const slotDir = pathModule.join(poolRoot, `slot-${slot}`);
			await reapStaleLock(fsModule, slotDir, staleMs);
			if (await tryAcquireLock(fsModule, slotDir, { ...info, slot, requested_slots: count })) {
				acquired.push({ slot, slotDir });
			}
		}
		if (acquired.length === count) {
			let heartbeat;
			try {
				heartbeat = setInterval(() => {
					const now = new Date();
					for (const item of acquired) void fsModule.utimes(item.slotDir, now, now).catch(() => {});
				}, heartbeatMs);
				return await fn(acquired.map((item) => item.slot));
			} finally {
				if (heartbeat) clearInterval(heartbeat);
				for (const item of acquired.reverse()) await releaseLock(fsModule, item.slotDir, info?.lane ?? "");
			}
		}
		for (const item of acquired.reverse()) await releaseLock(fsModule, item.slotDir, info?.lane ?? "");
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${count} gpu-pool slot(s)`);
		await Bun.sleep(retryMs);
	}
}

export function compactWorkerPool(state) {
	return {
		active_tasks: activeTaskEntries(state),
		active_task_dirs: activeTaskDirs(state),
		lanes: WORKER_LANES,
	};
}

// ---------------------------------------------------------------------------
// Agent write-permission matrix (hardcoded single source of truth).
// Guard scripts enforce these globs; prompts merely inform the agents.
// Paths are campaign-root-relative unless listed under instanceAllow.
// ---------------------------------------------------------------------------

export const WRITE_MATRIX = {
	// PlanImplement / correctnessRepair: instance solution/ plus task docs; wiki read-only.
	implementer: {
		description: "implementer/repair agents write instance solution/ and runs/<task>/docs/ only",
		allow: [/^runs\/[^/]+\/docs\/.+/u],
		instanceAllow: [/^solution\/.+/u],
	},
	// reviseStrategy: next-step notes under task docs.
	coordinator: {
		description: "coordinator strategy notes under runs/<task>/docs/ only",
		allow: [/^runs\/[^/]+\/docs\/.+/u],
	},
	// selectTaskWorkload: the campaign coordinator's own direction documents.
	campaignCoordinator: {
		description: "campaign coordinator may only write runs/_campaign/** (direction documents)",
		allow: [/^runs\/_campaign\/.+/u],
	},
	// The single Searcher owns the shared wiki (create/modify/reorganize, including deletions).
	searcher: {
		description: "search agents may create/modify/reorganize wiki/ files only",
		allow: [/^wiki\/.+/u],
	},
	// reviewers and meeting agents write nothing.
	readonly: {
		description: "review/meeting agents must not write any files",
		allow: [],
	},
};

export function checkWriteScope(changedPaths, matrixKey) {
	const rules = WRITE_MATRIX[matrixKey] ?? WRITE_MATRIX.readonly;
	const violations = [];
	for (const relPath of changedPaths) {
		const normalized = normalizeRel(relPath);
		if (!rules.allow.some((pattern) => pattern.test(normalized))) {
			violations.push(normalized);
		}
	}
	return { ok: violations.length === 0, violations, policy: rules.description };
}

// ---------------------------------------------------------------------------
// Lightweight tree snapshots (relPath -> {size, mtimeMs}) for write-scope guards.
// Bounded trees only (runs/<xNN>/, wiki/) — never data/ or full instances.
// ---------------------------------------------------------------------------

export async function snapshotTree(fsModule, pathModule, rootDir, relTo) {
	const result = {};
	await walkTree(fsModule, pathModule, rootDir, async (filePath, stat) => {
		const relPath = normalizeRel(pathModule.relative(relTo, filePath));
		result[relPath] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
	});
	return result;
}

async function walkTree(fsModule, pathModule, dir, visit) {
	let entries;
	try {
		entries = await fsModule.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const filePath = pathModule.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			if (entry.name === "__pycache__") continue;
			await walkTree(fsModule, pathModule, filePath, visit);
		} else if (entry.isFile()) {
			try {
				const stat = await fsModule.stat(filePath);
				await visit(filePath, stat);
			} catch {
				/* raced deletion */
			}
		}
	}
}

export function diffTree(before, after) {
	const changed = [];
	const paths = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	for (const relPath of paths) {
		const left = (before ?? {})[relPath];
		const right = (after ?? {})[relPath];
		if (!left) changed.push({ path: relPath, kind: "added" });
		else if (!right) changed.push({ path: relPath, kind: "deleted" });
		else if (left.size !== right.size || left.mtimeMs !== right.mtimeMs) changed.push({ path: relPath, kind: "modified" });
	}
	return changed;
}
