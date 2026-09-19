import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeCalcEngineResult } from "@/calc-engine";
import type { CalcEngineInput, Deal, Period, PnlLine, QualificationTier } from "@/calc-engine";

const VALID_PERIODS: Period[] = ["month", "quarter", "year"];

/**
 * GET /api/verdict?period=month|quarter|year&periodStart=YYYY-MM-DD
 *
 * The calc engine is never called from a component — this route is the only place
 * doc 03's RULE-001–011 get evaluated. It runs under the caller's own session (RLS
 * scopes every query to their business), never the service-role key (doc 05).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const period = searchParams.get("period") as Period | null;
  const periodStart = searchParams.get("periodStart");

  if (!period || !VALID_PERIODS.includes(period) || !periodStart) {
    return NextResponse.json(
      { error: "period (month|quarter|year) and periodStart (YYYY-MM-DD) are required" },
      { status: 400 }
    );
  }

  // RLS scopes this to the caller's own business — there is no cross-tenant path here
  // even before a multi-business UI exists (doc 05: never trust a client-supplied ID).
  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id")
    .single();

  if (businessError || !business) {
    return NextResponse.json({ error: "no business found for this user" }, { status: 404 });
  }

  const [dealsRes, pnlLinesRes, baselineRes, targetsRes, latestUploadRes] = await Promise.all([
    supabase.from("deals").select("*").eq("business_id", business.id),
    supabase.from("pnl_lines").select("*").eq("business_id", business.id),
    supabase.from("commercial_baseline").select("*").eq("business_id", business.id).maybeSingle(),
    supabase.from("targets").select("*").eq("business_id", business.id).maybeSingle(),
    supabase
      .from("uploads")
      .select("uploaded_at")
      .eq("business_id", business.id)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (dealsRes.error || pnlLinesRes.error) {
    return NextResponse.json({ error: "failed to load dataset" }, { status: 500 });
  }

  const deals: Deal[] = (dealsRes.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    value: Number(row.value),
    stage: row.stage,
    stageEntryDate: row.stage_entry_date,
    expectedCloseDate: row.expected_close_date,
    status: row.status,
    qualificationTier: row.qualification_tier as QualificationTier | null,
    closeDate: row.close_date,
  }));

  const pnlLines: PnlLine[] = (pnlLinesRes.data ?? []).map((row) => ({
    period: row.period,
    invoicedRevenue: Number(row.invoiced_revenue),
    dealId: row.deal_id,
  }));

  const input: CalcEngineInput = {
    deals,
    pnlLines,
    baseline: {
      salesCycleDays: baselineRes.data?.sales_cycle_days ?? null,
      staleOpportunityThresholdDays: baselineRes.data?.stale_opportunity_threshold_days ?? null,
      revenueTargetAnnual: targetsRes.data?.revenue_target_annual ?? null,
      marginTargetPercent: targetsRes.data?.margin_target_percent ?? null,
      minimumAcceptableMarginPercent: targetsRes.data?.minimum_acceptable_margin_percent ?? null,
    },
    period,
    periodStart,
    now: new Date().toISOString(),
    lastUploadedAt: latestUploadRes.data?.uploaded_at ?? null,
  };

  const result = computeCalcEngineResult(input);

  return NextResponse.json(result);
}
