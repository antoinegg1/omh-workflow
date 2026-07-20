import crypto from "node:crypto";

export async function hashFile(fs, file) {
	const hash = crypto.createHash("sha256");
	hash.update(await fs.readFile(file));
	return hash.digest("hex");
}

export async function hashSolutionTree(fs, path, dir) {
	const hash = crypto.createHash("sha256");
	for (const rel of await listTree(fs, path, dir)) {
		if (rel === "local_score.json") continue;
		hash.update(rel);
		hash.update("\0");
		hash.update(await fs.readFile(path.join(dir, rel)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function hashSubmissionPayload(fs, path, solutionDir, submission = {}) {
	const mode = submission.mode ?? "file";
	const artifact = submission.artifact ?? "submission.csv";
	if (mode === "file") {
		const file = path.join(solutionDir, artifact);
		return (await exists(fs, file)) ? hashFile(fs, file) : "";
	}
	const payloadFiles = ["kernel-metadata.json", "notebook_submission.ipynb", "dataset-metadata.json"];
	const hash = crypto.createHash("sha256");
	let found = false;
	for (const rel of payloadFiles) {
		const file = path.join(solutionDir, rel);
		if (!(await exists(fs, file))) continue;
		found = true;
		hash.update(rel);
		hash.update("\0");
		hash.update(await fs.readFile(file));
		hash.update("\0");
	}
	const datasetDir = path.join(solutionDir, "kernel-dataset");
	if (await exists(fs, datasetDir)) {
		found = true;
		for (const rel of await listTree(fs, path, datasetDir)) {
			hash.update(`kernel-dataset/${rel}`);
			hash.update("\0");
			hash.update(await fs.readFile(path.join(datasetDir, rel)));
			hash.update("\0");
		}
	}
	return found ? hash.digest("hex") : "";
}

async function listTree(fs, path, dir, prefix = "") {
	const out = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? path.join(prefix, entry.name) : entry.name;
		if (entry.isDirectory()) out.push(...(await listTree(fs, path, path.join(dir, entry.name), rel)));
		else if (entry.isFile()) out.push(rel);
	}
	return out.sort();
}

async function exists(fs, file) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

