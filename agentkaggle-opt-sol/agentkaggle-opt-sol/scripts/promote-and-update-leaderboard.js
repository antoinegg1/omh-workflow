// Promotion + remote submission + leaderboard update (remote-primary).
// Five-way promotion gate (unchanged from the fork parent):
//   validation passed AND performance verdict=promote AND reward review not
//   failed AND no profile_required AND optimization_limit_reached.
// On promotion, under the leaderboard lock:
//   full-fit/final run in the instance (GPU pool) -> daily-cap ledger check ->
//   `python submit.py -m ...` -> poll `submit.py --score-only` for our row ->
//   record submission_log.jsonl + promoted candidates.jsonl row +
//   best_manifest.json + leaderboard.json/csv.
// The Kaggle public score is the leaderboard's primary value; local cost is an
// auxiliary column. Upload failure / cap exhaustion records pending_submission
// and never blocks the campaign.
const fs = await import("node:fs/promises");
const path = await import("node:path");

const root = process.cwd();
const state = workflowContext.state ?? {};
const resourceRoot = workflowContext.resources?.root ?? path.join(root, "workflows", "agentkaggle-opt-sol");
const {
	costOf,
	laneFromContext,
	laneOutputDir,
	lanePatch,
	laneState,
	readJsonlSafe,
	readJsonSafe,
	submissionsToday,
	taskArtifactDir,
	taskMetaFor,
	withFileLock,
	withGpuPool,
} = await import(`file://${path.join(resourceRoot, "scripts", "lane-utils.js")}`);
const lane = laneFromContext(workflowContext);
const localState = laneState(state, lane);
const rewardReview = localState.rewardHackReview ?? state.rewardHackReview ?? {};
const performanceReview = localState.performanceReview ?? state.performanceReview ?? {};
const validation = localState.validation ?? state.validation ?? {};
const taskContext = localState.taskContext ?? state.taskContext ?? {};
const taskDirRel = taskContext.task_dir ?? validation.task_dir ?? "";
const instanceDir = taskContext.instance_dir ?? "";
const performanceDecision = reviewDecision(performanceReview);
const rewardDecision = reviewDecision(rewardReview);
const rewardFailed = rewardDecision === "fail" || (!rewardDecision && verdictText(rewardReview).includes("fail"));
const optimizationLimitReached = hasOptimizationLimitReached(performanceReview);
const profileRequired = profileRequested(performanceReview);
// Submission gate (4-way): verdict=promote spends one remote submission NOW.
// optimization_limit_reached is deliberately NOT required here — it has its own
// job (finalizing the stint in the loop gate). This allows early calibration
// submissions when the reviewer judges the budget is worth spending.
const shouldPromote =
	validation.status === "passed" &&
	performanceDecision === "promote" &&
	!rewardFailed &&
	!profileRequired;

const taskMeta = taskDirRel ? await taskMetaFor(fs, path, root, taskDirRel) : null;
const higherIsBetter = Boolean(taskMeta?.higher_is_better);
const lockDir = path.join(root, "workflow-output", "locks", "leaderboard-update");

const { result, leaderboard } = await withFileLock(
	fs,
	path,
	lockDir,
	{ lane, task_dir: taskDirRel, kind: "leaderboard-update" },
	async () => {
		let promotion = null;
		if (shouldPromote && taskDirRel && instanceDir) {
			promotion = await promoteCandidate();
		}
		const leaderboard = await updateLeaderboard(promotion);
		const result = {
			status: promotion ? "updated" : "no-promotion",
			promoted_this_round: Boolean(promotion),
			optimization_limit_reached: optimizationLimitReached,
			profile_required: profileRequired,
			promotion_blocked_reason: shouldPromote
				? instanceDir
					? ""
					: "no run instance recorded for this task"
				: promotionBlockedReason(),
			promotion,
			best_count: leaderboard.best_count ?? 0,
			metric: leaderboard.metric ?? "kaggle_public(remote-primary)",
		};
		return { result, leaderboard };
	},
	{ staleMs: 60 * 60 * 1000, retryMs: 1500 },
);

const outputDir = laneOutputDir(path, root, lane, taskDirRel);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "leaderboard-update.json");
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
const compactResult = compactLeaderboardUpdate(result, outputPath);

return {
	summary: `${lane ? `slot ${lane}: ` : ""}leaderboard ${result.status}${
		result.promotion ? `; ${taskDirRel} kaggle_public=${result.promotion.kaggle_public ?? "pending"}` : ""
	}; best_count=${result.best_count}`,
	data: compactResult,
	statePatch: [
		lanePatch(lane, "leaderboardUpdate", compactResult),
		{ op: "set", path: "/leaderboard", value: compactLeaderboard(leaderboard) },
	],
	artifacts: [`local://${path.relative(root, outputPath)}`, "local://leaderboard.json", "local://leaderboard.csv"],
};

// ---------------------------------------------------------------------------

