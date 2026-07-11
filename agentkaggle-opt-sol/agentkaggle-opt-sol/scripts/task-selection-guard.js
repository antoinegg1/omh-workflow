// Acquire the per-task lock, then materialize (or reuse) the writable run
// instance per the campaign contract: copy solution_baseline into
// INSTANCE_ROOT/agk-<runTag>-<task>/solution/, symlink the protected package
// files from the raw dir, and record an integrity_before snapshot.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	activeTaskEntries,
	checkWriteScope,
	diffTree,
	extractTaskDir,
	instanceDirFor,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	readJsonlSafe,
	readJsonSafe,
	readRunTag,
	snapshotTree,
	taskArtifactDir,
	taskLockDir,
	taskMetaFor,
	tryAcquireLock,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);

const state = workflowContext.state ?? {};
const lane = laneFromContext(workflowContext);
const local = laneState(state, lane);
const selection = local.selection ?? state.selection ?? {};
const taskDir = extractTaskDir(selection);
const outputDir = laneOutputDir(path, root, lane, taskDir);
await fs.mkdir(outputDir, { recursive: true });

const result = {
	lane,
	task_dir: taskDir,
	status: "idle",
	reason: "",
	instance_dir: "",
	artifact_dir: "",
	active_tasks: activeTaskEntries(state),
};

// Campaign-coordinator write-scope check (hardcoded matrix): the selection agent
// may only have written runs/_campaign/** (its direction documents). Declared
// writes are verified; the actual runs/_campaign/ delta is recorded for audit.
{
	const declared = Array.isArray(selection.files_changed)
		? selection.files_changed.map((item) => String(item ?? "").trim()).filter(Boolean)
		: [];
	const verdict = checkWriteScope(declared, "campaignCoordinator");
	const dirSnapshotPath = path.join(root, "workflow-output", "campaign-dir-snapshot.json");
	const previous = await readJsonSafe(fs, dirSnapshotPath, null);
	const current = await snapshotTree(fs, path, path.join(root, "runs", "_campaign"), root);
	const audit = previous ? diffTree(previous, current).map((item) => `${item.kind}:${item.path}`) : [];
	await fs.writeFile(dirSnapshotPath, JSON.stringify(current) + "\n");
	result.coordinator_scope = {
		checked: declared.length > 0,
		declared_ok: verdict.ok,
		violations: verdict.violations.slice(0, 12),
		campaign_dir_changes: audit.slice(0, 20),
		policy: verdict.policy,
	};
}

if (!taskDir) {
	result.status = "idle";
	result.reason = "selection did not name a task";
} else if (!(await exists(path.join(root, taskDir)))) {
	result.status = "invalid";
	result.reason = `selected task does not exist: ${taskDir}`;
} else {
	const lockDir = taskLockDir(path, root, taskDir);
	// A Kaggle-confirmed top-1 task is DONE — hard-reject re-selection so no lane
	// spends rounds or submissions on an already-achieved target.
	const boardRow = (await readJsonSafe(fs, path.join(root, "leaderboard.json"), {}))?.best_by_task?.find?.(
		(row) => row?.task_dir === taskDir,
	);
	if (boardRow?.reached_top1) {
		result.status = "duplicate";
		result.reason = `slot ${lane || "single"} rejected ${taskDir}: target already reached (kaggle top-1 confirmed)`;
	} else {
	// Reap a stale task lock leaked by a dead lane (e.g. a timed-out node that
	// never reached releaseWorkerSlot). Default staleness 12h, env-tunable.
	const staleHours = Number.parseFloat(process.env.SOL_H800_TASK_LOCK_STALE_H ?? "12") || 12;
	try {
		const stat = await fs.stat(lockDir);
		if (Date.now() - stat.mtimeMs > staleHours * 3600 * 1000) {
			await fs.rm(lockDir, { recursive: true, force: true });
		}
	} catch {
		/* no existing lock */
	}
	const acquired = await tryAcquireLock(fs, lockDir, {
		lane,
		task_dir: taskDir,
		node_id: workflowContext.node?.id ?? "",
		activation_id: workflowContext.activation?.id ?? "",
	});
	const owner = acquired ? null : await readLockOwner(lockDir);
	const ownPreReservation = Boolean(owner?.lane && owner.lane === (lane || "single"));
	result.status = acquired || ownPreReservation ? "acquired" : "duplicate";
	result.reason = acquired
		? `slot ${lane || "single"} acquired ${taskDir}`
		: ownPreReservation
			? `slot ${lane || "single"} confirmed pre-reserved ${taskDir}`
			: `slot ${lane || "single"} rejected duplicate active task ${taskDir}`;

	if (result.status === "acquired") {
		// Fresh stint: stamp the stint identity (the local-loop gate resets its round
		// counter when the stint changes), clear historical park markers so a
		// re-assigned task is no longer status=parked, and reset the meeting streak.
		const stintAt = new Date().toISOString();
		await fs.writeFile(path.join(outputDir, "stint.json"), JSON.stringify({ acquired_at: stintAt, lane, task_dir: taskDir }) + "\n");
		result.stint_started_at = stintAt;
		await clearParkMarkers(taskDir);
		await fs.rm(path.join(root, "workflow-output", "meeting-streaks", `${lane || "X"}.json`), { force: true });
		const materialized = await materializeInstance(taskDir);
		result.instance_dir = materialized.instance_dir;
		result.artifact_dir = materialized.artifact_dir;
		result.instance_status = materialized.status;
		result.integrity_before = materialized.integrity_before;
		if (materialized.status === "failed") {
			result.status = "invalid";
			result.reason = `instance materialization failed: ${materialized.reason}`;
		}
	}
	}
}

