const PROGRESSIVE_GOAL_START = "<!-- progressive-goal:start -->";
const PROGRESSIVE_GOAL_END = "<!-- progressive-goal:end -->";

export function normalizedProtectedFileContent(relPath, data) {
	if (!/^x[0-9]{2}-[^/]+\/TASK\.md$/u.test(relPath)) return data;
	const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
	const start = text.indexOf(PROGRESSIVE_GOAL_START);
	const end = text.indexOf(PROGRESSIVE_GOAL_END);
	if (start < 0 || end <= start) return data;
	return Buffer.from(
		`${text.slice(0, start)}${PROGRESSIVE_GOAL_START}\n<workflow-managed-current-goal>\n${PROGRESSIVE_GOAL_END}${text.slice(end + PROGRESSIVE_GOAL_END.length)}`,
	);
}