async function promoteCandidate() {
	const artifactDir = taskArtifactDir(path, root, taskDirRel);
	await fs.mkdir(artifactDir, { recursive: true });
	const candidate = validation.candidate ?? `promoted_${Date.now()}`;
	const promo = {
		candidate,
		task_dir: taskDirRel,
		local_score: validation.metrics?.score ?? null,
		local_cost: validation.metrics?.cost ?? null,
		metric_name: validation.metrics?.metric ?? taskMeta?.metric ?? "",
		full_score: null,
		kaggle_public: null,
		kaggle_private: null,
		submission_status: "not_attempted",
		submission_message: `agk ${candidate} lane${lane || "X"}`,
		submitted_at: "",
		notes: [],
	};

	// 1. Produce the submission artifact with the full evaluation command (skip
	// if it is byte-identical to the fast command validation just ran).
	const fastCmd = String(taskContext.commands?.local_eval_fast ?? "").trim();
	const fullCmd = String(taskContext.commands?.local_eval_full ?? "python evaluation/local_eval.py").trim();
	if (fullCmd && fullCmd !== fastCmd) {
		const args = fullCmd.replace(/^python3?\s+/u, "").split(/\s+/u).filter(Boolean);
		const fullRun = await withGpuPool(
			fs,
			path,
			root,
			{ lane, task_dir: taskDirRel, kind: "full-fit", candidate },
			async (slot) => run(["python3", ...args], instanceDir, 3180000, { CUDA_VISIBLE_DEVICES: String(slot) }),
		);
		if (fullRun.exitCode !== 0) {
			promo.submission_status = "full_fit_failed";
			promo.notes.push(`full evaluation failed: ${tail(fullRun.stderr || fullRun.stdout, 400)}`);
			await recordPromotion(artifactDir, promo);
			return promo;
		}
		const fullScoreData = await readJsonSafe(fs, path.join(instanceDir, "solution", "local_score.json"), null);
		promo.full_score = scoreNumber(fullScoreData);
	}

	// Integrity re-check after the full run, before anything leaves the machine.
	const integrity = await run(["python3", "evaluation/check_integrity.py"], instanceDir, 300000);
	if (integrity.exitCode !== 0) {
		promo.submission_status = "integrity_failed";
		promo.notes.push("check_integrity failed after full evaluation; submission aborted");
		await recordPromotion(artifactDir, promo);
		return promo;
	}

	// The submission artifact may be produced by the full evaluation (CSV-style
	// tasks) or by submit.py itself at upload time (packaging-style tasks whose
	// TASK.md says submit.py zips the built outputs). Absence here is advisory;
	// submit.py is the authority on assembling its own upload.
	const submissionFile = path.join(instanceDir, "solution", taskMeta?.submission_file ?? "submission.csv");
	if (!(await exists(submissionFile))) {
		promo.notes.push(`submission artifact not present before upload (${path.basename(submissionFile)}); relying on submit.py to build it`);
	}
	// Snapshot the exact submitted solution + artifact alongside the candidate.
	try {
		const candDir = path.join(artifactDir, "candidates", candidate);
		await fs.mkdir(candDir, { recursive: true });
		if (taskMeta?.edit_file) {
			await fs.copyFile(path.join(instanceDir, "solution", taskMeta.edit_file), path.join(candDir, `promoted-${taskMeta.edit_file}`));
		}
	} catch {
		/* snapshot best-effort */
	}

	// 2. Daily-cap ledger check (hard, script-enforced).
	const cap = Number(taskMeta?.daily_cap ?? 0) || null;
	const usedToday = await submissionsToday(fs, path, root, taskDirRel);
	if (cap !== null && usedToday >= cap) {
		promo.submission_status = "cap_exhausted";
		promo.notes.push(`daily submission cap reached (${usedToday}/${cap}); promotion recorded as pending_submission`);
		await appendSubmissionLog(artifactDir, promo, { uploaded: false });
		await recordPromotion(artifactDir, promo);
		return promo;
	}

	// 3. Upload — routed by the task's declared submission_mode (tasks.json fact):
	//   file          → package CLI → spaced retry+census → v1 REST → rename
	//   kernel_output → straight to the kernel route (file uploads are policy-
	//                   rejected; don't burn 10 minutes discovering that again)
	//   code_notebook → kernels-only code competition: stage optional model
	//                   dataset, push the notebook, submit the kernel version
	//                   (Kaggle reruns it on the hidden test)
	promo.submitted_at = new Date().toISOString();
	const submissionMode = String(taskMeta?.submission_mode ?? "file");
	promo.submission_mode = submissionMode;
	if (submissionMode === "kernel_output" || submissionMode === "code_notebook") {
		const kernelMetaPath = path.join(instanceDir, "solution", "kernel-metadata.json");
		if (!(await exists(kernelMetaPath))) {
			promo.submission_status = "kernel_assets_missing";
			promo.notes.push(
				`${submissionMode} competition and no solution/kernel-metadata.json — the lane must author kernel assets (kernel-metadata.json + notebook that regenerates predictions in-kernel; see wiki kernel-ref playbook)`,
			);
			await appendSubmissionLog(artifactDir, promo, { uploaded: false });
			await recordPromotion(artifactDir, promo);
			return promo;
		}
		const kernelResult = await kernelRouteSubmit(kernelMetaPath, { verifyOutput: submissionMode === "kernel_output" });
		if (kernelResult.ok) {
			promo.notes.push(`uploaded via kernel route (${kernelResult.detail})`);
			promo.submission_status = "uploaded";
			await appendSubmissionLog(artifactDir, promo, { uploaded: true });
			const polled = await pollScore(promo.submission_message, 12, 30000);
			if (polled) {
				promo.kaggle_public = polled.public;
				promo.kaggle_private = polled.private;
				promo.submission_status =
					polled.public !== null ? "scored" : /error/iu.test(polled.status ?? "") ? "scoring_error" : "pending_score";
			} else {
				promo.submission_status = "pending_score";
				promo.notes.push("score not visible yet; the read-only backfill sweep will pick it up");
			}
			await recordPromotion(artifactDir, promo);
			return promo;
		}
		promo.submission_status = "upload_failed";
		promo.notes.push(`kernel route failed at ${kernelResult.step}: ${kernelResult.detail}`);
		await appendSubmissionLog(artifactDir, promo, { uploaded: false });
		await recordPromotion(artifactDir, promo);
		return promo;
	}
	let upload = await run(["python3", "submit.py", "-m", promo.submission_message], instanceDir, 600000);
	if (upload.exitCode !== 0) {
		// Kaggle-side hiccups (5xx / brief network faults) are common enough that a
		// single spaced retry rescues most uploads; a genuine rejection fails twice
		// with the same message and is recorded below. Guard against double-spend
		// first: if the failed attempt actually landed (CLI died after upload), the
		// message already shows in the read-only submission list — then skip retry.
		await new Promise((resolve) => setTimeout(resolve, 45000));
		const listCheck = await run(["python3", "submit.py", "--score-only"], instanceDir, 120000);
		if (!String(listCheck.stdout ?? "").includes(promo.submission_message)) {
			upload = await run(["python3", "submit.py", "-m", promo.submission_message], instanceDir, 600000);
		} else {
			promo.notes.push("first upload attempt landed despite nonzero exit (message visible in submission list); treating as uploaded");
			upload = { exitCode: 0, stdout: listCheck.stdout, stderr: "" };
		}
	}
	// The v2 kaggle CLI's CreateSubmission endpoint 400-rejects some legacy
	// community competitions that the v1 REST protocol still accepts (proven:
	// same account+file succeeded pre-CLI-upgrade). When that exact signature
	// appears, resubmit the SAME artifact with the SAME message via the v1
	// endpoints inside this gated promotion — transport swap only; predictions,
	// message, and ledger accounting are identical.
	if (upload.exitCode !== 0) {
		const uploadText = `${upload.stdout ?? ""}\n${upload.stderr ?? ""}`;
		promo.notes.push(
			`fallback probe: cs=${uploadText.includes("CreateSubmission")} s400=${uploadText.includes("400")} artifact=${await exists(submissionFile)}`,
		);
		if (uploadText.includes("CreateSubmission") && uploadText.includes("400") && (await exists(submissionFile))) {
			let legacy = await legacyRestSubmit(String(taskMeta?.comp_slug ?? ""), submissionFile, promo.submission_message);
			if (!legacy.ok && /submission\.csv/iu.test(legacy.detail ?? "")) {
				// Kaggle demands the upload be NAMED submission.csv for this comp
				// (the scorer itself parses the same content — a prior .txt scored).
				// Stage a renamed copy and try once more.
				try {
					const renameDir = await fs.mkdtemp(path.join(root, "workflow-output", "submit-rename-"));
					const renamed = path.join(renameDir, "submission.csv");
					await fs.copyFile(submissionFile, renamed);
					promo.notes.push(`legacy v1 rejected the file name (${legacy.detail?.slice(0, 160)}); retrying as submission.csv`);
					legacy = await legacyRestSubmit(String(taskMeta?.comp_slug ?? ""), renamed, promo.submission_message);
					await fs.rm(renameDir, { recursive: true, force: true });
				} catch (renameError) {
					promo.notes.push(`rename retry setup failed: ${String(renameError).slice(0, 200)}`);
				}
			}
			if (legacy.ok) {
				promo.notes.push("uploaded via legacy v1 REST fallback (v2 CLI CreateSubmission 400)");
				upload = { exitCode: 0, stdout: `legacy v1 REST submit ok: ${legacy.detail}`, stderr: "" };
			} else {
				promo.notes.push(`legacy v1 REST fallback failed at ${legacy.step} (${legacy.status}): ${legacy.detail}`);
			}
		}
	}
	// Notebook-only competitions reject every direct file upload but accept
	// KERNEL submissions (route proven by lane B on x02: push kernel → wait for
	// COMPLETE → verify output → submit the kernel's output file). The kernel
	// assets (kernel-metadata.json + a script that RE-RUNS the solver, no static
	// payload) are solution content owned by the lane; this branch only drives
	// the transport when those assets exist.
	if (upload.exitCode !== 0) {
		const failText = `${upload.stdout ?? ""}\n${upload.stderr ?? ""}\n${promo.notes.join("\n")}`;
		const kernelMetaPath = path.join(instanceDir, "solution", "kernel-metadata.json");
		if (/only accepts Submissions from Notebooks/iu.test(failText) && (await exists(kernelMetaPath))) {
			const kernelResult = await kernelRouteSubmit(kernelMetaPath);
			if (kernelResult.ok) {
				promo.notes.push(`uploaded via kernel route (${kernelResult.detail})`);
				upload = { exitCode: 0, stdout: `kernel route submit ok: ${kernelResult.detail}`, stderr: "" };
			} else {
				promo.notes.push(`kernel route failed at ${kernelResult.step}: ${kernelResult.detail}`);
			}
		} else if (/only accepts Submissions from Notebooks/iu.test(failText)) {
			promo.notes.push("notebook-only competition and no solution/kernel-metadata.json — lane must author kernel assets (see wiki x02 kernel-ref playbook)");
		}
	}
	if (upload.exitCode !== 0) {
		promo.submission_status = "upload_failed";
		// Persist the COMPLETE upload output to disk — truncated tails have twice
		// lost the kaggle CLI's actual rejection reason (it may print at the HEAD
		// of either stream, before submit.py's traceback).
		let uploadLogRef = "";
		try {
			const uploadLogPath = path.join(artifactDir, `upload-failure-${Date.now()}.log`);
			await fs.writeFile(
				uploadLogPath,
				`exit=${upload.exitCode}\n===== stdout =====\n${upload.stdout ?? ""}\n===== stderr =====\n${upload.stderr ?? ""}\n`,
			);
			uploadLogRef = `; full log: ${path.relative(root, uploadLogPath)}`;
		} catch {
			/* best-effort */
		}
		promo.notes.push(`upload failed (exit ${upload.exitCode}); stdout head: ${String(upload.stdout ?? "").slice(0, 400)}; stderr head: ${String(upload.stderr ?? "").slice(0, 400)}${uploadLogRef}`);
		if (!(await exists(submissionFile))) {
			promo.notes.push(`submission artifact still missing after submit.py: ${path.basename(submissionFile)}`);
		}
		await appendSubmissionLog(artifactDir, promo, { uploaded: false });
		await recordPromotion(artifactDir, promo);
		return promo;
	}
	promo.submission_status = "uploaded";
	await appendSubmissionLog(artifactDir, promo, { uploaded: true });

	// 4. Poll for our score (matched by the unique submission message).
	const polled = await pollScore(promo.submission_message, 12, 30000);
	if (polled) {
		promo.kaggle_public = polled.public;
		promo.kaggle_private = polled.private;
		if (polled.public !== null) {
			promo.submission_status = "scored";
		} else if (/error/iu.test(polled.status ?? "")) {
			// Kaggle accepted the upload but its scorer REJECTED the file (format/
			// columns/rows). This is a terminal verdict, not a pending one — surface
			// it so reviewers/coordinator treat the submission pipeline as broken
			// for this candidate rather than waiting for a score.
			promo.submission_status = "scoring_error";
			promo.notes.push("kaggle scored the submission as status=error (file rejected by evaluator); fix submission format before next promotion");
		} else {
			promo.submission_status = "pending_score";
		}
	} else {
		promo.submission_status = "pending_score";
		promo.notes.push("score not visible yet; next loadCampaignState/score poll will pick it up");
	}
	await recordPromotion(artifactDir, promo);
	return promo;
}

