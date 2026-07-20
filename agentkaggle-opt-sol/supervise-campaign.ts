#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { normalizeFailureFingerprint } from "./agentkaggle-opt-sol/scripts/campaign-controls.js";

interface SupervisorOptions {
	cwd: string;
	flow: string;
	durationSeconds: number;
	pollSeconds: number;
	graceSeconds: number;
	kagglePython: string;
	deadlineAt?: string;
	windowId?: string;
}

interface StintEvent {
	event?: string;
	at?: string;
	lane?: string;
	task_dir?: string;
	failure_fingerprint?: string;
	submission_status?: string;
}

interface CampaignControls {
	version: number;
	window_id: string;
	started_at: string;
	expires_at: string;
	phase: string;
	priority_tasks: string[];
	coverage_mode: string;
	max_no_improve_rounds: number;
	max_recovery_attempts: number;
	task_quarantine: Record<string, Record<string, unknown>>;
	submission_freeze: Record<string, Record<string, unknown>>;
}

interface AttemptResult {
	runId: string;
	status: string;
	exitCode: number;
	durationMs: number;
	stopReason: string;
	fingerprint: string;
	checkpointBundlePath: string;
	json: Record<string, unknown> | null;
}

export function continuousCampaignControls(windowId: string, startedAt: string, expiresAt: string): CampaignControls {
	return {
		version: 2,
		window_id: windowId,
		started_at: startedAt,
		expires_at: expiresAt,
		phase: "continuous",
		priority_tasks: [],
		coverage_mode: "hybrid",
		max_no_improve_rounds: 5,
		max_recovery_attempts: 1,
		task_quarantine: {},
		submission_freeze: {},
	};
}

export function applyStintControls(
	controls: CampaignControls,
	events: StintEvent[],
	nowIso = new Date().toISOString(),
): CampaignControls {
	const next: CampaignControls = structuredClone(controls);
	const startedMs = Date.parse(controls.started_at);
	for (const task of new Set(events.map(event => String(event.task_dir ?? "")).filter(Boolean))) {
		const taskEvents = events.filter(
			event => event.task_dir === task && Date.parse(String(event.at ?? "")) >= startedMs,
		);
		const failureEvents = taskEvents.filter(event => event.event === undefined || event.event === "released");
		let streakFingerprint = "";
		let streak = 0;
		for (const event of failureEvents) {
			const fingerprint = String(event.failure_fingerprint ?? "");
			if (!fingerprint) {
				streakFingerprint = "";
				streak = 0;
				continue;
			}
			if (fingerprint === streakFingerprint) streak += 1;
			else {
				streakFingerprint = fingerprint;
				streak = 1;
			}
		}
		if (streak >= 3 && !next.task_quarantine[task]) {
			next.task_quarantine[task] = {
				at: nowIso,
				reason: `three consecutive stints failed with ${streakFingerprint}`,
				fingerprint: streakFingerprint,
				failures: streak,
			};
		}
		const submissionFailure = taskEvents.find(event =>
			["upload_failed", "scoring_error"].includes(String(event.submission_status ?? "")),
		);
		if (submissionFailure && !next.submission_freeze[task]) {
			next.submission_freeze[task] = {
				at: nowIso,
				reason: `submission transport returned ${submissionFailure.submission_status}`,
				status: submissionFailure.submission_status,
			};
		}
	}
	return next;
}

export function shouldCircuitBreak(
	history: Array<{ fingerprint: string; quick: boolean }>,
	limit = 3,
): boolean {
	if (history.length < limit) return false;
	const tail = history.slice(-limit);
	return tail.every(item => item.quick && item.fingerprint && item.fingerprint === tail[0]?.fingerprint);
}

export function parseFinalWorkflowJson(text: string): Record<string, unknown> | null {
	const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const parsed = JSON.parse(lines[index] as string);
			if (parsed && typeof parsed === "object" && "run" in parsed) return parsed;
		} catch {
			/* not the final JSON line */
		}
	}
	return null;
}

