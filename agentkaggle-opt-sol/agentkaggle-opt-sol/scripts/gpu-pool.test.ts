import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withGpuPoolSlots } from "./lane-utils.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("gpu pool", () => {
	test("leases both slots atomically and releases them", async () => {
		const root = await makeRoot();
		const slots = await withGpuPoolSlots(fs, path, root, { lane: "A", task_dir: "x01" }, 2, async (leased) => {
			expect(leased).toEqual([0, 1]);
			for (const slot of leased) {
				expect(await exists(path.join(root, "workflow-output", "locks", "gpu-pool", `slot-${slot}`, "owner.json"))).toBe(true);
			}
			return leased;
		}, { retryMs: 5, heartbeatMs: 10, timeoutMs: 500 });
		expect(slots).toEqual([0, 1]);
		expect(await lockNames(root)).toEqual([]);
	});

	test("allows two one-slot lanes concurrently", async () => {
		const root = await makeRoot();
		let releaseFirst!: () => void;
		let signalStarted!: (slot: number) => void;
		const started = new Promise<number>((resolve) => { signalStarted = resolve; });
		const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const first = withGpuPoolSlots(fs, path, root, { lane: "A" }, 1, async ([slot]) => {
			signalStarted(slot);
			await hold;
			return slot;
		}, { retryMs: 5, timeoutMs: 500 });
		const firstSlot = await started;
		const secondSlot = await withGpuPoolSlots(fs, path, root, { lane: "B" }, 1, async ([slot]) => slot, { retryMs: 5, timeoutMs: 500 });
		expect(secondSlot).not.toBe(firstSlot);
		releaseFirst();
		await first;
		expect(await lockNames(root)).toEqual([]);
	});

	test("releases leases when the command fails", async () => {
		const root = await makeRoot();
		await expect(withGpuPoolSlots(fs, path, root, { lane: "A" }, 1, async () => {
			throw new Error("boom");
		}, { retryMs: 5, timeoutMs: 500 })).rejects.toThrow("boom");
		expect(await lockNames(root)).toEqual([]);
	});
});

async function makeRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpu-pool-"));
	temporaryRoots.push(root);
	return root;
}

async function lockNames(root: string) {
	try {
		return (await fs.readdir(path.join(root, "workflow-output", "locks", "gpu-pool"))).filter((name) => name.startsWith("slot-"));
	} catch {
		return [];
	}
}

async function exists(filePath: string) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