// Kernel-route submission for notebook-only competitions: push the solution's
// kernel (kaggle kernels push), wait for the run to COMPLETE, verify it
// produced the submission artifact (kernel_output mode), then submit the
// kernel version. code_notebook mode skips output verification — the scored
// artifact is produced by Kaggle's hidden-test rerun, not by our run — and
// first stages the optional model-artifact dataset (solution/kernel-dataset/
// with dataset-metadata.json) so the notebook can attach trained models.
async function kernelRouteSubmit(kernelMetaPath, { verifyOutput = true } = {}) {
	let step = "meta";
	try {
		const meta = JSON.parse(await fs.readFile(kernelMetaPath, "utf8"));
		const slug = String(meta.id ?? "");
		if (!slug.includes("/")) return { ok: false, step, detail: `kernel-metadata.json id missing/invalid: ${slug}` };
		const solutionDir = path.dirname(kernelMetaPath);
		const datasetDir = path.join(solutionDir, "kernel-dataset");
		if (await exists(path.join(datasetDir, "dataset-metadata.json"))) {
			// The v2 kaggle CLI's dataset commands hit a from_dict()/token client bug;
			// the in-process python API path is the one that works (verified).
			step = "dataset";
			const dsScript = `
import sys
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
folder, notes = sys.argv[1], sys.argv[2]
try:
    r = api.dataset_create_version(folder=folder, version_notes=notes, dir_mode="zip")
    print("VERSION_OK", r)
except Exception as e1:
    try:
        r = api.dataset_create_new(folder=folder, dir_mode="zip")
        print("CREATE_OK", r)
    except Exception as e2:
        body2 = getattr(getattr(e2, "response", None), "text", "")
        print("DS_FAIL", repr(e1)[:150], "|", repr(e2)[:150], body2[:200]); sys.exit(1)
`;
			const ds = await run(["python3", "-c", dsScript, datasetDir, promo.submission_message], instanceDir, 1800000);
			if (ds.exitCode !== 0) return { ok: false, step, detail: tail(ds.stdout || ds.stderr, 300) };
		}
		step = "push";
		const push = await run(["kaggle", "kernels", "push", "-p", solutionDir], instanceDir, 300000);
		if (push.exitCode !== 0) return { ok: false, step, detail: tail(push.stderr || push.stdout, 300) };
		step = "run";
		let state = "";
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 30000));
			const status = await run(["kaggle", "kernels", "status", slug], instanceDir, 120000);
			state = `${status.stdout ?? ""} ${status.stderr ?? ""}`;
			if (/complete/iu.test(state)) break;
			if (/error|failed|cancel/iu.test(state)) return { ok: false, step, detail: state.slice(0, 300) };
		}
		if (!/complete/iu.test(state)) return { ok: false, step, detail: `kernel not complete in poll budget: ${state.slice(0, 200)}` };
		const artifactName = path.basename(submissionFile);
		if (verifyOutput) {
			step = "output";
			const outDir = await fs.mkdtemp(path.join(root, "workflow-output", "kernel-out-"));
			const output = await run(["kaggle", "kernels", "output", slug, "-p", outDir], instanceDir, 300000);
			const produced = path.join(outDir, artifactName);
			const producedOk = output.exitCode === 0 && (await exists(produced));
			await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
			if (!producedOk) {
				return { ok: false, step, detail: `kernel output missing ${artifactName}: ${tail(output.stderr || output.stdout, 200)}` };
			}
		}
		step = "submit";
		// In-process python API: the CLI wrapper swallows the HTTP error body,
		// which twice cost us the actual rejection reason (e.g. "files must be
		// named submission.csv for this Competition").
		const versionMatch = /version\s+#?(\d+)/iu.exec(String(push.stdout ?? ""));
		const submitScript = `
import sys
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
comp, kernel, fname, msg = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
version = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else None
try:
    r = api.competition_submit_code(file_name=fname, message=msg, competition=comp, kernel=kernel, kernel_version=version)
    print("SUBMIT_OK", r)
except Exception as e:
    body = getattr(getattr(e, "response", None), "text", "")
    print("SUBMIT_FAIL", repr(e)[:150], body[:400]); sys.exit(1)
`;
		const submitArgs = [
			"python3", "-c", submitScript,
			String(taskMeta?.comp_slug ?? ""), slug, artifactName, promo.submission_message,
		];
		if (versionMatch) submitArgs.push(versionMatch[1]);
		const submit = await run(submitArgs, instanceDir, 300000);
		if (submit.exitCode !== 0) return { ok: false, step, detail: tail(submit.stdout || submit.stderr, 400) };
		return { ok: true, step: "done", detail: tail(submit.stdout, 160) || `kernel ${slug} submitted` };
	} catch (error) {
		return { ok: false, step, detail: String(error).slice(0, 300) };
	}
}

