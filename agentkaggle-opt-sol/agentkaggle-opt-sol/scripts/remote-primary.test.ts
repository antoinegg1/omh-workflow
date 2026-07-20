import { describe, expect, test } from "bun:test";
import { costOf, finiteNumberOrNull, metricNumber, remotePrimaryBeats, scoreNumberForMetric } from "./lane-utils.js";

describe("remote-primary comparison", () => {
	test("does not coerce absent Kaggle scores to zero", () => {
		expect(finiteNumberOrNull(null)).toBeNull();
		expect(finiteNumberOrNull("")).toBeNull();
		expect(finiteNumberOrNull("0")).toBe(0);
		expect(costOf(null, false)).toBeNull();
		expect(metricNumber({ cost: null }, "cost")).toBeNull();
		expect(scoreNumberForMetric({ score: null }, "auc")).toBeNull();
	});

	test("always prefers a scored row over an unscored row", () => {
		expect(remotePrimaryBeats({ kaggle_public: 1.5, cost: 100 }, { kaggle_public: null, cost: 0.1 }, false)).toBe(true);
		expect(remotePrimaryBeats({ kaggle_public: null, cost: 0.1 }, { kaggle_public: 1.5, cost: 100 }, false)).toBe(false);
	});

	test("compares remote scores in the task direction", () => {
		expect(remotePrimaryBeats({ kaggle_public: 0.9 }, { kaggle_public: 0.8 }, true)).toBe(true);
		expect(remotePrimaryBeats({ kaggle_public: 0.8 }, { kaggle_public: 0.9 }, false)).toBe(true);
	});

	test("falls back to direction-normalized local cost", () => {
		expect(remotePrimaryBeats({ kaggle_public: null, cost: 0.2 }, { kaggle_public: null, cost: 0.3 }, true)).toBe(true);
		expect(remotePrimaryBeats({ kaggle_public: null, cost: 0.4 }, { kaggle_public: null, cost: 0.3 }, false)).toBe(false);
	});
});
