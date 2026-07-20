import { describe, expect, it } from "bun:test";
import { scoreNumberForMetric } from "./lane-utils.js";

describe("task metric score parsing", () => {
	it("accepts protected holdout keys derived from the task metric", () => {
		expect(scoreNumberForMetric({ holdout_hierarchical_f1: 0.851842, n_holdout_seqs: 1686 }, "hierarchical_f1"))
			.toBe(0.851842);
		expect(scoreNumberForMetric({ holdout_gini_stability: 0.488009, n_holdout: 2683 }, "gini_stability"))
			.toBe(0.488009);
	});

	it("preserves generic score formats used by existing tasks", () => {
		expect(scoreNumberForMetric({ oof: 0.8089, metric: "roc_auc" }, "roc_auc")).toBe(0.8089);
		expect(scoreNumberForMetric({ local_score: 440820, metric: "hashcode_slideshow_interest" }, "hashcode_slideshow_interest"))
			.toBe(440820);
		expect(scoreNumberForMetric({ score: 1176447, metric: "santa_2023_move_score" }, "santa_2023_move_score"))
			.toBe(1176447);
	});

	it("prefers the task-specific metric over generic compatibility keys", () => {
		expect(scoreNumberForMetric({ holdout_gini_stability: 0.49, score: 999 }, "gini_stability")).toBe(0.49);
	});

	it("does not treat unrelated numeric metadata as a score", () => {
		expect(scoreNumberForMetric({ n_holdout: 2683, train_seconds: 700 }, "hierarchical_f1")).toBeNull();
		expect(scoreNumberForMetric(null, "gini_stability")).toBeNull();
	});
});