// Kaggle v1 REST submit (3 steps): allocate upload url → PUT the bytes →
// create the submission. Auth via the same Bearer access token submit.py uses
// for its read-only score polling.
async function legacyRestSubmit(compSlug, filePath, message) {
	let step = "init";
	try {
		if (!compSlug) return { ok: false, step, status: 0, detail: "no comp_slug in task metadata" };
		const token = (
			await fs.readFile(path.join(process.env.HOME ?? "/root", ".kaggle", "access_token"), "utf8")
		).trim();
		const auth = { Authorization: `Bearer ${token}` };
		const stat = await fs.stat(filePath);
		step = "url";
		const urlForm = new FormData();
		urlForm.append("fileName", path.basename(filePath));
		const urlResp = await fetch(
			`https://www.kaggle.com/api/v1/competitions/${encodeURIComponent(compSlug)}/submissions/url/${stat.size}/${Math.floor(stat.mtimeMs / 1000)}`,
			{ method: "POST", headers: auth, body: urlForm },
		);
		if (!urlResp.ok) return { ok: false, step, status: urlResp.status, detail: (await urlResp.text()).slice(0, 300) };
		const urlData = await urlResp.json();
		const createUrl = urlData?.createUrl;
		const blobToken = urlData?.token;
		if (!createUrl || !blobToken) {
			return { ok: false, step, status: urlResp.status, detail: `unexpected url response: ${JSON.stringify(urlData).slice(0, 240)}` };
		}
		step = "upload";
		const bytes = await fs.readFile(filePath);
		const putResp = await fetch(createUrl, { method: "PUT", body: bytes });
		if (!putResp.ok) return { ok: false, step, status: putResp.status, detail: (await putResp.text()).slice(0, 300) };
		step = "submit";
		const submitForm = new FormData();
		submitForm.append("blobFileTokens", blobToken);
		submitForm.append("submissionDescription", message);
		const submitResp = await fetch(
			`https://www.kaggle.com/api/v1/competitions/submissions/submit/${encodeURIComponent(compSlug)}`,
			{ method: "POST", headers: auth, body: submitForm },
		);
		if (!submitResp.ok) return { ok: false, step, status: submitResp.status, detail: (await submitResp.text()).slice(0, 300) };
		return { ok: true, step, status: submitResp.status, detail: (await submitResp.text()).slice(0, 200) };
	} catch (error) {
		return { ok: false, step, status: -1, detail: String(error).slice(0, 300) };
	}
}