if (result.coordinator_scope?.checked && !result.coordinator_scope.declared_ok) {
	result.reason = `${result.reason ? `${result.reason}; ` : ""}coordinator write-scope violation recorded (${result.coordinator_scope.violations.slice(0, 3).join(", ")})`;
}

const outputPath = path.join(outputDir, "task-selection-guard.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

const patches = [lanePatch(lane, "selectionGuard", result)];
if (result.status === "acquired") {
	patches.push({
		op: "set",
		path: `/workerPool/activeTasks/${lane || "single"}`,
		value: { status: "active", lane: lane || "single", task_dir: taskDir, since: new Date().toISOString() },
	});
}

return {
	summary: result.reason || result.status,
	data: result,
	statePatch: patches,
	artifacts: [`local://${path.relative(root, outputPath)}`],
};

// A re-assigned task starts a fresh stint: strip the local_loop_exhausted flags
// that made its status parked_* so the campaign state reflects it as workable.
async function clearParkMarkers(taskDirRel) {
	try {
		const candidatesPath = path.join(taskArtifactDir(path, root, taskDirRel), "candidates.jsonl");
		const rows = await readJsonlSafe(fs, candidatesPath);
		if (rows.length === 0) return;
		let changed = false;
		const next = rows.map((row) => {
			if (!row || typeof row !== "object" || !row.local_loop_exhausted) return row;
			const copy = { ...row };
			delete copy.local_loop_exhausted;
			copy.local_loop_status = "reopened_by_coordinator";
			changed = true;
			return copy;
		});
		if (changed) {
			await fs.writeFile(candidatesPath, next.map((row) => JSON.stringify(row)).join("\n") + "\n");
		}
	} catch {
		/* best-effort */
	}
}

// Materialize the writable run instance per the campaign contract. Reused across
// rounds within the same campaign run (idempotent). Never writes into the raw dir.
async function materializeInstance(taskDirRel) {
	const rawDir = path.join(root, taskDirRel);
	const runTag = (await readRunTag(fs, path, root)) || "manual";
	const instanceDir = instanceDirFor(path, runTag, taskDirRel);
	const artifactDir = taskArtifactDir(path, root, taskDirRel);
	const out = {
		instance_dir: instanceDir,
		artifact_dir: artifactDir,
		status: "reused",
		reason: "",
		integrity_before: "",
	};
	try {
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.mkdir(path.join(artifactDir, "docs"), { recursive: true });
		const isNew = !(await exists(path.join(instanceDir, "solution")));
		if (isNew) {
			await fs.mkdir(instanceDir, { recursive: true });
			for (const name of ["TASK.md", "requirements.txt", "data", "evaluation", "submit.py"]) {
				const target = path.join(rawDir, name);
				const link = path.join(instanceDir, name);
				if (!(await exists(target))) continue;
				const resolved = await fs.realpath(target);
				await fs.rm(link, { recursive: true, force: true });
				await fs.symlink(resolved, link);
			}
			await copyBaseline(path.join(rawDir, "solution_baseline"), path.join(instanceDir, "solution"));
			await chmodTreeWritable(path.join(instanceDir, "solution"));
			out.status = "created";
		}
		const integrity = await runIntegrity(instanceDir);
		const integrityPath = path.join(artifactDir, "integrity_before.txt");
		await fs.writeFile(integrityPath, `${new Date().toISOString()} lane=${lane}\n${integrity.stdout}\n${integrity.stderr}\n`);
		out.integrity_before = integrity.exitCode === 0 ? "ok" : "failed";
		if (integrity.exitCode !== 0) {
			out.status = "failed";
			out.reason = `check_integrity failed before work: ${(integrity.stderr || integrity.stdout).slice(0, 400)}`;
		}
	} catch (error) {
		out.status = "failed";
		out.reason = error instanceof Error ? error.message : String(error);
	}
	return out;
}

// cp -aL semantics: dereference symlinked baseline files into a real writable copy.
async function copyBaseline(src, dest) {
	await fs.mkdir(dest, { recursive: true });
	const entries = await fs.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		const stat = await fs.stat(from); // follows symlinks
		if (stat.isDirectory()) {
			await copyBaseline(from, to);
		} else {
			await fs.copyFile(from, to);
		}
	}
}

async function chmodTreeWritable(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	await fs.chmod(dir, 0o755).catch(() => {});
	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) await chmodTreeWritable(filePath);
		else await fs.chmod(filePath, 0o644).catch(() => {});
	}
}

async function runIntegrity(instanceDir) {
	try {
		const proc = Bun.spawn(["python3", "evaluation/check_integrity.py"], { cwd: instanceDir, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readLockOwner(lockDir) {
	try {
		return JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"));
	} catch {
		return null;
	}
}
