import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import * as reportDataService from "../services/reportData.service.js";

export const getDataSources = asyncHandler(async (req, res) => {
  const data = await reportDataService.listReportDataSources(req.user?._id);
  return ok(res, data, "Report data sources");
});

export const listSalesBills = asyncHandler(async (req, res) => {
  const data = await reportDataService.listSalesBills({ userId: req.user?._id, query: req.query });
  return ok(res, data, "Sales bills fetched");
});

export const getSalesBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.getSalesBill(req.params.id, req.user?._id);
  return ok(res, data, "Bill fetched");
});

export const createSalesBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.createSalesBill({
    data: req.body,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  return created(res, data, "Bill saved");
});

export const updateSalesBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.updateSalesBill({
    id: req.params.id,
    userId: req.user?._id,
    data: req.body,
    userName: req.user?.name,
  });
  return ok(res, data, "Bill updated");
});

export const deleteSalesBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.deleteSalesBill(req.params.id, req.user?._id);
  return ok(res, data, "Bill deleted");
});

export const uploadSalesBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.uploadSalesBillImage({
    userId: req.user?._id,
    userName: req.user?.name,
    file: req.file,
  });
  return ok(res, data, "Bill image uploaded");
});

export const validateSalesImport = asyncHandler(async (req, res) => {
  const data = await reportDataService.validateSalesImport(req.body?.csv, req.user?._id);
  return ok(res, data, "CSV validated");
});

export const importSalesBills = asyncHandler(async (req, res) => {
  const data = await reportDataService.importSalesBills({
    rows: req.body?.rows,
    duplicateMode: req.body?.duplicateMode,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  return created(res, data, "CSV import complete");
});

export const listPurchases = asyncHandler(async (req, res) => {
  const data = await reportDataService.listPurchases({ userId: req.user?._id, query: req.query });
  return ok(res, data, "Purchases fetched");
});

export const getPurchase = asyncHandler(async (req, res) => {
  const data = await reportDataService.getPurchase(req.params.id, req.user?._id);
  return ok(res, data, "Purchase fetched");
});

export const createPurchase = asyncHandler(async (req, res) => {
  const data = await reportDataService.createPurchase({
    data: req.body,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  return created(res, data, "Purchase saved");
});

export const updatePurchase = asyncHandler(async (req, res) => {
  const data = await reportDataService.updatePurchase({
    id: req.params.id,
    userId: req.user?._id,
    data: req.body,
    userName: req.user?.name,
  });
  return ok(res, data, "Purchase updated");
});

export const deletePurchase = asyncHandler(async (req, res) => {
  const data = await reportDataService.deletePurchase(req.params.id, req.user?._id);
  return ok(res, data, "Purchase deleted");
});

export const uploadPurchaseDocument = asyncHandler(async (req, res) => {
  const data = await reportDataService.uploadPurchaseDocument({
    userId: req.user?._id,
    userName: req.user?.name,
    file: req.file,
  });
  return ok(res, data, "Document uploaded");
});

export const validatePurchaseImport = asyncHandler(async (req, res) => {
  const data = await reportDataService.validatePurchaseImport(req.body?.csv, req.user?._id);
  return ok(res, data, "CSV validated");
});

export const importPurchases = asyncHandler(async (req, res) => {
  const data = await reportDataService.importPurchases({
    rows: req.body?.rows,
    duplicateMode: req.body?.duplicateMode,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  return created(res, data, "CSV import complete");
});

export const getSourceData = asyncHandler(async (req, res) => {
  const data = await reportDataService.listSourceData(req.params.source, req.user?._id);
  return ok(res, data, "Report data source records");
});

export const listReportBills = asyncHandler(async (req, res) => {
  const data = await reportDataService.listReportBills({ userId: req.user?._id, query: req.query });
  return ok(res, data, "Bills fetched");
});

export const getReportBillsSummary = asyncHandler(async (req, res) => {
  const data = await reportDataService.getReportBillsSummary(req.user?._id);
  return ok(res, data, "Bills summary");
});

export const getReportBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.getReportBill(req.params.id, req.user?._id);
  return ok(res, data, "Bill fetched");
});

export const createReportBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.createReportBill({
    data: req.body,
    userId: req.user?._id,
    userName: req.user?.name,
    orgName: req.user?.orgName,
  });
  return created(res, data, "Bill saved");
});

export const updateReportBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.updateReportBill({
    id: req.params.id,
    userId: req.user?._id,
    data: req.body,
    userName: req.user?.name,
  });
  return ok(res, data, "Bill updated");
});

export const deleteReportBill = asyncHandler(async (req, res) => {
  const data = await reportDataService.deleteReportBill(req.params.id, req.user?._id);
  return ok(res, data, "Bill deleted");
});

export const sendReportBillWhatsApp = asyncHandler(async (req, res) => {
  const { delivery, bill } = await reportDataService.sendReportBillWhatsApp({
    id: req.params.id,
    userId: req.user?._id,
    orgName: req.user?.orgName,
  });
  const message =
    delivery?.status === "sent"
      ? "Bill sent on WhatsApp"
      : delivery?.status === "failed"
        ? "Bill saved — WhatsApp delivery failed"
        : "Bill saved — WhatsApp delivery skipped";
  return ok(res, { ...bill, whatsapp: delivery }, message);
});

export const retryReportBillWhatsApp = asyncHandler(async (req, res) => {
  const { delivery, bill } = await reportDataService.sendReportBillWhatsApp({
    id: req.params.id,
    userId: req.user?._id,
    orgName: req.user?.orgName,
  });
  const message =
    delivery?.status === "sent"
      ? "Bill delivered on WhatsApp"
      : delivery?.status === "failed"
        ? "WhatsApp delivery failed — try again"
        : "WhatsApp delivery skipped";
  return ok(res, { ...bill, whatsapp: delivery }, message);
});
