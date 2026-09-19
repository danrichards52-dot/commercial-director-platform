import { describe, expect, it } from "vitest";
import { computeCalcEngineResult } from "../index";
import {
  buildInput,
  fixtureIds,
  syntheticBaselineNoTarget,
} from "./fixtures/syntheticFixture";

describe("RULE-009 historical confidence bands", () => {
  it("assigns none/early/developing/established by qualifying closed-deal count", () => {
    const result = computeCalcEngineResult(buildInput());
    const byId = new Map(result.staleDeals.map((f) => [f.deal.id, f]));

    const viaHistory = byId.get(fixtureIds.staleDealViaHistory)!;
    expect(viaHistory.historicalObservation?.confidence).toBe("early_indication");
    expect(viaHistory.historicalObservation?.averageDwellDays).toBe(18);
    expect(viaHistory.historicalObservation?.qualifyingRecordCount).toBe(2);

    const viaThreshold = byId.get(fixtureIds.staleDealViaThreshold)!;
    expect(viaThreshold.historicalObservation).toBeNull();
  });
});

describe("REQ-006 stale-deal flagging", () => {
  it("flags a deal against its stage's historical average when one exists", () => {
    const result = computeCalcEngineResult(buildInput());
    const flag = result.staleDeals.find((f) => f.deal.id === fixtureIds.staleDealViaHistory)!;

    expect(flag.comparator.type).toBe("historical_average");
    expect(flag.comparator.days).toBe(18);
    expect(flag.daysInCurrentStage).toBe(52);
    expect(flag.isStale).toBe(true);
  });

  it("falls back to the RULE-010 benchmark threshold when no stage history exists", () => {
    const result = computeCalcEngineResult(buildInput());
    const flag = result.staleDeals.find((f) => f.deal.id === fixtureIds.staleDealViaThreshold)!;

    expect(flag.comparator.type).toBe("stale_threshold_benchmark");
    expect(flag.comparator.days).toBe(20); // 50% of the 40-day sales-cycle benchmark
    expect(flag.daysInCurrentStage).toBe(25);
    expect(flag.isStale).toBe(true);
  });
});

describe("RULE-010 stale-opportunity threshold fallback chain", () => {
  it("derives 50% of the sales-cycle benchmark when no explicit threshold is set", () => {
    const result = computeCalcEngineResult(buildInput());
    expect(result.resolvedBenchmarks.staleOpportunityThresholdDays).toEqual({
      value: 20,
      source: "derived",
    });
  });

  it("falls back to the 15-day platform default when neither threshold nor sales-cycle is set", () => {
    const result = computeCalcEngineResult(
      buildInput({
        baseline: {
          salesCycleDays: null,
          staleOpportunityThresholdDays: null,
          revenueTargetAnnual: 300000,
          marginTargetPercent: null,
          minimumAcceptableMarginPercent: null,
        },
      })
    );
    expect(result.resolvedBenchmarks.staleOpportunityThresholdDays).toEqual({
      value: 15,
      source: "derived",
    });
  });
});

describe("RULE-003 qualification tiers", () => {
  it("only Likely/Highly likely deals contribute to the trajectory, at full value", () => {
    const result = computeCalcEngineResult(buildInput());
    // staleDealViaHistory (12,000, likely) + likelyDeal (15,000) + highlyLikelyDeal (25,000) = 52,000;
    // too-early/unlikely contribute £0.
    expect(result.verdict.qualifiedPipelineValue).toBe(52000);
  });
});

describe("RULE-008 pipeline coverage", () => {
  it("reports raw and qualified coverage as distinct figures", () => {
    const result = computeCalcEngineResult(buildInput());
    const coverage = result.verdict.coverage!;

    // Raw = all open deals: 12000 + 8000 + 3000 + 4000 + 15000 + 25000 = 67000
    expect(coverage.rawPipelineValue).toBe(67000);
    // Qualified = likely + highly likely only: 12000 + 15000 + 25000 = 52000
    expect(coverage.qualifiedPipelineValue).toBe(52000);
    expect(coverage.rawPipelineValue).not.toBe(coverage.qualifiedPipelineValue);
  });
});

describe("RULE-004 order book", () => {
  it("counts a won deal with no matching invoice as order book", () => {
    const result = computeCalcEngineResult(buildInput());
    expect(result.verdict.orderBookValue).toBe(18000);
  });

  it("excludes a won deal once a matching invoice exists", () => {
    const result = computeCalcEngineResult(buildInput());
    // wonMatchedDeal (£9,000) is invoiced via dealId — must not also appear in order book.
    expect(result.verdict.orderBookValue).not.toBe(18000 + 9000);
  });
});

describe("RULE-001 commercial benchmarks", () => {
  it("shows an explicit 'no target set' state rather than a fabricated figure", () => {
    const result = computeCalcEngineResult(
      buildInput({ baseline: syntheticBaselineNoTarget })
    );
    expect(result.verdict.target).toBeNull();
    expect(result.verdict.gap).toBeNull();
    expect(result.verdict.direction).toBeNull();
  });

  it("uses the configured sales-cycle benchmark over the platform default", () => {
    const result = computeCalcEngineResult(buildInput());
    expect(result.resolvedBenchmarks.salesCycleDays).toEqual({ value: 40, source: "configured" });
  });

  it("falls back to the 30-day platform default when unset", () => {
    const result = computeCalcEngineResult(
      buildInput({
        baseline: { ...syntheticBaselineNoTarget, salesCycleDays: null, revenueTargetAnnual: 300000 },
      })
    );
    expect(result.resolvedBenchmarks.salesCycleDays).toEqual({
      value: 30,
      source: "platform_default",
    });
  });
});

describe("RULE-002 derived targets", () => {
  it("does not mark the annual target itself as derived", () => {
    const result = computeCalcEngineResult(buildInput({ period: "year" }));
    expect(result.verdict.target?.derived).toBe(false);
    expect(result.verdict.target?.value).toBe(300000);
  });

  it("marks a monthly target derived from the annual figure as derived", () => {
    const result = computeCalcEngineResult(
      buildInput({ period: "month", periodStart: "2026-01-01" })
    );
    expect(result.verdict.target?.derived).toBe(true);
    expect(result.verdict.target?.value).toBeCloseTo(300000 / 12);
  });
});

describe("REQ-003/004 verdict direction and gap", () => {
  it("computes gap as target minus (invoiced + order book + qualified pipeline)", () => {
    const result = computeCalcEngineResult(buildInput({ period: "year" }));
    // invoiced 51000 + order book 18000 + qualified pipeline 52000 = 121000
    expect(result.verdict.actualTotal).toBe(121000);
    expect(result.verdict.gap).toBe(300000 - 121000);
    expect(result.verdict.direction).toBe("behind");
  });
});

describe("REQ-007 trajectory", () => {
  it("produces 12 monthly cumulative points with a target pace line", () => {
    const result = computeCalcEngineResult(buildInput());
    expect(result.trajectory.points).toHaveLength(12);
    expect(result.trajectory.points[11]!.cumulativeTargetPace).toBeCloseTo(300000);
  });
});

describe("determinism (doc 04)", () => {
  it("produces identical output for identical input, independent of the system clock", () => {
    const input = buildInput();
    const first = computeCalcEngineResult(input);
    const second = computeCalcEngineResult(input);
    expect(first).toEqual(second);
  });
});