async function main() {
	const options = parseArgs(Bun.argv.slice(2));
	const launchedMs = Date.now();
	const requestedDeadlineMs = options.deadlineAt ? Date.parse(options.deadlineAt) : Number.NaN;
	const deadlineMs = Number.isFinite(requestedDeadlineMs)
		? requestedDeadlineMs
		: launchedMs + options.durationSeconds * 1000;
	if (deadlineMs <= launchedMs) throw new Error(`supervisor deadline has already passed: ${new Date(deadlineMs).toISOString()}`);
	const windowId = options.windowId ?? new Date(launchedMs).toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14);
	const archiveDir = path.join(options.cwd, "workflow-output", "omh-supervisor", windowId);
	const controlsPath = path.join(options.cwd, "workflow-output", "campaign-controls.json");
	const eventsPath = path.join(options.cwd, "workflow-output", "stint-events.jsonl");
	const statusPath = path.join(options.cwd, "workflow-output", "omh-supervisor-status.json");
	const pidPath = path.join(options.cwd, "workflow-output", "omh-supervisor.pid");
	await fs.mkdir(archiveDir, { recursive: true });
	const existingControls = await readJson(controlsPath) as CampaignControls | null;
	const resumingWindow = existingControls?.window_id === windowId;
	let controls: CampaignControls = resumingWindow
		? { ...continuousCampaignControls(windowId, existingControls.started_at, new Date(deadlineMs).toISOString()), ...existingControls, phase: "continuous" }
		: continuousCampaignControls(windowId, new Date(launchedMs).toISOString(), new Date(deadlineMs).toISOString());
	controls.expires_at = new Date(deadlineMs).toISOString();
	await writeJsonAtomic(controlsPath, controls);
	await fs.writeFile(pidPath, `${process.pid}\n`);
	await writeJsonAtomic(path.join(archiveDir, "window.json"), { ...options, windowId, started_at: controls.started_at, expires_at: controls.expires_at });
	await writeJsonAtomic(statusPath, {
		status: "starting",
		window_id: windowId,
		supervisor_pid: process.pid,
		started_at: controls.started_at,
		deadline_at: controls.expires_at,
		updated_at: new Date().toISOString(),
	});

	let attempt = (await readJsonl(path.join(archiveDir, "attempts.jsonl"))).length + 1;
	let restartBundlePath = "";
	let checkpointRecoveryCount = 0;
	let haltRequested = false;
	let activeProcess: Bun.Subprocess | null = null;
	const failureHistory: Array<{ fingerprint: string; quick: boolean }> = [];
	const requestStop = () => {
		haltRequested = true;
		activeProcess?.kill("SIGTERM");
	};
	process.on("SIGINT", requestStop);
	process.on("SIGTERM", requestStop);

	while (!haltRequested && Date.now() < deadlineMs) {
		controls.phase = "continuous";
		controls.priority_tasks = [];
		await writeJsonAtomic(controlsPath, controls);
		const runId = `agk-continuous-${windowId}-a${attempt}`;
		const result = await runAttempt({
			options,
			windowId,
			archiveDir,
			controlsPath,
			eventsPath,
			statusPath,
			controls,
			attempt,
			runId,
			deadlineMs,
			checkpointBundlePath: restartBundlePath,
			setProcess: proc => {
				activeProcess = proc;
			},
			shouldStop: () => haltRequested,
		});
		activeProcess = null;
		await archiveRuntimeState(options.cwd, archiveDir, runId);
		await fs.appendFile(path.join(archiveDir, "attempts.jsonl"), `${JSON.stringify(result)}\n`);
		await writeJsonAtomic(statusPath, {
			status: "between_attempts",
			window_id: windowId,
			supervisor_pid: process.pid,
			attempt,
			last_result: result,
			started_at: controls.started_at,
			deadline_at: controls.expires_at,
			updated_at: new Date().toISOString(),
		});

		const stintEvents = await readJsonl(eventsPath);
		controls = applyStintControls(controls, stintEvents);
		await writeJsonAtomic(controlsPath, controls);
		if (haltRequested || Date.now() >= deadlineMs) break;
		if (result.status === "completed") break;
		if (result.status !== "completed" && result.checkpointBundlePath && checkpointRecoveryCount < controls.max_recovery_attempts) {
			checkpointRecoveryCount += 1;
			restartBundlePath = result.checkpointBundlePath;
			await appendRecoveryEvents(eventsPath, controls, await activeTaskLocks(options.cwd), "recovery_started", result.fingerprint);
			attempt += 1;
			continue;
		}
		if (result.status !== "completed" && checkpointRecoveryCount >= controls.max_recovery_attempts) {
			const failedTasks = await activeTaskLocks(options.cwd);
			await archiveAndReleaseFailedTasks(options.cwd, archiveDir, failedTasks, runId);
			await appendRecoveryEvents(eventsPath, controls, failedTasks, "recovery_exhausted", result.fingerprint);
			const failedNodeIds = Array.isArray(result.json?.failedActivations)
				? result.json.failedActivations.map(entry => String((entry as Record<string, unknown>)?.nodeId ?? ""))
				: [];
			for (const task of taskLocksToQuarantine(result.fingerprint, failedNodeIds, failedTasks)) {
				controls.task_quarantine[task.task_dir] = {
					at: new Date().toISOString(),
					reason: `checkpoint recovery exhausted: ${result.fingerprint || "workflow failure"}`,
					fingerprint: result.fingerprint,
				};
			}
			restartBundlePath = "";
			checkpointRecoveryCount = 0;
			await writeJsonAtomic(controlsPath, controls);
		}

		const quick = result.durationMs < 10 * 60 * 1000;
		failureHistory.push({ fingerprint: result.fingerprint, quick });
		if (shouldCircuitBreak(failureHistory)) {
			await fs.writeFile(path.join(archiveDir, "CIRCUIT_BREAKER"), `${new Date().toISOString()} ${result.fingerprint}\n`);
			break;
		}
		const backoffMs = failureHistory.length % 3 === 1 ? 90_000 : 300_000;
		await Bun.sleep(Math.min(backoffMs, Math.max(0, deadlineMs - Date.now())));
		attempt += 1;
	}

	controls = applyStintControls(controls, await readJsonl(eventsPath));
	await writeJsonAtomic(controlsPath, controls);
	await writeJsonAtomic(path.join(archiveDir, "final-status.json"), {
		window_id: windowId,
		started_at: controls.started_at,
		expires_at: controls.expires_at,
		ended_at: new Date().toISOString(),
		halt_requested: haltRequested,
		controls,
	});
	await writeJsonAtomic(statusPath, {
		status: haltRequested ? "operator_stopped" : Date.now() >= deadlineMs ? "deadline_reached" : "finished",
		window_id: windowId,
		supervisor_pid: process.pid,
		started_at: controls.started_at,
		deadline_at: controls.expires_at,
		ended_at: new Date().toISOString(),
	});
	await fs.rm(pidPath, { force: true });
}

