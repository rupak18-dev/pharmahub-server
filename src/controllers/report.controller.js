import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import * as reportService from "../services/report.service.js";

export const getReportCatalog = asyncHandler(async (_req, res) => {
  const data = await reportService.getReportCatalog();
  return ok(res, data, "Report catalog");
});

export const getSalesReport = asyncHandler(async (req, res) => {
  const data = await reportService.salesReport(
    {
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.groupBy ?? "day",
    },
    req.user?._id,
  );
  return ok(res, data, "Sales report");
});

export const getPurchaseReport = asyncHandler(async (req, res) => {
  const data = await reportService.purchaseReport(
    { from: req.query.from, to: req.query.to },
    req.user?._id,
  );
  return ok(res, data, "Purchase report");
});

export const getExpiryReport = asyncHandler(async (req, res) => {
  const data = await reportService.expiryReport(parseInt(req.query.days ?? "90", 10) || 90);
  return ok(res, data, "Expiry report");
});

export const getStockValuation = asyncHandler(async (req, res) => {
  const data = await reportService.stockValuationReport();
  return ok(res, data, "Stock valuation report");
});

export const generateCustomReport = asyncHandler(async (req, res) => {
  const data = await reportService.customReport(req.body, req.user?._id);
  return ok(res, data, "Custom report generated");
});

export const getSavedReports = asyncHandler(async (req, res) => {
  const data = await reportService.getSavedReports(req.user?._id);
  return ok(res, data, "Saved reports fetched");
});

export const createSavedReport = asyncHandler(async (req, res) => {
  const data = await reportService.createSavedReport(req.body, req.user?._id);
  return created(res, data, "Saved report created");
});

export const updateSavedReport = asyncHandler(async (req, res) => {
  const data = await reportService.updateSavedReport(req.params.id, req.user?._id, req.body);
  return ok(res, data, "Saved report updated");
});

export const deleteSavedReport = asyncHandler(async (req, res) => {
  await reportService.deleteSavedReport(req.params.id, req.user?._id);
  return ok(res, null, "Saved report deleted");
});

export const getScheduledReports = asyncHandler(async (req, res) => {
  const data = await reportService.getScheduledReports(req.user?._id);
  return ok(res, data, "Scheduled reports fetched");
});

export const createScheduledReport = asyncHandler(async (req, res) => {
  const data = await reportService.createScheduledReport(req.body, req.user?._id);
  return created(res, data, "Scheduled report created");
});

export const updateScheduledReport = asyncHandler(async (req, res) => {
  const data = await reportService.updateScheduledReport(req.params.id, req.user?._id, req.body);
  return ok(res, data, "Scheduled report updated");
});

export const deleteScheduledReport = asyncHandler(async (req, res) => {
  await reportService.deleteScheduledReport(req.params.id, req.user?._id);
  return ok(res, null, "Scheduled report deleted");
});
