import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compactCampaignControls, normalizeFailureFingerprint, readCampaignControls, taskQuarantine } from "./campaign-controls";

describe("campaign controls", () => {
	it("expires window-local controls", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agk-controls-"));
		await fs.mkdir(path.join(root, "workflow-output"));
		await fs.writeFile(
			path.join(root, "workflow-output", "campaign-controls.json"),
			JSON.stringify({
				window_id: "w1",
				expires_at: "2026-07-17T01:00:00Z",
				task_quarantine: { x02: { reason: "test" } },
			}),
		);
		const controls = await readCampaignControls(fs, path, root, Date.parse("2026-07-17T02:00:00Z"));
		expect(controls.active).toBe(false);
		expect(taskQuarantine(controls, "x02")).toBeNull();
		expect(compactCampaignControls(controls).quarantined_tasks).toEqual(["x02"]);
		await fs.rm(root, { recursive: true, force: true });
	});

	it("normalizes volatile failure details", () => {
		expect(normalizeFailureFingerprint("Activation-123 failed req_ABC123 at 2026-07-17T01:02:03Z code 400"))
			.toBe("activation failed req at timestamp code n");
	});
});