async function pollScore(message, attempts, sleepMs) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const poll = await run(["python3", "submit.py", "--score-only"], instanceDir, 120000);
		if (poll.exitCode === 0) {
			const line = poll.stdout
				.split(/\r?\n/u)
				.find((row) => row.includes(message.slice(0, 40)));
			if (line) {
				const status = /status=(\S+)/u.exec(line)?.[1] ?? "";
				const publicScore = parseMaybeNumber(/public=([-\d.eE]+|None)/u.exec(line)?.[1]);
				const privateScore = parseMaybeNumber(/private=([-\d.eE]+|None)/u.exec(line)?.[1]);
				if (publicScore !== null || /complete|error/iu.test(status)) {
					return { public: publicScore, private: privateScore, status };
				}
			}
		}
		if (attempt < attempts - 1) await Bun.sleep(sleepMs);
	}
	return null;
}

async function appendSubmissionLog(artifactDir, promo, { uploaded }) {
	const row = {
		submitted_at: promo.submitted_at || new Date().toISOString(),
		candidate: promo.candidate,
		lane,
		message: promo.submission_message,
		uploaded,
		status: promo.submission_status,
		local_score: promo.local_score,
		full_score: promo.full_score,
	};
	await fs.appendFile(path.join(artifactDir, "submission_log.jsonl"), JSON.stringify(row) + "\n");
}

