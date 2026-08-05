import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import {
  salesReport,
  purchaseReport,
  expiryReport,
  stockValuationReport,
} from "../services/report.service.js";

export const getSalesReport = asyncHandler(async (req, res) => {
  const data = await salesReport({
    from: req.query.from,
    to: req.query.to,
    groupBy: req.query.groupBy ?? "day",
  });
  return ok(res, data, "Sales report");
});

export const getPurchaseReport = asyncHandler(async (req, res) => {
  const data = await purchaseReport({ from: req.query.from, to: req.query.to });
  return ok(res, data, "Purchase report");
});

export const getExpiryReport = asyncHandler(async (req, res) => {
  const data = await expiryReport(parseInt(req.query.days ?? "90", 10) || 90);
  return ok(res, data, "Expiry report");
});

export const getStockValuation = asyncHandler(async (req, res) => {
  const data = await stockValuationReport();
  return ok(res, data, "Stock valuation report");
});
