import { Deal, PnlLine } from "./types";

export interface OrderBookResult {
  wonUnmatchedDeals: Deal[];
  orderBookValue: number;
}

/**
 * RULE-004: order book = won deals with no corresponding invoice yet.
 *
 * Modelling assumption, flagged for confirmation once the upload template exists: matching
 * requires a deal-to-invoice link. MVP's P&L shape (period, invoicedRevenue) has no such link
 * by default, so PnlLine.dealId is optional and matching only fires when the upload template
 * actually captures it. Until it does, every won deal correctly falls through to order book
 * rather than being silently (and wrongly) matched by coincidence of period or amount.
 */
export function computeOrderBook(deals: Deal[], pnlLines: PnlLine[]): OrderBookResult {
  const invoicedDealIds = new Set(
    pnlLines
      .map((line) => line.dealId)
      .filter((dealId): dealId is string => dealId !== null && dealId !== undefined)
  );

  const wonUnmatchedDeals = deals.filter(
    (deal) => deal.status === "won" && !invoicedDealIds.has(deal.id)
  );
  const orderBookValue = wonUnmatchedDeals.reduce((sum, deal) => sum + deal.value, 0);

  return { wonUnmatchedDeals, orderBookValue };
}