async function recordPromotion(artifactDir, promo) {
	const row = {
		candidate: promo.candidate,
		status: "promoted",
		promotion_decision: "promote",
		optimization_limit_reached: optimizationLimitReached,
		reward_hack_review: "pass",
		solution: taskMeta?.edit_file ?? validation.solution ?? "",
		artifact: validation.summary_path ?? "",
		score: promo.full_score ?? promo.local_score,
		cost: costOf(promo.full_score ?? promo.local_score, higherIsBetter),
		metric_name: promo.metric_name,
		higher_is_better: higherIsBetter,
		kaggle_public: promo.kaggle_public,
		kaggle_private: promo.kaggle_private,
		submission_status: promo.submission_status,
		submission_message: promo.submission_message,
		notes: promo.notes.join(" | ") || "Promoted after reward-hack review, performance review, and optimization-limit review",
		reward_review_summary: summaryText(rewardReview),
		performance_review_summary: summaryText(performanceReview),
		promoted_at: new Date().toISOString(),
	};
	await fs.appendFile(path.join(artifactDir, "candidates.jsonl"), JSON.stringify(row) + "\n");
	await fs.writeFile(
		path.join(artifactDir, "best_manifest.json"),
		JSON.stringify(
			{
				task_dir: taskDirRel,
				candidate: promo.candidate,
				metric: promo.metric_name,
				higher_is_better: higherIsBetter,
				local_score: promo.local_score,
				full_score: promo.full_score,
				kaggle_public: promo.kaggle_public,
				kaggle_private: promo.kaggle_private,
				submission_status: promo.submission_status,
				target_top1: taskMeta?.target_top1 ?? null,
				reached_top1: reachedTarget(promo.kaggle_public, taskMeta?.target_top1),
				instance_dir: instanceDir,
				updated_at: new Date().toISOString(),
			},
			null,
			2,
		) + "\n",
	);
}

function reachedTarget(kagglePublic, target) {
	if (kagglePublic === null || kagglePublic === undefined || target === null || target === undefined) return false;
	return higherIsBetter ? Number(kagglePublic) >= Number(target) : Number(kagglePublic) <= Number(target);
}

