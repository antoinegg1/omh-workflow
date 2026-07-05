export const WORKER_LANES = ["A", "B", "C", "D", "E"];

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
		.replace(/^\/?mnt\/public\/lichangye\/kernel-opt(?:-simple|-test)?\//u, "")
		.replace(/^\/?root\/kernel-opt\//u, "")
		.replace(/\/+$/u, "");
}

export function normalizeTaskDir(value) {
	const text = normalizeRel(value).trim();
	const match = /tasks\/[A-Za-z0-9_./-]+|[0-9]{3}_[A-Za-z0-9_.-]+/u.exec(text);
	if (!match) return "";
	const taskDir = normalizeRel(match[0]);
	return taskDir.startsWith("tasks/") ? taskDir : `tasks/${taskDir}`;
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

export function taskLockDir(pathModule, root, taskDirRel) {
	return pathModule.join(root, "workflow-output", "active-task-locks", encodeURIComponent(taskDirRel));
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

export function compactWorkerPool(state) {
	return {
		active_tasks: activeTaskEntries(state),
		active_task_dirs: activeTaskDirs(state),
		lanes: WORKER_LANES,
	};
}
