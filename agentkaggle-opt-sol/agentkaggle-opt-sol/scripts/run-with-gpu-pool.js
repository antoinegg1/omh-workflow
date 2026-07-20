#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withGpuPoolSlots } from "./lane-utils.js";

const parsed = parseArgs(process.argv.slice(2));
if (parsed.command.length === 0) {
	console.error("usage: run-with-gpu-pool.js --root ROOT --lane LANE --task TASK --gpus 1|2 --timeout-seconds N -- command [args...]");
	process.exit(2);
}

const result = await withGpuPoolSlots(
	fs,
	path,
	parsed.root,
	{ lane: parsed.lane, task_dir: parsed.task, kind: "agent-gpu-command", command: parsed.command[0] },
	parsed.gpus,
	async (slots) => runChild(parsed.command, slots, parsed.timeoutSeconds),
	{ capacity: 2, timeoutMs: Math.max(parsed.timeoutSeconds * 1000 + 60_000, 16 * 60 * 60 * 1000) },
);
process.exit(result);

function parseArgs(args) {
	const out = { root: process.cwd(), lane: "X", task: "", gpus: 1, timeoutSeconds: 3600, command: [] };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			out.command = args.slice(index + 1);
			break;
		}
		if (arg === "--root") out.root = path.resolve(args[++index] ?? out.root);
		else if (arg === "--lane") out.lane = String(args[++index] ?? out.lane);
		else if (arg === "--task") out.task = String(args[++index] ?? "");
		else if (arg === "--gpus") out.gpus = Math.max(1, Math.min(2, Number(args[++index]) || 1));
		else if (arg === "--timeout-seconds") out.timeoutSeconds = Math.max(1, Number(args[++index]) || 3600);
		else throw new Error(`unknown argument: ${arg}`);
	}
	return out;
}

async function runChild(command, slots, timeoutSeconds) {
	const proc = Bun.spawn(command, {
		cwd: process.cwd(),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, CUDA_VISIBLE_DEVICES: slots.join(",") },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			/* already exited */
		}
	}, timeoutSeconds * 1000);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	return timedOut ? 124 : exitCode;
}