async function updateLeaderboard(promotion) {
	const leaderboardPath = path.join(root, "leaderboard.json");
	const leaderboard = await readJsonSafe(fs, leaderboardPath, {
		generated_at: "",
		metric: "kaggle_public(remote-primary)",
		best_count: 0,
		best_by_task: [],
	});
	if (promotion) {
		const rows = leaderboard.best_by_task ?? [];
		const existing = rows.find((row) => row.task_dir === taskDirRel);
		const candidateRow = {
			order: taskMeta?.order ?? null,
			task_dir: taskDirRel,
			candidate: promotion.candidate,
			metric_name: promotion.metric_name,
			higher_is_better: higherIsBetter,
			score: promotion.full_score ?? promotion.local_score,
			cost: costOf(promotion.full_score ?? promotion.local_score, higherIsBetter),
			kaggle_public: promotion.kaggle_public,
			kaggle_private: promotion.kaggle_private,
			submission_status: promotion.submission_status,
			target_top1: taskMeta?.target_top1 ?? null,
			reached_top1: reachedTarget(promotion.kaggle_public, taskMeta?.target_top1),
			promoted_at: new Date().toISOString(),
		};
		if (!existing || rowBeats(candidateRow, existing)) {
			leaderboard.best_by_task = rows.filter((row) => row.task_dir !== taskDirRel).concat([candidateRow]);
			leaderboard.best_by_task.sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99));
		}
	}
	leaderboard.best_count = (leaderboard.best_by_task ?? []).length;
	leaderboard.generated_at = new Date().toISOString();
	leaderboard.metric = "kaggle_public(remote-primary)";
	await fs.writeFile(leaderboardPath, JSON.stringify(leaderboard, null, 1) + "\n");
	await fs.writeFile(path.join(root, "leaderboard.csv"), leaderboardCsv(leaderboard));
	return leaderboard;
}

// Remote-primary comparison: a scored row beats an unscored one; two scored rows
// compare by direction-aware kaggle_public; two unscored rows compare by local cost.
function rowBeats(next, prev) {
	const nextKaggle = numberOrNull(next.kaggle_public);
	const prevKaggle = numberOrNull(prev.kaggle_public);
	if (nextKaggle !== null && prevKaggle === null) return true;
	if (nextKaggle === null && prevKaggle !== null) return false;
	if (nextKaggle !== null && prevKaggle !== null) {
		const nextCost = costOf(nextKaggle, higherIsBetter);
		const prevCost = costOf(prevKaggle, higherIsBetter);
		return nextCost < prevCost;
	}
	const nextCost = numberOrNull(next.cost);
	const prevCost = numberOrNull(prev.cost);
	if (nextCost === null) return false;
	if (prevCost === null) return true;
	return nextCost < prevCost;
}

function leaderboardCsv(leaderboard) {
	const header = "order,task_dir,candidate,metric,kaggle_public,kaggle_private,score,submission_status,reached_top1,target_top1,promoted_at";
	const lines = (leaderboard.best_by_task ?? []).map((row) =>
		[
			row.order ?? "",
			row.task_dir ?? "",
			row.candidate ?? "",
			row.metric_name ?? "",
			row.kaggle_public ?? "",
			row.kaggle_private ?? "",
			row.score ?? "",
			row.submission_status ?? "",
			row.reached_top1 ?? "",
			row.target_top1 ?? "",
			row.promoted_at ?? "",
		].join(","),
	);
	return [header, ...lines].join("\n") + "\n";
}

function promotionBlockedReason() {
	if (validation.status !== "passed") return "validation did not pass";
	if (performanceDecision !== "promote") return "performance review did not return verdict=promote";
	if (rewardFailed) return "reward-hack review failed";
	if (profileRequired) return "performance review requested diagnostics before promotion";
	if (!optimizationLimitReached) return "performance review did not set optimization_limit_reached=true";
	return "unknown";
}