async function runAttempt(input: {
	options: SupervisorOptions;
	windowId: string;
	archiveDir: string;
	controlsPath: string;
	eventsPath: string;
	statusPath: string;
	controls: CampaignControls;
	attempt: number;
	runId: string;
	deadlineMs: number;
	checkpointBundlePath: string;
	setProcess(proc: Bun.Subprocess): void;
	shouldStop(): boolean;
}): Promise<AttemptResult> {
	const { options, runId, archiveDir, deadlineMs } = input;
	const attemptStartedMs = Date.now();
	const logPath = path.join(archiveDir, `${runId}.log`);
	const pythonPackages = path.join(options.cwd, "workflow-output", "python-packages");
	await fs.mkdir(pythonPackages, { recursive: true });
	const env: Record<string, string> = {
		...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
		PATH: `/root/agentkaggle-v2/runtime-venv/bin:${process.env.PATH ?? ""}`,
		AGK_KAGGLE_PYTHON: options.kagglePython,
		PIP_TARGET: pythonPackages,
		PYTHONPATH: [pythonPackages, process.env.PYTHONPATH ?? ""].filter(Boolean).join(path.delimiter),
		SOL_H800_WORKER_LANES: "4",
		SOL_H800_SEARCH_AGENTS: "1",
		SOL_H800_ENABLE_MEETING: "0",
		SOL_H800_USE_COORDINATOR: "1",
		SOL_H800_PAUSE_AT: new Date(deadlineMs).toISOString(),
	};
	delete env.SOL_H800_TASK_BATCH;
	const remainingMs = Math.max(1_000, deadlineMs - Date.now());
	const workflowArgs = input.checkpointBundlePath
		? ["omh", "workflow", "restart", input.checkpointBundlePath]
		: ["omh", "workflow", "start", options.flow];
	const proc = Bun.spawn(
		[
			...workflowArgs,
			"--run-id",
			runId,
			"--json",
			"--agent-retry-max-attempts",
			"2",
			"--max-runtime-ms",
			String(remainingMs),
		],
		{ cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" },
	);
	input.setProcess(proc);
	await writeJsonAtomic(input.statusPath, {
		status: "running",
		window_id: input.windowId,
		supervisor_pid: process.pid,
		runner_pid: proc.pid,
		run_id: runId,
		attempt: input.attempt,
		restart_bundle: input.checkpointBundlePath || undefined,
		started_at: input.controls.started_at,
		deadline_at: input.controls.expires_at,
		updated_at: new Date().toISOString(),
	});
	let stdoutTail = "";
	let stderrTail = "";
	const stdoutPump = pump(proc.stdout, logPath, text => {
		stdoutTail = tailText(stdoutTail + text);
	});
	const stderrPump = pump(proc.stderr, logPath, text => {
		stderrTail = tailText(stderrTail + text);
	});
	let stopReason = "";
	let previousCpu = -1;
	let previousSessionBytes = -1;
	let stagnantAgentPolls = 0;
	let nextHourlyMs = attemptStartedMs + 60 * 60 * 1000;

	while (proc.exitCode === null) {
		const raced = await Promise.race([
			proc.exited.then(code => ({ exited: true, code })),
			Bun.sleep(options.pollSeconds * 1000).then(() => ({ exited: false, code: null })),
		]);
		if (raced.exited) break;
		const now = Date.now();
		let controls = applyStintControls(input.controls, await readJsonl(input.eventsPath));
		Object.assign(input.controls, controls);
		await writeJsonAtomic(input.controlsPath, controls);
		if (input.shouldStop()) stopReason = "operator_stop";
		else if (now >= deadlineMs + options.graceSeconds * 1000) stopReason = "deadline_grace_exhausted";

		const observability = await readJson(path.join(options.cwd, "workflow-output", "omh-runtime", "observability.json"));
		const running = Array.isArray(observability?.activations)
			? observability.activations.filter((activation: Record<string, unknown>) => activation.status === "running")
			: [];
		const agentRunning = running.some((activation: Record<string, unknown>) => ["agent", "review"].includes(String(activation.type ?? "")));
		const progressAgeMs = await fileAgeMs(path.join(options.cwd, "workflow-output", "omh-runtime", "progress.md"));
		const cpuTicks = await processTreeCpuTicks(proc.pid);
		const sessionBytes = await recentWorkflowSessionBytes(attemptStartedMs);
		if (agentRunning && progressAgeMs > 20 * 60_000) {
			if (cpuTicks === previousCpu && sessionBytes === previousSessionBytes) stagnantAgentPolls += 1;
			else stagnantAgentPolls = 0;
			if (stagnantAgentPolls >= 3 && !stopReason) stopReason = "agent_stall_after_runtime_watchdog";
		} else stagnantAgentPolls = 0;
		previousCpu = cpuTicks;
		previousSessionBytes = sessionBytes;
		const availableBytes = await availableDiskBytes(options.cwd);
		if (availableBytes < 75 * 1024 ** 3 && !stopReason) stopReason = "disk_below_75gb";
		await fs.appendFile(
			path.join(archiveDir, "health.jsonl"),
			`${JSON.stringify({ ts: new Date().toISOString(), run_id: runId, running, progress_age_ms: progressAgeMs, cpu_ticks: cpuTicks, session_bytes: sessionBytes, available_bytes: availableBytes, stop_reason: stopReason })}\n`,
		);
		await writeJsonAtomic(input.statusPath, {
			status: stopReason ? "stopping_attempt" : "running",
			window_id: input.windowId,
			supervisor_pid: process.pid,
			runner_pid: proc.pid,
			run_id: runId,
			attempt: input.attempt,
			restart_bundle: input.checkpointBundlePath || undefined,
			started_at: input.controls.started_at,
			deadline_at: input.controls.expires_at,
			updated_at: new Date().toISOString(),
			running_activations: running,
			progress_age_ms: progressAgeMs,
			available_bytes: availableBytes,
			stop_reason: stopReason,
		});
		if (now >= nextHourlyMs) {
			await fs.appendFile(
				path.join(archiveDir, "hourly.jsonl"),
				`${JSON.stringify({ ts: new Date().toISOString(), run_id: runId, running, controls })}\n`,
			);
			nextHourlyMs += 60 * 60 * 1000;
		}
		if (stopReason) {
			await stopProcess(proc, options.graceSeconds);
			break;
		}
	}
	const exitCode = await proc.exited;
	await Promise.all([stdoutPump, stderrPump]);
	const json = parseFinalWorkflowJson(stdoutTail);
	const status = String((json?.run as Record<string, unknown> | undefined)?.status ?? (exitCode === 0 ? "unknown" : "failed"));
	const failed = Array.isArray(json?.failedActivations) ? json.failedActivations : [];
	const failureText = failed.length > 0 ? JSON.stringify(failed) : stderrTail || stopReason || status;
	const checkpointBundlePath = String(json?.checkpointBundlePath ?? "");
	return {
		runId,
		status,
		exitCode,
		durationMs: Date.now() - attemptStartedMs,
		stopReason,
		fingerprint: normalizeFailureFingerprint(failureText),
		checkpointBundlePath,
		json,
	};
}

export interface ActiveTaskLock {
	task_dir: string;
	lane: string;
	lock_dir: string;
}

export function taskLocksToQuarantine(
	fingerprint: string,
	failedNodeIds: string[],
	tasks: ActiveTaskLock[],
): ActiveTaskLock[] {
	const normalized = fingerprint.toLowerCase();
	if ([
		"workflow checkpoint freeze mismatch",
		"declared workspaceaccess=read but changed workspace",
		"protected file check failed",
		"cannot find module",
		"user account is not active",
		"type=user_inactive",
	].some(marker => normalized.includes(marker))) return [];
	const failedLanes = new Set(
		failedNodeIds.map(nodeId => nodeId.match(/([A-D])$/u)?.[1] ?? "").filter(Boolean),
	);
	if (failedLanes.size === 0) return [];
	return tasks.filter(task => failedLanes.has(task.lane));
}

export async function activeTaskLocks(cwd: string): Promise<ActiveTaskLock[]> {
	const lockRoot = path.join(cwd, "runs", "active-task-locks");
	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(lockRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const locks: ActiveTaskLock[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
		const lockDir = path.join(lockRoot, entry.name);
		const owner = await readJson(path.join(lockDir, "owner.json"));
		const taskDir = String(owner?.task_dir ?? entry.name.slice(0, -".lock".length));
		if (!taskDir) continue;
		locks.push({ task_dir: taskDir, lane: String(owner?.lane ?? ""), lock_dir: lockDir });
	}
	return locks;
}

async function appendRecoveryEvents(
	eventsPath: string,
	controls: CampaignControls,
	tasks: ActiveTaskLock[],
	event: "recovery_started" | "recovery_exhausted",
	fingerprint: string,
): Promise<void> {
	if (tasks.length === 0) return;
	await fs.mkdir(path.dirname(eventsPath), { recursive: true });
	const at = new Date().toISOString();
	await fs.appendFile(
		eventsPath,
		tasks
			.map(task => JSON.stringify({
				event,
				at,
				window_id: controls.window_id,
				lane: task.lane,
				task_dir: task.task_dir,
				local_loop_status: event,
				failure_fingerprint: fingerprint,
			}))
			.join("\n") + "\n",
	);
}

async function archiveAndReleaseFailedTasks(
	cwd: string,
	archiveDir: string,
	tasks: ActiveTaskLock[],
	runId: string,
): Promise<void> {
	const runTag = await fs.readFile(path.join(cwd, "workflow-output", "run-tag.txt"), "utf8").then(text => text.trim()).catch(() => "");
	const instanceRoot = process.env.AGK_INSTANCE_ROOT || "/root/autokaggle/omh_runs";
	for (const task of tasks) {
		const taskName = path.basename(task.task_dir);
		const solutionDir = runTag ? path.join(instanceRoot, `agk-${runTag}-${taskName}`, "solution") : "";
		if (solutionDir) {
			await fs.cp(solutionDir, path.join(archiveDir, "recovery-exhausted", runId, taskName, "solution"), {
				recursive: true,
				force: true,
			}).catch(() => undefined);
		}
		await fs.rm(task.lock_dir, { recursive: true, force: true });
	}
}

async function stopProcess(proc: Bun.Subprocess, graceSeconds: number) {
	if (proc.exitCode !== null) return;
	proc.kill("SIGTERM");
	const exited = await Promise.race([
		proc.exited.then(() => true),
		Bun.sleep(graceSeconds * 1000).then(() => false),
	]);
	if (!exited && proc.exitCode === null) proc.kill("SIGKILL");
}

async function pump(stream: ReadableStream<Uint8Array>, filePath: string, onText: (text: string) => void) {
	const handle = await fs.open(filePath, "a");
	try {
		for await (const chunk of stream) {
			const text = new TextDecoder().decode(chunk);
			onText(text);
			await handle.write(text);
		}
	} finally {
		await handle.close();
	}
}

async function archiveRuntimeState(cwd: string, archiveDir: string, runId: string) {
	const sourceDir = path.join(cwd, "workflow-output", "omh-runtime");
	for (const name of ["observability.json", "progress.md"]) {
		try {
			await fs.copyFile(path.join(sourceDir, name), path.join(archiveDir, `${runId}-${name}`));
		} catch {
			/* absent on very early failure */
		}
	}
}

async function processTreeCpuTicks(rootPid: number): Promise<number> {
	const queue = [rootPid];
	const seen = new Set<number>();
	let total = 0;
	while (queue.length > 0) {
		const pid = queue.shift() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		try {
			const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			const end = stat.lastIndexOf(")");
			const fields = stat.slice(end + 2).split(/\s+/u);
			total += Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
			const children = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
			queue.push(...children.trim().split(/\s+/u).filter(Boolean).map(Number));
		} catch {
			/* process exited during sampling */
		}
	}
	return total;
}

async function recentWorkflowSessionBytes(startedMs: number): Promise<number> {
	let total = 0;
	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir("/tmp", { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("omh-workflow-agent-")) continue;
		const stack = [path.join("/tmp", entry.name)];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			let children: Dirent[] = [];
			try {
				children = await fs.readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of children) {
				const childPath = path.join(current, child.name);
				if (child.isDirectory()) stack.push(childPath);
				else if (child.name.endsWith(".jsonl")) {
					const stat = await fs.stat(childPath).catch(() => null);
					if (stat && stat.mtimeMs >= startedMs) total += stat.size;
				}
			}
		}
	}
	return total;
}

async function availableDiskBytes(target: string): Promise<number> {
	try {
		const stat = await fs.statfs(target);
		return Number(stat.bavail) * Number(stat.bsize);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

async function fileAgeMs(filePath: string): Promise<number> {
	try {
		return Date.now() - (await fs.stat(filePath)).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

async function readJson(filePath: string): Promise<any> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return null;
	}
}

async function readJsonl(filePath: string): Promise<StintEvent[]> {
	try {
		return (await fs.readFile(filePath, "utf8"))
			.split(/\r?\n/u)
			.filter(Boolean)
			.flatMap(line => {
				try {
					return [JSON.parse(line) as StintEvent];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

async function writeJsonAtomic(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.tmp-${process.pid}`;
	await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
	await fs.rename(tempPath, filePath);
}

function tailText(value: string, maxChars = 2_000_000): string {
	return value.length <= maxChars ? value : value.slice(-maxChars);
}

function parseArgs(args: string[]): SupervisorOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid supervisor arguments near ${key ?? "end"}`);
		values.set(key.slice(2), value);
	}
	return {
		cwd: path.resolve(values.get("cwd") ?? "/root/agnetkaggle_13"),
		flow: path.resolve(values.get("flow") ?? "/root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol.omhflow"),
		durationSeconds: positiveInt(values.get("duration-seconds"), 8 * 60 * 60),
		pollSeconds: positiveInt(values.get("poll-seconds"), 30),
		graceSeconds: positiveInt(values.get("grace-seconds"), 300),
		kagglePython: values.get("kaggle-python") ?? "/root/agentkaggle-v2/runtime-venv/bin/python",
		deadlineAt: values.get("deadline-at"),
		windowId: values.get("window-id"),
	};
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (import.meta.main) {
	await main().catch(error => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