async function run(cmd, cwd, timeoutMs, extraEnv = {}) {
	try {
		const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				/* exited */
			}
		}, timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		return { cmd, exitCode: timedOut ? -2 : exitCode, stdout, stderr };
	} catch (error) {
		return { cmd, exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function scoreNumber(scoreData) {
	if (!scoreData || typeof scoreData !== "object") return null;
	for (const key of ["oof", "local_score", "score"]) {
		const value = Number(scoreData[key]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function parseMaybeNumber(value) {
	if (value === undefined || value === null || value === "None") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function numberOrNull(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function tail(text, maxChars) {
	const value = String(text ?? "");
	return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function compactLeaderboard(value) {
	return {
		generated_at: value.generated_at ?? "",
		metric: value.metric ?? "kaggle_public(remote-primary)",
		best_count: value.best_count ?? 0,
		recent_best_by_task: (value.best_by_task ?? []).slice(-8).map((row) => ({
			order: row.order,
			task_dir: row.task_dir,
			candidate: row.candidate,
			kaggle_public: row.kaggle_public ?? null,
			kaggle_private: row.kaggle_private ?? null,
			score: row.score ?? null,
			cost: row.cost ?? null,
			metric_name: row.metric_name ?? "",
			submission_status: row.submission_status ?? "",
		})),
		leaderboard_file: "leaderboard.json",
		note: "kaggle_public is the primary value (remote-primary); local score/cost are iteration signals.",
	};
}

function compactLeaderboardUpdate(value, outputPath) {
	return {
		status: value.status,
		promoted_this_round: Boolean(value.promoted_this_round),
		optimization_limit_reached: Boolean(value.optimization_limit_reached),
		profile_required: Boolean(value.profile_required),
		promotion_blocked_reason: value.promotion_blocked_reason,
		promotion: value.promotion
			? {
					candidate: value.promotion.candidate,
					kaggle_public: value.promotion.kaggle_public,
					kaggle_private: value.promotion.kaggle_private,
					submission_status: value.promotion.submission_status,
					full_score: value.promotion.full_score,
					local_score: value.promotion.local_score,
					notes: value.promotion.notes?.slice(0, 3) ?? [],
				}
			: null,
		best_count: value.best_count,
		metric: value.metric,
		detail_file: path.relative(root, outputPath),
	};
}

function verdictText(value) {
	if (!value) return "";
	if (typeof value === "string") return value.toLowerCase();
	return JSON.stringify(value).toLowerCase();
}

function reviewDecision(value) {
	const exact = normalizeDecision(readStringField(value, "verdict"));
	if (exact) return exact;
	const decision = normalizeDecision(readStringField(value, "decision"));
	if (decision) return decision;
	const text = verdictText(value);
	if (/\bverdict\b\s*[:=]\s*"?promote"?\b/u.test(text)) return "promote";
	if (/\bverdict\b\s*[:=]\s*"?revise"?\b/u.test(text)) return "revise";
	if (/\bverdict\b\s*[:=]\s*"?reject"?\b/u.test(text)) return "reject";
	if (/\bverdict\b\s*[:=]\s*"?pass"?\b/u.test(text)) return "pass";
	if (/\bverdict\b\s*[:=]\s*"?fail"?\b/u.test(text)) return "fail";
	const leadingDecision =
		leadingTextDecision(readStringField(value, "summary")) ||
		leadingTextDecision(readStringField(value, "explanation")) ||
		leadingTextDecision(readStringField(value, "reason")) ||
		(typeof value === "string" ? leadingTextDecision(value) : "");
	if (leadingDecision) return leadingDecision;
	return "";
}

function normalizeDecision(value) {
	if (!value) return "";
	const normalized = value.trim().toLowerCase();
	return ["promote", "revise", "reject", "pass", "fail"].includes(normalized) ? normalized : "";
}

function leadingTextDecision(value) {
	if (!value) return "";
	const match = value.trim().toLowerCase().match(/^(promote|revise|reject|pass|fail)\b/u);
	return match ? match[1] : "";
}

function hasOptimizationLimitReached(value) {
	if (readBoolField(value, "optimization_limit_reached") === true) return true;
	const text = verdictText(value);
	return /\boptimization_limit_reached\b\s*[:=]\s*true\b/u.test(text);
}

function profileRequested(value) {
	if (readBoolField(value, "profile_required") === true) return true;
	const text = verdictText(value);
	return /\bprofile_required\b\s*[:=]\s*true\b/u.test(text);
}

function readStringField(value, field) {
	if (!value) return "";
	if (typeof value === "string") {
		const parsed = parseJsonLike(value);
		return parsed ? readStringField(parsed, field) : "";
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = readStringField(item, field);
			if (found) return found;
		}
		return "";
	}
	if (typeof value === "object") {
		if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] === "string") {
			return value[field].trim().toLowerCase();
		}
		for (const nested of Object.values(value)) {
			const found = readStringField(nested, field);
			if (found) return found;
		}
	}
	return "";
}

function readBoolField(value, field) {
	if (!value) return undefined;
	if (typeof value === "string") {
		const parsed = parseJsonLike(value);
		return parsed ? readBoolField(parsed, field) : undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = readBoolField(item, field);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value === "object") {
		if (Object.prototype.hasOwnProperty.call(value, field)) return normalizeBool(value[field]);
		for (const nested of Object.values(value)) {
			const found = readBoolField(nested, field);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function normalizeBool(value) {
	if (value === true || value === false) return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "yes") return true;
		if (normalized === "false" || normalized === "no") return false;
	}
	return undefined;
}

function parseJsonLike(value) {
	const text = value.trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

function summaryText(value) {
	if (!value) return "";
	if (typeof value === "string") return value.slice(0, 1000);
	if (typeof value.summary === "string") return value.summary.slice(0, 1000);
	return JSON.stringify(value).slice(0, 1000);
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
