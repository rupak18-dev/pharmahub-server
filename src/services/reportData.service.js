import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Sale } from "../models/Sale.js";
import { Purchase, PURCHASE_DOCUMENT_TYPES, PURCHASE_SOURCES } from "../models/Purchase.js";
import { Medicine } from "../models/Medicine.js";
import { Batch } from "../models/Batch.js";
import { Supplier } from "../models/Supplier.js";
import { AuditLog } from "../models/AuditLog.js";
import {
  ReportBill,
  REPORT_BILL_DOCUMENT_TYPES,
  REPORT_BILL_SALES_TYPES,
  REPORT_BILL_PURCHASE_TYPES,
} from "../models/ReportBill.js";
import { extractBillFromImage } from "./billExtraction.service.js";
import {
  deliverBillToWhatsApp,
  formatWhatsAppDelivery,
  isSalesBill,
  sendReportBillWhatsApp as whatsAppSendReportBill,
} from "./whatsapp.service.js";
import { parseCsv } from "../utils/csv.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { normalizeIndianPhone } from "../utils/phone.js";

/* ---------------------------------------------------------------------
   Report Data — Sales & Bills
   ---------------------------------------------------------------------
   Bills live in the Sale collection (the POS and the report engine already
   share it). Report Data adds the fields the workflow needs — payment
   status, source, notes, uploaded file — and manages the records that were
   not created through the POS. Everything is scoped to the owning user.
   --------------------------------------------------------------------- */

export const PAYMENT_MODES = ["Cash", "UPI", "Card", "Bank Transfer", "Credit", "Other"];
export const PAYMENT_STATUSES = ["paid", "pending", "partial"];
export const BILL_SOURCES = ["manual", "uploaded", "imported", "existing"];

// Manual send / retry for a persisted bill (implementation lives in the
// WhatsApp service; re-exported here so the controller uses one facade and the
// response keeps the unified bill shape the rest of the API uses).
export const sendReportBillWhatsApp = async (args) => {
  const result = await whatsAppSendReportBill(args);
  return {
    delivery: result.delivery,
    bill: unifiedFromReportBill(result.bill, { includeExtraction: true }),
  };
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const MAX_OCR_TEXT_LENGTH = 40000;
const cleanStr = (v, max) =>
  v === undefined || v === null
    ? ""
    : String(v)
        .trim()
        .slice(0, max ?? 200);
const cleanNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

// Whitelists and caps the OCR extraction payload before it is persisted. It is
// metadata only — totals are recomputed server-side and never read from here.
function sanitizeExtraction(ext) {
  if (!ext || typeof ext !== "object") return null;
  const raw = String(ext.rawOcrText ?? "");
  const cleaned = {
    source: ext.source === "manual" ? "manual" : "uploaded",
    status: ext.status === "manual" ? "manual" : "extracted",
    extractedAt: ext.extractedAt ? new Date(ext.extractedAt) : new Date(),
  };
  if (ext.documentType) cleaned.documentType = cleanStr(ext.documentType, 40);
  const conf = cleanNum(ext.confidence);
  if (conf !== null) cleaned.confidence = Math.max(0, Math.min(100, conf));
  if (Array.isArray(ext.warnings)) {
    cleaned.warnings = ext.warnings
      .map((w) => cleanStr(w, 300))
      .filter(Boolean)
      .slice(0, 10);
  }
  if (raw) cleaned.rawOcrText = raw.slice(0, MAX_OCR_TEXT_LENGTH);

  const fields = ext.fields && typeof ext.fields === "object" ? ext.fields : {};
  const out = {};
  for (const k of [
    "invoiceNumber",
    "invoiceDate",
    "subtotal",
    "discount",
    "taxableAmount",
    "totalSGST",
    "totalCGST",
    "gstTotal",
    "printedGrandTotal",
  ]) {
    const v = fields[k];
    if (v === undefined || v === null || v === "") continue;
    const n = cleanNum(v);
    out[k] = n !== null ? n : cleanStr(v, 200);
  }
  if (fields.supplier && typeof fields.supplier === "object") {
    out.supplier = {
      name: cleanStr(fields.supplier.name, 200),
      gstin: cleanStr(fields.supplier.gstin, 30),
      address: cleanStr(fields.supplier.address, 400),
      phone: cleanStr(fields.supplier.phone, 60),
      phones: Array.isArray(fields.supplier.phones)
        ? fields.supplier.phones
            .map((p) => cleanStr(p, 60))
            .filter(Boolean)
            .slice(0, 10)
        : undefined,
    };
    if (!out.supplier.phones || out.supplier.phones.length === 0) delete out.supplier.phones;
  }
  if (fields.party && typeof fields.party === "object") {
    out.party = {
      name: cleanStr(fields.party.name, 200),
      gstin: cleanStr(fields.party.gstin, 30),
      phone: cleanStr(fields.party.phone, 60),
    };
    if (!out.party.phone) delete out.party.phone;
  }
  if (fields.customerPhone) out.customerPhone = cleanStr(fields.customerPhone, 60);
  if (Array.isArray(fields.phoneCandidates)) {
    out.phoneCandidates = fields.phoneCandidates
      .slice(0, 20)
      .map((c) => {
        if (!c || typeof c !== "object") return null;
        const o = {
          number: cleanStr(c.number, 60),
          normalizedNumber: cleanStr(c.normalizedNumber, 60),
          confidence: cleanNum(c.confidence),
          source: cleanStr(c.source, 20),
          context: cleanStr(c.context, 60),
          role: ["supplier", "customer", "unknown"].includes(c.role) ? c.role : undefined,
        };
        return o.number || o.normalizedNumber ? o : null;
      })
      .filter(Boolean);
    if (out.phoneCandidates.length === 0) delete out.phoneCandidates;
  }
  if (Array.isArray(fields.items)) {
    out.items = fields.items.slice(0, 200).map((it) => {
      if (!it || typeof it !== "object") return {};
      const o = {};
      for (const [k, v] of Object.entries(it)) {
        if (v === undefined || v === null) continue;
        if (typeof v === "number") o[k] = Number.isFinite(v) ? v : 0;
        else if (typeof v === "string") o[k] = v.slice(0, 200);
        else if (typeof v === "boolean") o[k] = v;
      }
      return o;
    });
  }
  cleaned.fields = out;
  return cleaned;
}

function parseBillDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw ApiError.badRequest("Invalid bill date");
  }
  return d;
}

// Recomputes every total on the server. Frontend numbers are never trusted.
function normalizeBillItems(items) {
  let subtotal = 0;
  let discountTotal = 0;
  let gstTotal = 0;
  const normalized = (Array.isArray(items) ? items : []).map((line) => {
    const quantity = Number(line?.quantity) || 0;
    const unitPrice = Number(line?.unitPrice) || 0;
    const discountPct = Math.min(100, Math.max(0, Number(line?.discountPct) || 0));
    const gstRate = Math.min(100, Math.max(0, Number(line?.gstRate) || 0));

    const gross = quantity * unitPrice;
    const discount = (gross * discountPct) / 100;
    const taxable = gross - discount;
    const gst = (taxable * gstRate) / 100;

    subtotal += gross;
    discountTotal += discount;
    gstTotal += gst;

    return {
      medicineId:
        line?.medicineId && mongoose.isValidObjectId(line.medicineId) ? line.medicineId : null,
      batchId: line?.batchId && mongoose.isValidObjectId(line.batchId) ? line.batchId : null,
      medicineName: String(line?.medicineName ?? "").trim(),
      batchNumber: String(line?.batchNumber ?? "").trim(),
      quantity,
      unitPrice,
      discountPct,
      gstRate,
      taxableAmount: round2(taxable),
      gstAmount: round2(gst),
      lineTotal: round2(taxable + gst),
    };
  });

  const rawGrand = subtotal - discountTotal + gstTotal;
  const grandTotal = round2(rawGrand);
  return {
    items: normalized,
    subtotal: round2(subtotal),
    discountTotal: round2(discountTotal),
    taxableAmount: round2(subtotal - discountTotal),
    gstTotal: round2(gstTotal),
    // Nearest-rupee adjustment (informational): e.g. 100.80 -> 0.20.
    roundOff: round2(Math.round(rawGrand) - rawGrand),
    grandTotal,
  };
}

function validateBillInput(data = {}) {
  const errors = [];
  if (!data.invoiceNo || typeof data.invoiceNo !== "string" || !data.invoiceNo.trim()) {
    errors.push("Bill number is required");
  }
  if (data.billDate !== undefined && data.billDate !== null && data.billDate !== "") {
    try {
      parseBillDate(data.billDate);
    } catch {
      errors.push("Invalid bill date");
    }
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    errors.push("At least one item is required");
  } else {
    data.items.forEach((it, idx) => {
      const label = `Item ${idx + 1}`;
      const qty = Number(it?.quantity);
      if (!Number.isFinite(qty) || qty <= 0)
        errors.push(`${label}: quantity must be greater than 0`);
      const price = Number(it?.unitPrice);
      if (!Number.isFinite(price) || price < 0) errors.push(`${label}: invalid unit price`);
      const gst = Number(it?.gstRate) || 0;
      if (gst < 0 || gst > 100) errors.push(`${label}: invalid GST rate`);
      const disc = Number(it?.discountPct) || 0;
      if (disc < 0 || disc > 100) errors.push(`${label}: invalid discount`);
      if (!it?.medicineName || !String(it.medicineName).trim()) {
        errors.push(`${label}: medicine name is required`);
      }
    });
  }
  if (
    data.paymentMode !== undefined &&
    data.paymentMode !== "" &&
    !PAYMENT_MODES.includes(String(data.paymentMode).trim())
  ) {
    errors.push(`Invalid payment mode. Use one of: ${PAYMENT_MODES.join(", ")}`);
  }
  if (
    data.paymentStatus !== undefined &&
    data.paymentStatus !== "" &&
    !PAYMENT_STATUSES.includes(String(data.paymentStatus).trim().toLowerCase())
  ) {
    errors.push("Invalid payment status. Use paid, pending or partial");
  }
  if (errors.length) throw ApiError.badRequest(errors.join("; "));
}

// Duplicate protection is ownership-aware and date-scoped: the same bill
// number is fine for a different pharmacy (or a different date). Matches on
// createdBy + invoiceNo (case-insensitive) + the bill's calendar day.
async function assertNoDuplicateInvoice(
  userId,
  invoiceNo,
  billDate = new Date(),
  excludeId = null,
) {
  const day = new Date(billDate);
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  const existing = await Sale.findOne({
    createdBy: userId,
    invoiceNo: {
      $regex: new RegExp(`^${String(invoiceNo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    },
    createdAt: { $gte: start, $lte: end },
  })
    .select("_id invoiceNo")
    .lean();
  if (existing && (!excludeId || String(existing._id) !== String(excludeId))) {
    throw ApiError.conflict(`Duplicate bill — ${existing.invoiceNo} already exists for this date.`);
  }
}

export function formatSalesBill(s, { includeExtraction = false } = {}) {
  return {
    id: s._id,
    invoiceNo: s.invoiceNo,
    billDate: s.createdAt,
    customerName: s.customerName || "",
    customerPhone: s.customerPhone || "",
    items: (s.items || []).map((i) => ({
      medicineId: i.medicineId ?? null,
      batchId: i.batchId ?? null,
      medicineName: i.medicineName || "",
      batchNumber: i.batchNumber || "",
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discountPct: i.discountPct ?? 0,
      gstRate: i.gstRate ?? 0,
      taxableAmount: i.taxableAmount ?? 0,
      gstAmount: i.gstAmount ?? 0,
      lineTotal: i.lineTotal ?? 0,
    })),
    itemCount: (s.items || []).length,
    itemNames: [...new Set((s.items || []).map((i) => i.medicineName).filter(Boolean))],
    subtotal: s.subtotal ?? 0,
    discountTotal: s.discountTotal ?? 0,
    taxableAmount: s.taxableAmount ?? 0,
    gstTotal: s.gstTotal ?? 0,
    roundOff: s.roundOff ?? 0,
    grandTotal: s.grandTotal ?? 0,
    paymentMode: s.paymentMode || "Cash",
    paymentStatus: s.paymentStatus ?? "paid",
    status: s.status ?? "completed",
    source: s.source ?? "existing",
    uploadedFile: s.uploadedFile ?? null,
    staff: s.createdByName || "Staff",
    notes: s.notes || "",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(includeExtraction ? { extraction: s.extraction ?? null } : {}),
  };
}

/* ---------------------------------------------------------------------
   Report Data overview
   --------------------------------------------------------------------- */

const DATA_SOURCES = [
  {
    key: "sales",
    name: "Sales & Bills",
    description: "Bill records that feed Sales, GST and Payments reports.",
  },
  { key: "purchases", name: "Purchases", description: "Supplier orders and procurement records." },
  { key: "inventory", name: "Inventory", description: "Stock on hand by batch with valuation." },
  {
    key: "medicines",
    name: "Medicines",
    description: "Medicine catalog, HSN codes and GST slabs.",
  },
  { key: "customers", name: "Customers", description: "Customers and their purchase history." },
  {
    key: "suppliers",
    name: "Suppliers",
    description: "Suppliers / distributors with purchase totals.",
  },
  { key: "payments", name: "Payments", description: "Payments collected per bill and mode." },
  { key: "expiry", name: "Expiry", description: "Batches expiring soon or already expired." },
  { key: "gst", name: "GST / Tax", description: "Taxable value and GST collected per bill." },
  { key: "audit", name: "Audit", description: "User activity and stock movement trail." },
];

export async function listReportDataSources(userId) {
  const latestOf = async (model) => {
    const doc = await model.findOne().sort({ createdAt: -1 }).select("createdAt").lean();
    return doc?.createdAt ?? null;
  };
  const salesLatest = await latestOf(Sale);

  const [
    salesCount,
    purchasesCount,
    purchasesLatest,
    medicinesCount,
    batchesCount,
    batchesLatest,
    suppliersCount,
    auditCount,
    auditLatest,
    customerNames,
    paymentsLatest,
    gstLatest,
  ] = await Promise.all([
    Sale.countDocuments({ createdBy: userId, status: "completed" }),
    Purchase.countDocuments({ createdBy: userId }),
    latestOf(Purchase),
    Medicine.countDocuments({}),
    Batch.countDocuments({}),
    latestOf(Batch),
    Supplier.countDocuments({}),
    AuditLog.countDocuments({}),
    latestOf(AuditLog),
    Sale.distinct("customerName", { createdBy: userId, customerName: { $exists: true, $ne: "" } }),
    latestOf(Sale),
    latestOf(Sale),
  ]);

  const expiryCount = await Batch.countDocuments({ status: { $in: ["expired", "near_expiry"] } });
  const gstCount = await Sale.countDocuments({
    createdBy: userId,
    gstTotal: { $gt: 0 },
    status: "completed",
  });
  const paymentsCount = await Sale.countDocuments({ createdBy: userId, status: "completed" });

  const counts = {
    sales: { count: salesCount, lastUpdated: salesLatest },
    purchases: { count: purchasesCount, lastUpdated: purchasesLatest },
    inventory: { count: batchesCount, lastUpdated: batchesLatest },
    medicines: { count: medicinesCount, lastUpdated: batchesLatest },
    customers: { count: customerNames.length, lastUpdated: paymentsLatest },
    suppliers: { count: suppliersCount, lastUpdated: purchasesLatest },
    payments: { count: paymentsCount, lastUpdated: paymentsLatest },
    expiry: { count: expiryCount, lastUpdated: batchesLatest },
    gst: { count: gstCount, lastUpdated: gstLatest },
    audit: { count: auditCount, lastUpdated: auditLatest },
  };

  return DATA_SOURCES.map((s) => ({
    key: s.key,
    name: s.name,
    description: s.description,
    count: counts[s.key]?.count ?? 0,
    lastUpdated: counts[s.key]?.lastUpdated ?? null,
  }));
}

/* ---------------------------------------------------------------------
   Sales & Bills CRUD
   --------------------------------------------------------------------- */

export async function listSalesBills({ userId, query = {} }) {
  const { search, dateFrom, dateTo, paymentMode, paymentStatus, customer, sort = "newest" } = query;
  const { page, limit, skip } = buildPagination(query);

  const filter = { createdBy: userId, status: "completed" };
  if (search && String(search).trim()) {
    const q = String(search).trim();
    filter.$or = [
      { invoiceNo: { $regex: q, $options: "i" } },
      { customerName: { $regex: q, $options: "i" } },
      { customerPhone: { $regex: q, $options: "i" } },
      { "items.medicineName": { $regex: q, $options: "i" } },
      { "items.batchNumber": { $regex: q, $options: "i" } },
    ];
  }
  if (dateFrom || dateTo) {
    const from = parseBillDate(dateFrom);
    const to = parseBillDate(dateTo);
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from.setHours(0, 0, 0, 0));
    if (to) filter.createdAt.$lte = new Date(to.setHours(23, 59, 59, 999));
  }
  if (paymentMode) filter.paymentMode = String(paymentMode).trim();
  if (paymentStatus) filter.paymentStatus = String(paymentStatus).trim().toLowerCase();
  if (customer && String(customer).trim()) {
    filter.customerName = { $regex: String(customer).trim(), $options: "i" };
  }

  const sortMap = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    highest: { grandTotal: -1 },
    lowest: { grandTotal: 1 },
  };

  const [docs, total] = await Promise.all([
    Sale.find(filter)
      .sort(sortMap[sort] ?? sortMap.newest)
      .skip(skip)
      .limit(limit)
      .lean(),
    Sale.countDocuments(filter),
  ]);

  return {
    items: docs.map(formatSalesBill),
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 0,
      hasMore: page * limit < total,
    },
  };
}

export async function getSalesBill(id, userId) {
  const doc = await Sale.findOne({ _id: id, createdBy: userId }).lean();
  if (!doc) throw ApiError.notFound("Bill not found");
  return formatSalesBill(doc, { includeExtraction: true });
}

export async function createSalesBill({ data = {}, userId, userName }) {
  validateBillInput(data);
  const invoiceNo = String(data.invoiceNo).trim();
  const billDate = parseBillDate(data.billDate) ?? new Date();
  await assertNoDuplicateInvoice(userId, invoiceNo, billDate);

  const totals = normalizeBillItems(data.items);

  const doc = await Sale.create({
    invoiceNo,
    customerName: String(data.customerName ?? "").trim(),
    customerPhone: String(data.customerPhone ?? "").trim(),
    items: totals.items,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxableAmount: totals.taxableAmount,
    gstTotal: totals.gstTotal,
    roundOff: totals.roundOff,
    grandTotal: totals.grandTotal,
    paymentMode: String(data.paymentMode ?? "Cash").trim(),
    paymentStatus: String(data.paymentStatus ?? "paid")
      .trim()
      .toLowerCase(),
    source: BILL_SOURCES.includes(data.source) ? data.source : "manual",
    uploadedFile: data.uploadedFile ?? null,
    notes: String(data.notes ?? "").trim(),
    status: "completed",
    createdBy: userId,
    createdByName: userName || "Staff",
    createdAt: billDate,
    extraction: sanitizeExtraction(data.extraction),
  });

  return formatSalesBill(doc.toObject());
}

export async function updateSalesBill({ id, userId, data = {}, userName }) {
  const existing = await Sale.findOne({ _id: id, createdBy: userId }).lean();
  if (!existing) throw ApiError.notFound("Bill not found");

  const patch = {};
  if (data.invoiceNo !== undefined) {
    validateBillInput({ ...existing, ...data, items: data.items ?? existing.items });
    const invoiceNo = String(data.invoiceNo).trim();
    if (String(existing.invoiceNo).toLowerCase() !== invoiceNo.toLowerCase()) {
      const checkDate = data.billDate ? parseBillDate(data.billDate) : existing.createdAt;
      await assertNoDuplicateInvoice(userId, invoiceNo, checkDate, id);
    }
    patch.invoiceNo = invoiceNo;
  }

  if (data.items !== undefined) {
    validateBillInput({ ...existing, ...data });
    const totals = normalizeBillItems(data.items);
    patch.items = totals.items;
    patch.subtotal = totals.subtotal;
    patch.discountTotal = totals.discountTotal;
    patch.taxableAmount = totals.taxableAmount;
    patch.gstTotal = totals.gstTotal;
    patch.roundOff = totals.roundOff;
    patch.grandTotal = totals.grandTotal;
  }

  if (data.billDate !== undefined && data.billDate !== null && data.billDate !== "") {
    patch.createdAt = parseBillDate(data.billDate);
  }
  if (data.customerName !== undefined) patch.customerName = String(data.customerName).trim();
  if (data.customerPhone !== undefined) patch.customerPhone = String(data.customerPhone).trim();
  if (data.paymentMode !== undefined) patch.paymentMode = String(data.paymentMode).trim();
  if (data.paymentStatus !== undefined) {
    patch.paymentStatus = String(data.paymentStatus).trim().toLowerCase();
  }
  if (data.notes !== undefined) patch.notes = String(data.notes).trim();
  if (data.uploadedFile !== undefined) patch.uploadedFile = data.uploadedFile ?? null;
  if (data.extraction !== undefined) patch.extraction = sanitizeExtraction(data.extraction);
  if (userName) patch.createdByName = userName;

  const doc = await Sale.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
  return formatSalesBill(doc);
}

export async function deleteSalesBill(id, userId) {
  const doc = await Sale.findOneAndDelete({ _id: id, createdBy: userId });
  if (!doc) throw ApiError.notFound("Bill not found");
  return formatSalesBill(doc);
}

/* ---------------------------------------------------------------------
   Report Data — Purchases (documents + orders)
   ---------------------------------------------------------------------
   Mirrors the Sales & Bills flow. Uploaded invoices are stored as Purchase
   records (the POS and the report engine already share the collection);
   supplierId stays optional and the supplier name is snapshotted so reports
   work even when no Supplier record exists. Server-side totals are recomputed
   on every write; a printed grand total, when provided, is kept as the
   authoritative value (reports should reflect what the supplier billed) while
   the calculated total is preserved alongside for mismatch resolution.
   --------------------------------------------------------------------- */

// Accepts "MM/YY", "MM/YYYY" or a date string; returns a Date at the end of
// the expiry month (a batch is expiring through its expiry month).
function parseExpiry(value) {
  if (value === null || value === undefined || value === "") return null;
  const v = String(value).trim();
  const short = v.match(/^(\d{1,2})\/(\d{2,4})$/);
  if (short) {
    let year = Number(short[2]);
    if (year < 100) year += year >= 50 ? 1900 : 2000;
    const month = Number(short[1]);
    if (month < 1 || month > 12) return null;
    return new Date(year, month, 0, 23, 59, 59);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parsePurchaseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw ApiError.badRequest("Invalid purchase date");
  }
  return d;
}

// Recomputes every total on the server. SGST/CGST are taken verbatim when the
// invoice splits them; otherwise a combined gstRate is split equally.
function normalizePurchaseItems(items) {
  let subtotal = 0;
  let discountTotal = 0;
  let sgstTotal = 0;
  let cgstTotal = 0;
  const normalized = (Array.isArray(items) ? items : []).map((line) => {
    const quantity = Number(line?.quantity) || 0;
    const freeQuantity = Number(line?.freeQuantity) || 0;
    const rate = Number(line?.unitCost ?? line?.rate) || 0;
    const mrp = Number(line?.mrp) || 0;
    const discountPct = Math.min(100, Math.max(0, Number(line?.discountPct) || 0));
    const gstRate = Math.min(100, Math.max(0, Number(line?.gstRate) || 0));
    const sgstRate = Math.min(100, Math.max(0, Number(line?.sgstRate) || 0));
    const cgstRate = Math.min(100, Math.max(0, Number(line?.cgstRate) || 0));

    const gross = quantity * rate;
    const discount = (gross * discountPct) / 100;
    const taxable = gross - discount;
    const explicitSplit = sgstRate > 0 || cgstRate > 0;
    const effSgst = explicitSplit ? sgstRate : gstRate / 2;
    const effCgst = explicitSplit ? cgstRate : gstRate / 2;
    const sgst = (taxable * effSgst) / 100;
    const cgst = (taxable * effCgst) / 100;

    subtotal += gross;
    discountTotal += discount;
    sgstTotal += sgst;
    cgstTotal += cgst;

    return {
      medicineId:
        line?.medicineId && mongoose.isValidObjectId(line.medicineId) ? line.medicineId : null,
      batchId: line?.batchId && mongoose.isValidObjectId(line.batchId) ? line.batchId : null,
      medicineName: String(line?.medicineName ?? "").trim(),
      quantity,
      freeQuantity,
      unitCost: rate,
      mrp,
      discountPct,
      discountAmount: round2(discount),
      gstRate: explicitSplit ? 0 : gstRate,
      sgstRate: effSgst,
      cgstRate: effCgst,
      sgstAmount: round2(sgst),
      cgstAmount: round2(cgst),
      gstAmount: round2(sgst + cgst),
      taxableAmount: round2(taxable),
      lineTotal: round2(taxable + sgst + cgst),
      hsnCode: String(line?.hsnCode ?? "").trim(),
      pack: String(line?.pack ?? "").trim(),
      batchNumber: String(line?.batchNumber ?? "").trim(),
      expiryDate: parseExpiry(line?.expiryDate ?? line?.batchExpiry),
      manufacturer: String(line?.manufacturer ?? "").trim(),
    };
  });

  const taxableAmount = subtotal - discountTotal;
  const gstTotal = sgstTotal + cgstTotal;
  const calculatedGrandTotal = taxableAmount + gstTotal;
  return {
    items: normalized,
    subtotal: round2(subtotal),
    discount: round2(discountTotal),
    taxableAmount: round2(taxableAmount),
    totalSGST: round2(sgstTotal),
    totalCGST: round2(cgstTotal),
    gstTotal: round2(gstTotal),
    calculatedGrandTotal: round2(calculatedGrandTotal),
    roundOff: round2(Math.round(calculatedGrandTotal) - calculatedGrandTotal),
  };
}

function validatePurchaseInput(data = {}) {
  const errors = [];
  const invoiceNo = data.invoiceNo ?? data.orderNo;
  if (!invoiceNo || typeof invoiceNo !== "string" || !invoiceNo.trim()) {
    errors.push("Invoice number is required");
  }
  if (data.purchaseDate !== undefined && data.purchaseDate !== null && data.purchaseDate !== "") {
    const d = new Date(data.purchaseDate);
    if (Number.isNaN(d.getTime())) errors.push("Invalid purchase date");
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    errors.push("At least one item is required");
  } else {
    data.items.forEach((it, idx) => {
      const label = `Item ${idx + 1}`;
      const qty = Number(it?.quantity);
      if (!Number.isFinite(qty) || qty <= 0)
        errors.push(`${label}: quantity must be greater than 0`);
      const rate = Number(it?.unitCost ?? it?.rate);
      if (!Number.isFinite(rate) || rate < 0) errors.push(`${label}: invalid rate`);
      const mrp = Number(it?.mrp) || 0;
      if (mrp < 0) errors.push(`${label}: invalid MRP`);
      const gst = Number(it?.gstRate) || 0;
      if (gst < 0 || gst > 100) errors.push(`${label}: invalid GST rate`);
      const sgst = Number(it?.sgstRate) || 0;
      const cgst = Number(it?.cgstRate) || 0;
      if (sgst < 0 || sgst > 100 || cgst < 0 || cgst > 100) {
        errors.push(`${label}: invalid SGST/CGST rate`);
      }
      const disc = Number(it?.discountPct) || 0;
      if (disc < 0 || disc > 100) errors.push(`${label}: invalid discount`);
      if (!it?.medicineName || !String(it.medicineName).trim()) {
        errors.push(`${label}: product name is required`);
      }
    });
  }
  const printed = Number(data.printedGrandTotal);
  if (
    data.printedGrandTotal !== undefined &&
    data.printedGrandTotal !== null &&
    data.printedGrandTotal !== "" &&
    (!Number.isFinite(printed) || printed < 0)
  ) {
    errors.push("Invalid printed grand total");
  }
  if (
    data.documentType !== undefined &&
    data.documentType !== "" &&
    !PURCHASE_DOCUMENT_TYPES.includes(String(data.documentType).trim())
  ) {
    errors.push("Invalid document type");
  }
  if (errors.length) throw ApiError.badRequest(errors.join("; "));
}

async function assertNoDuplicatePurchase(
  userId,
  orderNo,
  purchaseDate = new Date(),
  excludeId = null,
) {
  const day = new Date(purchaseDate);
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  const existing = await Purchase.findOne({
    createdBy: userId,
    orderNo: {
      $regex: new RegExp(`^${String(orderNo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    },
    createdAt: { $gte: start, $lte: end },
  })
    .select("_id orderNo")
    .lean();
  if (existing && (!excludeId || String(existing._id) !== String(excludeId))) {
    throw ApiError.conflict(
      `Duplicate purchase — ${existing.orderNo} already exists for this date.`,
    );
  }
}

function buildPurchaseDoc(data) {
  const orderNo = String(data.invoiceNo ?? data.orderNo).trim();
  const totals = normalizePurchaseItems(data.items);
  const printed =
    data.printedGrandTotal !== undefined &&
    data.printedGrandTotal !== null &&
    data.printedGrandTotal !== ""
      ? Number(data.printedGrandTotal)
      : null;
  return {
    orderNo,
    supplierId:
      data.supplierId && mongoose.isValidObjectId(data.supplierId) ? data.supplierId : null,
    supplierName: String(data.supplierName ?? "").trim(),
    party: {
      name: String(data.party?.name ?? "").trim(),
      gstin: String(data.party?.gstin ?? "").trim(),
    },
    items: totals.items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    taxableAmount: totals.taxableAmount,
    totalSGST: totals.totalSGST,
    totalCGST: totals.totalCGST,
    gstTotal: totals.gstTotal,
    printedGrandTotal: printed,
    calculatedGrandTotal: totals.calculatedGrandTotal,
    roundOff: totals.roundOff,
    grandTotal: printed !== null ? round2(printed) : totals.calculatedGrandTotal,
    documentType: PURCHASE_DOCUMENT_TYPES.includes(String(data.documentType ?? "").trim())
      ? String(data.documentType).trim()
      : "purchase_invoice",
    source: PURCHASE_SOURCES.includes(data.source) ? data.source : "manual",
    originalDocument: data.originalDocument ?? data.uploadedFile ?? null,
    notes: String(data.notes ?? "").trim(),
  };
}

export function formatPurchase(p, { includeExtraction = false } = {}) {
  return {
    id: p._id,
    invoiceNo: p.orderNo,
    orderNo: p.orderNo,
    purchaseDate: p.createdAt,
    supplierId: p.supplierId ?? null,
    supplierName: p.supplierName || "",
    supplier: p.supplierId?.name || p.supplierName || "",
    supplierGstin: p.supplierId?.gstNumber || p.party?.gstin || "",
    party: p.party ?? { name: "", gstin: "" },
    items: (p.items || []).map((i) => ({
      medicineId: i.medicineId ?? null,
      batchId: i.batchId ?? null,
      medicineName: i.medicineName || "",
      quantity: i.quantity ?? 0,
      freeQuantity: i.freeQuantity ?? 0,
      unitCost: i.unitCost ?? 0,
      mrp: i.mrp ?? 0,
      discountPct: i.discountPct ?? 0,
      discountAmount: i.discountAmount ?? 0,
      gstRate: i.gstRate ?? 0,
      sgstRate: i.sgstRate ?? 0,
      cgstRate: i.cgstRate ?? 0,
      sgstAmount: i.sgstAmount ?? 0,
      cgstAmount: i.cgstAmount ?? 0,
      gstAmount: i.gstAmount ?? 0,
      taxableAmount: i.taxableAmount ?? 0,
      lineTotal: i.lineTotal ?? 0,
      hsnCode: i.hsnCode || "",
      pack: i.pack || "",
      batchNumber: i.batchNumber || "",
      expiryDate: i.expiryDate ?? null,
      manufacturer: i.manufacturer || "",
    })),
    itemCount: (p.items || []).length,
    itemNames: [...new Set((p.items || []).map((i) => i.medicineName).filter(Boolean))],
    subtotal: p.subtotal ?? 0,
    discount: p.discount ?? 0,
    taxableAmount: p.taxableAmount ?? 0,
    gstTotal: p.gstTotal ?? 0,
    totalSGST: p.totalSGST ?? 0,
    totalCGST: p.totalCGST ?? 0,
    grandTotal: p.grandTotal ?? 0,
    printedGrandTotal: p.printedGrandTotal ?? null,
    calculatedGrandTotal: p.calculatedGrandTotal ?? null,
    roundOff: p.roundOff ?? 0,
    status: p.status ?? "received",
    documentType: p.documentType ?? "purchase_invoice",
    source: p.source ?? "existing",
    originalDocument: p.originalDocument ?? null,
    notes: p.notes || "",
    staff: p.createdByName || "Staff",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(includeExtraction ? { extraction: p.extraction ?? null } : {}),
  };
}

export async function listPurchases({ userId, query = {} }) {
  const { search, dateFrom, dateTo, supplier, sort = "newest" } = query;
  const { page, limit, skip } = buildPagination(query);

  const filter = { createdBy: userId };
  if (search && String(search).trim()) {
    const q = String(search).trim();
    filter.$or = [
      { orderNo: { $regex: q, $options: "i" } },
      { supplierName: { $regex: q, $options: "i" } },
      { "items.medicineName": { $regex: q, $options: "i" } },
      { "items.batchNumber": { $regex: q, $options: "i" } },
    ];
  }
  if (supplier && String(supplier).trim()) {
    const q = String(supplier).trim();
    filter.$or = [...(filter.$or || []), { supplierName: { $regex: q, $options: "i" } }];
  }
  if (dateFrom || dateTo) {
    const from = parsePurchaseDate(dateFrom);
    const to = parsePurchaseDate(dateTo);
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from.setHours(0, 0, 0, 0));
    if (to) filter.createdAt.$lte = new Date(to.setHours(23, 59, 59, 999));
  }

  const sortMap = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    highest: { grandTotal: -1 },
    lowest: { grandTotal: 1 },
  };

  const [docs, total] = await Promise.all([
    Purchase.find(filter)
      .populate("supplierId", "name gstNumber")
      .sort(sortMap[sort] ?? sortMap.newest)
      .skip(skip)
      .limit(limit)
      .lean(),
    Purchase.countDocuments(filter),
  ]);

  return {
    items: docs.map(formatPurchase),
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 0,
      hasMore: page * limit < total,
    },
  };
}

export async function getPurchase(id, userId) {
  const doc = await Purchase.findOne({ _id: id, createdBy: userId })
    .populate("supplierId", "name gstNumber")
    .lean();
  if (!doc) throw ApiError.notFound("Purchase not found");
  return formatPurchase(doc, { includeExtraction: true });
}

export async function createPurchase({ data = {}, userId, userName }) {
  validatePurchaseInput(data);
  const orderNo = String(data.invoiceNo ?? data.orderNo).trim();
  const purchaseDate = parsePurchaseDate(data.purchaseDate) ?? new Date();
  await assertNoDuplicatePurchase(userId, orderNo, purchaseDate);

  const doc = await Purchase.create({
    ...buildPurchaseDoc(data),
    extraction: sanitizeExtraction(data.extraction),
    status: "received",
    createdBy: userId,
    createdByName: userName || "Staff",
    createdAt: purchaseDate,
  });

  return formatPurchase(doc.toObject());
}

export async function updatePurchase({ id, userId, data = {}, userName }) {
  const existing = await Purchase.findOne({ _id: id, createdBy: userId }).lean();
  if (!existing) throw ApiError.notFound("Purchase not found");

  const patch = {};
  if (
    data.invoiceNo !== undefined ||
    data.orderNo !== undefined ||
    data.items !== undefined ||
    data.purchaseDate !== undefined
  ) {
    const merged = {
      ...existing,
      ...data,
      invoiceNo: data.invoiceNo ?? data.orderNo ?? existing.orderNo,
      items: data.items ?? existing.items,
    };
    validatePurchaseInput(merged);
    const newNo = String(merged.invoiceNo ?? merged.orderNo).trim();
    if (String(existing.orderNo).toLowerCase() !== newNo.toLowerCase()) {
      const checkDate = data.purchaseDate
        ? parsePurchaseDate(data.purchaseDate)
        : existing.createdAt;
      await assertNoDuplicatePurchase(userId, newNo, checkDate, id);
    }
    patch.orderNo = newNo;
    patch.createdAt = parsePurchaseDate(data.purchaseDate) ?? existing.createdAt;

    if (data.items !== undefined || data.printedGrandTotal !== undefined) {
      const docPatch = buildPurchaseDoc({
        ...data,
        invoiceNo: newNo,
        items: data.items ?? existing.items,
      });
      Object.assign(patch, docPatch);
    }
  }

  if (data.supplierName !== undefined) patch.supplierName = String(data.supplierName).trim();
  if (data.supplierId !== undefined) {
    patch.supplierId =
      data.supplierId && mongoose.isValidObjectId(data.supplierId) ? data.supplierId : null;
  }
  if (data.party !== undefined) {
    patch.party = {
      name: String(data.party?.name ?? "").trim(),
      gstin: String(data.party?.gstin ?? "").trim(),
    };
  }
  if (data.documentType !== undefined) {
    patch.documentType = PURCHASE_DOCUMENT_TYPES.includes(String(data.documentType).trim())
      ? String(data.documentType).trim()
      : "purchase_invoice";
  }
  if (data.notes !== undefined) patch.notes = String(data.notes).trim();
  if (data.originalDocument !== undefined) patch.originalDocument = data.originalDocument ?? null;
  if (data.extraction !== undefined) patch.extraction = sanitizeExtraction(data.extraction);
  if (userName) patch.createdByName = userName;

  const doc = await Purchase.findByIdAndUpdate(id, { $set: patch }, { new: true })
    .populate("supplierId", "name gstNumber")
    .lean();
  return formatPurchase(doc);
}

export async function deletePurchase(id, userId) {
  const doc = await Purchase.findOneAndDelete({ _id: id, createdBy: userId });
  if (!doc) throw ApiError.notFound("Purchase not found");
  return formatPurchase(doc);
}

export async function uploadPurchaseDocument({ userId, userName, file }) {
  if (!file) throw ApiError.badRequest("No file uploaded");

  const safeFile = {
    filename: file.filename ?? null,
    path: file.path ? `/uploads/bills/${file.filename}` : null,
    mimeType: file.mimetype ?? null,
    size: file.size ?? 0,
  };
  const extraction = await extractBillFromImage(file);
  return {
    file: safeFile,
    extraction,
    source: "uploaded",
    staff: userName || "Staff",
    createdBy: userId,
  };
}

/* ---------------------------------------------------------------------
   Bill image upload (OCR abstraction)
   --------------------------------------------------------------------- */

// Stores the uploaded bill image and returns the extraction result. The OCR
// engine runs on the server (tesseract, see billExtraction.service.js); when it
// cannot read the document the flow degrades to a manual review form.
export async function uploadSalesBillImage({ userId, userName, file }) {
  if (!file) throw ApiError.badRequest("No file uploaded");

  const safeFile = {
    filename: file.filename ?? null,
    path: file.path ? `/uploads/bills/${file.filename}` : null,
    mimeType: file.mimetype ?? null,
    size: file.size ?? 0,
  };
  const extraction = await extractBillFromImage(file);
  return {
    file: safeFile,
    extraction,
    source: "uploaded",
    staff: userName || "Staff",
    createdBy: userId,
  };
}

/* ---------------------------------------------------------------------
   CSV import
   --------------------------------------------------------------------- */

const COLUMN_ALIASES = {
  invoiceNo: [
    "invoiceNo",
    "bill number",
    "invoice no",
    "invoice number",
    "invoice",
    "billno",
    "bill no",
  ],
  billDate: ["billDate", "date", "bill date", "invoice date"],
  customerName: ["customerName", "customer", "customer name", "name"],
  customerPhone: ["customerPhone", "phone", "customer phone", "mobile"],
  medicineName: ["medicineName", "medicine", "medicine name", "item", "product", "drug"],
  batchNumber: ["batchNumber", "batch", "batch number", "batch no", "batch #"],
  quantity: ["quantity", "qty", "units"],
  unitPrice: ["unitPrice", "unit price", "price", "rate", "amount per unit"],
  gstRate: ["gstRate", "gst", "gst %", "gst rate", "tax", "tax %"],
  discountPct: ["discountPct", "discount", "discount %"],
  paymentMode: ["paymentMode", "payment mode", "payment method", "mode", "paid via"],
  paymentStatus: ["paymentStatus", "payment status", "status", "paid status"],
  notes: ["notes", "remark", "remarks"],
};

function mapCsvRow(row) {
  const mapped = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const match = aliases.find((a) => row[a] !== undefined && row[a] !== "");
    if (match) mapped[key] = String(row[match]).trim();
  }
  return mapped;
}

function normalizePaymentMode(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const hit = PAYMENT_MODES.find((m) => m.toLowerCase() === v);
  if (hit) return hit;
  if (["upi", "gpay", "google pay", "phonepe"].includes(v)) return "UPI";
  if (v.includes("card")) return "Card";
  if (v.includes("bank") || v.includes("transfer") || v.includes("neft") || v.includes("imps"))
    return "Bank Transfer";
  if (v.includes("credit")) return "Credit";
  if (v.includes("cash")) return "Cash";
  return null;
}

function validateCsvRow(row, index) {
  const errors = [];
  const data = mapCsvRow(row);

  const parsedDate = new Date(data.billDate);
  const dateValid = data.billDate && !Number.isNaN(parsedDate.getTime());

  if (!data.invoiceNo) errors.push("Missing Bill Number");
  if (!data.billDate) {
    errors.push("Missing Date");
  } else if (!dateValid) {
    errors.push("Invalid date");
  }
  if (!data.medicineName) errors.push("Missing Medicine");
  const qty = Number(data.quantity);
  if (data.quantity !== undefined && data.quantity !== "" && (!Number.isFinite(qty) || qty <= 0)) {
    errors.push("Quantity must be greater than 0");
  }
  const price = Number(data.unitPrice);
  if (
    data.unitPrice !== undefined &&
    data.unitPrice !== "" &&
    (!Number.isFinite(price) || price < 0)
  ) {
    errors.push("Invalid amount");
  }
  const gst = Number(data.gstRate);
  if (
    data.gstRate !== undefined &&
    data.gstRate !== "" &&
    (!Number.isFinite(gst) || gst < 0 || gst > 100)
  ) {
    errors.push("Invalid GST");
  }
  const disc = Number(data.discountPct);
  if (
    data.discountPct !== undefined &&
    data.discountPct !== "" &&
    (!Number.isFinite(disc) || disc < 0 || disc > 100)
  ) {
    errors.push("Invalid discount");
  }
  if (data.paymentMode) {
    const mode = normalizePaymentMode(data.paymentMode);
    if (!mode) errors.push(`Invalid payment mode "${data.paymentMode}"`);
  }
  if (data.paymentStatus && !PAYMENT_STATUSES.includes(data.paymentStatus.toLowerCase())) {
    errors.push(`Invalid payment status "${data.paymentStatus}"`);
  }

  return {
    row: index + 2,
    data: {
      invoiceNo: data.invoiceNo || "",
      billDate: dateValid ? parsedDate.toISOString() : data.billDate || "",
      customerName: data.customerName || "",
      customerPhone: data.customerPhone || "",
      medicineName: data.medicineName || "",
      batchNumber: data.batchNumber || "",
      quantity: qty > 0 ? qty : data.quantity || 0,
      unitPrice: Number.isFinite(price) && price >= 0 ? price : data.unitPrice || 0,
      discountPct: Number.isFinite(disc) && disc >= 0 ? disc : 0,
      gstRate: Number.isFinite(gst) && gst >= 0 ? gst : 0,
      paymentMode: data.paymentMode ? normalizePaymentMode(data.paymentMode) : "Cash",
      paymentStatus: data.paymentStatus ? data.paymentStatus.toLowerCase() : "paid",
      notes: data.notes || "",
    },
    errors,
    valid: errors.length === 0,
  };
}

export async function validateSalesImport(csv, _userId) {
  const records = parseCsv(csv);
  if (records.length === 0) {
    throw ApiError.badRequest("No rows found in the uploaded CSV");
  }

  const results = records.map((r, i) => validateCsvRow(r, i));
  const validRows = results.filter((r) => r.valid);

  // Duplicate detection: exact bill-number+date inside the file, and against
  // the database — scoped to this user's own bills (invoice numbers are not
  // globally unique; each pharmacy owns its numbering).
  const seen = new Map();
  const duplicates = [];
  const existing = await Sale.find({
    createdBy: _userId,
    invoiceNo: { $in: validRows.map((r) => r.data.invoiceNo).filter(Boolean) },
  })
    .select("invoiceNo")
    .lean();
  const existingByNo = new Map(
    existing.map((e) => [String(e.invoiceNo).toLowerCase(), e.invoiceNo]),
  );

  for (const r of results) {
    if (!r.valid) continue;
    const key = `${r.data.invoiceNo.toLowerCase()}@${r.data.billDate.slice(0, 10)}`;
    if (seen.has(key)) {
      duplicates.push({ row: r.row, invoiceNo: r.data.invoiceNo, reason: "duplicate within file" });
    } else {
      seen.set(key, r.row);
    }
    const dbMatch = existingByNo.get(r.data.invoiceNo.toLowerCase());
    if (dbMatch) {
      duplicates.push({ row: r.row, invoiceNo: dbMatch, reason: "bill already exists" });
    }
  }

  return {
    totalRows: results.length,
    headers: records.length ? Object.keys(records[0]) : [],
    preview: results.map((r) => ({
      row: r.row,
      data: r.data,
      errors: r.errors,
      valid: r.valid,
    })),
    duplicates,
    validCount: results.filter((r) => r.valid).length,
    errorCount: results.filter((r) => !r.valid).length,
  };
}

export async function importSalesBills({ rows, duplicateMode = "skip", userId, userName }) {
  const mode = ["skip", "replace", "cancel"].includes(duplicateMode) ? duplicateMode : "skip";
  // The frontend posts the validation preview rows, whose fields live under
  // `data`; plain mapped rows are accepted as well.
  const validated = (Array.isArray(rows) ? rows : []).map((r, i) => {
    const row = r && typeof r === "object" && r.data ? r.data : r;
    return validateCsvRow(row, i + 1);
  });

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  if (mode === "cancel" && validated.some((r) => r.valid)) {
    const existing = await Sale.find({
      createdBy: userId,
      invoiceNo: { $in: validated.filter((r) => r.valid).map((r) => r.data.invoiceNo) },
    })
      .select("invoiceNo")
      .lean();
    if (existing.length > 0) {
      throw ApiError.conflict(
        "Duplicate bills detected — import cancelled. Choose Skip or Replace and try again.",
      );
    }
  }

  for (const r of validated) {
    if (!r.valid) continue;
    const totals = normalizeBillItems([
      {
        medicineName: r.data.medicineName,
        batchNumber: r.data.batchNumber,
        quantity: Number(r.data.quantity) || 0,
        unitPrice: Number(r.data.unitPrice) || 0,
        discountPct: Number(r.data.discountPct) || 0,
        gstRate: Number(r.data.gstRate) || 0,
      },
    ]);
    const billDate = new Date(r.data.billDate);

    const existingDoc = await Sale.findOne({ createdBy: userId, invoiceNo: r.data.invoiceNo })
      .select("_id createdBy")
      .lean();
    if (existingDoc) {
      if (mode === "replace") {
        await Sale.updateOne(
          { _id: existingDoc._id },
          {
            $set: {
              customerName: r.data.customerName,
              customerPhone: r.data.customerPhone,
              items: totals.items,
              subtotal: totals.subtotal,
              discountTotal: totals.discountTotal,
              taxableAmount: totals.taxableAmount,
              gstTotal: totals.gstTotal,
              roundOff: totals.roundOff,
              grandTotal: totals.grandTotal,
              paymentMode: r.data.paymentMode || "Cash",
              paymentStatus: r.data.paymentStatus || "paid",
              source: "imported",
              notes: r.data.notes || "",
              createdAt: billDate,
              createdByName: userName || "Staff",
            },
          },
        );
        replaced += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    await Sale.create({
      invoiceNo: r.data.invoiceNo,
      customerName: r.data.customerName,
      customerPhone: r.data.customerPhone,
      items: totals.items,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxableAmount: totals.taxableAmount,
      gstTotal: totals.gstTotal,
      roundOff: totals.roundOff,
      grandTotal: totals.grandTotal,
      paymentMode: r.data.paymentMode || "Cash",
      paymentStatus: r.data.paymentStatus || "paid",
      source: "imported",
      notes: r.data.notes || "",
      status: "completed",
      createdBy: userId,
      createdByName: userName || "Staff",
      createdAt: billDate,
    });
    inserted += 1;
  }

  return { inserted, replaced, skipped, total: inserted + replaced + skipped };
}

/* ---------------------------------------------------------------------
   CSV import — Purchases
   --------------------------------------------------------------------- */

const PURCHASE_COLUMN_ALIASES = {
  invoiceNo: [
    "invoiceNo",
    "orderNo",
    "invoice",
    "invoice no",
    "invoice number",
    "order no",
    "order number",
    "bill number",
    "bill no",
    "po number",
  ],
  purchaseDate: [
    "purchaseDate",
    "date",
    "purchase date",
    "invoice date",
    "order date",
    "bill date",
  ],
  supplierName: ["supplierName", "supplier", "supplier name", "vendor", "distributor", "party"],
  medicineName: ["medicineName", "medicine", "medicine name", "item", "product", "drug"],
  hsnCode: ["hsnCode", "hsn", "hsn code", "hsn no"],
  pack: ["pack", "packing", "pack size"],
  batchNumber: ["batchNumber", "batch", "batch number", "batch no"],
  expiryDate: ["expiryDate", "expiry", "expiry date", "batch expiry"],
  quantity: ["quantity", "qty", "units"],
  freeQuantity: ["freeQuantity", "free", "free qty", "free quantity"],
  unitCost: ["unitCost", "rate", "unit cost", "unit price", "price", "amount per unit"],
  mrp: ["mrp"],
  discountPct: ["discountPct", "discount", "discount %"],
  sgstRate: ["sgstRate", "sgst", "sgst %", "sgst rate"],
  cgstRate: ["cgstRate", "cgst", "cgst %", "cgst rate"],
  gstRate: ["gstRate", "gst", "gst %", "gst rate", "tax", "tax %"],
  notes: ["notes", "remark", "remarks"],
};

function mapPurchaseCsvRow(row) {
  const mapped = {};
  for (const [key, aliases] of Object.entries(PURCHASE_COLUMN_ALIASES)) {
    const match = aliases.find((a) => row[a] !== undefined && row[a] !== "");
    if (match) mapped[key] = String(row[match]).trim();
  }
  return mapped;
}

function validatePurchaseCsvRow(row, index) {
  const errors = [];
  const data = mapPurchaseCsvRow(row);

  const parsedDate = new Date(data.purchaseDate);
  const dateValid = data.purchaseDate && !Number.isNaN(parsedDate.getTime());

  if (!data.invoiceNo) errors.push("Missing Invoice Number");
  if (!data.purchaseDate) {
    errors.push("Missing Date");
  } else if (!dateValid) {
    errors.push("Invalid date");
  }
  if (!data.medicineName) errors.push("Missing Product");
  const qty = Number(data.quantity);
  if (data.quantity !== undefined && data.quantity !== "" && (!Number.isFinite(qty) || qty <= 0)) {
    errors.push("Quantity must be greater than 0");
  }
  const rate = Number(data.unitCost);
  if (data.unitCost !== undefined && data.unitCost !== "" && (!Number.isFinite(rate) || rate < 0)) {
    errors.push("Invalid amount");
  }
  const gst = Number(data.gstRate);
  if (
    data.gstRate !== undefined &&
    data.gstRate !== "" &&
    (!Number.isFinite(gst) || gst < 0 || gst > 100)
  ) {
    errors.push("Invalid GST");
  }
  const sgst = Number(data.sgstRate);
  const cgst = Number(data.cgstRate);
  if (
    (data.sgstRate && (!Number.isFinite(sgst) || sgst < 0 || sgst > 100)) ||
    (data.cgstRate && (!Number.isFinite(cgst) || cgst < 0 || cgst > 100))
  ) {
    errors.push("Invalid SGST/CGST");
  }
  const disc = Number(data.discountPct);
  if (
    data.discountPct !== undefined &&
    data.discountPct !== "" &&
    (!Number.isFinite(disc) || disc < 0 || disc > 100)
  ) {
    errors.push("Invalid discount");
  }

  return {
    row: index + 2,
    data: {
      invoiceNo: data.invoiceNo || "",
      purchaseDate: dateValid ? parsedDate.toISOString() : data.purchaseDate || "",
      supplierName: data.supplierName || "",
      medicineName: data.medicineName || "",
      hsnCode: data.hsnCode || "",
      pack: data.pack || "",
      batchNumber: data.batchNumber || "",
      expiryDate: data.expiryDate || "",
      quantity: qty > 0 ? qty : data.quantity || 0,
      freeQuantity: Number(data.freeQuantity) || 0,
      unitCost: Number.isFinite(rate) && rate >= 0 ? rate : data.unitCost || 0,
      mrp: Number(data.mrp) || 0,
      discountPct: Number.isFinite(disc) && disc >= 0 ? disc : 0,
      sgstRate: Number.isFinite(sgst) && sgst >= 0 ? sgst : 0,
      cgstRate: Number.isFinite(cgst) && cgst >= 0 ? cgst : 0,
      gstRate: Number.isFinite(gst) && gst >= 0 ? gst : 0,
      notes: data.notes || "",
    },
    errors,
    valid: errors.length === 0,
  };
}

export async function validatePurchaseImport(csv, userId) {
  const records = parseCsv(csv);
  if (records.length === 0) {
    throw ApiError.badRequest("No rows found in the uploaded CSV");
  }

  const results = records.map((r, i) => validatePurchaseCsvRow(r, i));
  const validRows = results.filter((r) => r.valid);

  const seen = new Map();
  const duplicates = [];
  const existing = await Purchase.find({
    createdBy: userId,
    orderNo: { $in: validRows.map((r) => r.data.invoiceNo).filter(Boolean) },
  })
    .select("orderNo")
    .lean();
  const existingByNo = new Map(existing.map((e) => [String(e.orderNo).toLowerCase(), e.orderNo]));

  for (const r of results) {
    if (!r.valid) continue;
    const key = `${r.data.invoiceNo.toLowerCase()}@${r.data.purchaseDate.slice(0, 10)}`;
    if (seen.has(key)) {
      duplicates.push({ row: r.row, invoiceNo: r.data.invoiceNo, reason: "duplicate within file" });
    } else {
      seen.set(key, r.row);
    }
    const dbMatch = existingByNo.get(r.data.invoiceNo.toLowerCase());
    if (dbMatch) {
      duplicates.push({ row: r.row, invoiceNo: dbMatch, reason: "purchase already exists" });
    }
  }

  return {
    totalRows: results.length,
    headers: records.length ? Object.keys(records[0]) : [],
    preview: results.map((r) => ({
      row: r.row,
      data: r.data,
      errors: r.errors,
      valid: r.valid,
    })),
    duplicates,
    validCount: results.filter((r) => r.valid).length,
    errorCount: results.filter((r) => !r.valid).length,
  };
}

export async function importPurchases({ rows, duplicateMode = "skip", userId, userName }) {
  const mode = ["skip", "replace", "cancel"].includes(duplicateMode) ? duplicateMode : "skip";
  const validated = (Array.isArray(rows) ? rows : []).map((r, i) => {
    const row = r && typeof r === "object" && r.data ? r.data : r;
    return validatePurchaseCsvRow(row, i + 1);
  });

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  if (mode === "cancel" && validated.some((r) => r.valid)) {
    const existing = await Purchase.find({
      createdBy: userId,
      orderNo: { $in: validated.filter((r) => r.valid).map((r) => r.data.invoiceNo) },
    })
      .select("orderNo")
      .lean();
    if (existing.length > 0) {
      throw ApiError.conflict(
        "Duplicate purchases detected — import cancelled. Choose Skip or Replace and try again.",
      );
    }
  }

  for (const r of validated) {
    if (!r.valid) continue;
    const totals = normalizePurchaseItems([
      {
        medicineName: r.data.medicineName,
        hsnCode: r.data.hsnCode,
        pack: r.data.pack,
        batchNumber: r.data.batchNumber,
        expiryDate: r.data.expiryDate,
        quantity: Number(r.data.quantity) || 0,
        freeQuantity: Number(r.data.freeQuantity) || 0,
        unitCost: Number(r.data.unitCost) || 0,
        mrp: Number(r.data.mrp) || 0,
        discountPct: Number(r.data.discountPct) || 0,
        sgstRate: Number(r.data.sgstRate) || 0,
        cgstRate: Number(r.data.cgstRate) || 0,
        gstRate: Number(r.data.gstRate) || 0,
      },
    ]);
    const purchaseDate = new Date(r.data.purchaseDate);

    const existingDoc = await Purchase.findOne({ createdBy: userId, orderNo: r.data.invoiceNo })
      .select("_id")
      .lean();
    if (existingDoc) {
      if (mode === "replace") {
        await Purchase.updateOne(
          { _id: existingDoc._id },
          {
            $set: {
              ...buildPurchaseDoc({ ...r.data, items: totals.items }),
              status: "received",
              source: "imported",
              createdByName: userName || "Staff",
              createdAt: purchaseDate,
            },
          },
        );
        replaced += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    await Purchase.create({
      ...buildPurchaseDoc({ ...r.data, items: totals.items }),
      status: "received",
      source: "imported",
      createdBy: userId,
      createdByName: userName || "Staff",
      createdAt: purchaseDate,
    });
    inserted += 1;
  }

  return { inserted, replaced, skipped, total: inserted + replaced + skipped };
}

/* ---------------------------------------------------------------------
   Read-only listing for the other report data sources.
   Only implemented where a real persisted model exists — nothing is
   invented. Returns column labels plus row arrays so the UI stays generic.
   --------------------------------------------------------------------- */

const READONLY_SOURCES = new Set([
  "purchases",
  "medicines",
  "suppliers",
  "inventory",
  "customers",
  "payments",
  "gst",
  "expiry",
  "audit",
]);

export async function listSourceData(source, userId) {
  if (!READONLY_SOURCES.has(source)) {
    throw ApiError.badRequest(`Unsupported report data source "${source}"`);
  }

  const limit = 100;
  if (source === "purchases") {
    const docs = await Purchase.find({ createdBy: userId })
      .populate("supplierId", "name")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "Purchases",
      columns: ["Order No", "Supplier", "Items", "Total", "Status", "Date"],
      items: docs.map((d) => [
        d.orderNo,
        d.supplierId?.name ?? d.supplierName ?? "",
        (d.items || []).reduce((a, i) => a + (i.quantity || 0), 0),
        d.grandTotal ?? 0,
        d.status,
        d.createdAt,
      ]),
    };
  }
  if (source === "medicines") {
    const docs = await Medicine.find()
      .populate("categoryId", "name")
      .sort({ name: 1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "Medicines",
      columns: ["Medicine", "Category", "HSN Code", "GST %", "Active"],
      items: docs.map((d) => [
        d.name,
        d.categoryId?.name ?? "General",
        d.hsnCode || "",
        d.gstRate ?? 0,
        d.isActive ? "Yes" : "No",
      ]),
    };
  }
  if (source === "suppliers") {
    const docs = await Supplier.find().sort({ name: 1 }).limit(limit).lean();
    return {
      source,
      name: "Suppliers",
      columns: ["Supplier", "Phone", "GST Number", "Active"],
      items: docs.map((d) => [d.name, d.phone || "", d.gstNumber || "", d.isActive ? "Yes" : "No"]),
    };
  }
  if (source === "inventory") {
    const docs = await Batch.find()
      .populate("medicineId", "name")
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "Inventory",
      columns: ["Medicine", "Batch", "Stock", "Expiry", "Status"],
      items: docs.map((d) => [
        d.medicineId?.name ?? "",
        d.batchNumber,
        d.currentStock ?? 0,
        d.expiryDate,
        d.status,
      ]),
    };
  }
  if (source === "customers") {
    const rows = await Sale.aggregate([
      {
        $match: {
          createdBy: new mongoose.Types.ObjectId(userId),
          status: "completed",
          customerName: { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$customerName",
          bills: { $sum: 1 },
          total: { $sum: "$grandTotal" },
          last: { $max: "$createdAt" },
        },
      },
      { $sort: { total: -1 } },
      { $limit: limit },
    ]);
    return {
      source,
      name: "Customers",
      columns: ["Customer", "Bills", "Total Purchase", "Last Purchase"],
      items: rows.map((d) => [d._id, d.bills, d.total, d.last]),
    };
  }
  if (source === "payments") {
    const docs = await Sale.find({ createdBy: userId, status: "completed" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "Payments",
      columns: ["Bill", "Customer", "Mode", "Status", "Amount", "Date"],
      items: docs.map((d) => [
        d.invoiceNo,
        d.customerName || "",
        d.paymentMode,
        d.paymentStatus,
        d.grandTotal,
        d.createdAt,
      ]),
    };
  }
  if (source === "gst") {
    const docs = await Sale.find({ createdBy: userId, status: "completed", gstTotal: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "GST / Tax",
      columns: ["Bill", "Customer", "Subtotal", "GST", "Total", "Date"],
      items: docs.map((d) => [
        d.invoiceNo,
        d.customerName || "",
        d.subtotal ?? 0,
        d.gstTotal ?? 0,
        d.grandTotal,
        d.createdAt,
      ]),
    };
  }
  if (source === "expiry") {
    const docs = await Batch.find({ status: { $in: ["expired", "near_expiry"] } })
      .populate("medicineId", "name")
      .sort({ expiryDate: 1 })
      .limit(limit)
      .lean();
    return {
      source,
      name: "Expiry",
      columns: ["Medicine", "Batch", "Stock", "Expiry", "Status"],
      items: docs.map((d) => [
        d.medicineId?.name ?? "",
        d.batchNumber,
        d.currentStock ?? 0,
        d.expiryDate,
        d.status,
      ]),
    };
  }
  const docs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
  return {
    source,
    name: "Audit",
    columns: ["User", "Action", "Entity", "Date"],
    items: docs.map((d) => [d.userName || "", d.action, d.entityType || "", d.createdAt]),
  };
}

/* ---------------------------------------------------------------------
   Report Bills (unified manager)
   ---------------------------------------------------------------------
   The Report Data page manages a single bill-centric view. Records created
   through this flow are persisted as ReportBill documents (collection
   "reportbills", owned by Reports). Legacy records that already exist in the
   Sale / Purchase collections are still listed, read, updated and deleted so
   nothing created through the POS or older flows disappears — each record is
   normalized to one unified "superset" shape tagged with its kind
   ("sale" | "purchase" | "bill"). All totals are recomputed server-side.
   --------------------------------------------------------------------- */

// Reads a bill's business date for date-range filtering. ReportBill stores the
// date on invoice.invoiceDate; Sale / Purchase use createdAt (which is set to
// the bill date on creation), so all three sort consistently.
function parseReportBillDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw ApiError.badRequest("Invalid bill date");
  }
  return d;
}

function resolveBillTypeFilter(documentType) {
  const raw = String(documentType ?? "").trim();
  const v = raw.toLowerCase();
  if (!v) return null;
  if (v === "sales" || v === "sale") return "sales";
  if (v === "purchases" || v === "purchase") return "purchases";
  if (REPORT_BILL_SALES_TYPES.includes(raw)) return "sales";
  if (REPORT_BILL_PURCHASE_TYPES.includes(raw)) return "purchases";
  return null;
}

function pickReportBillMode(documentType) {
  return REPORT_BILL_SALES_TYPES.includes(documentType) ? "sales" : "purchase";
}

function resolveReportBillStatus(documentType) {
  return REPORT_BILL_SALES_TYPES.includes(documentType) ? "completed" : "received";
}

// Unified superset line item. Sales records populate unitPrice (unitCost null),
// purchase records the reverse, and reportbills keep whichever side was set.
function unifyItem(it) {
  return {
    medicineId: it.medicineId ?? null,
    batchId: it.batchId ?? null,
    medicineName: it.medicineName || "",
    quantity: it.quantity ?? 0,
    freeQuantity: it.freeQuantity ?? 0,
    unitPrice: it.unitPrice ?? null,
    unitCost: it.unitCost ?? null,
    mrp: it.mrp ?? 0,
    discountPct: it.discountPct ?? 0,
    discountAmount: it.discountAmount ?? 0,
    gstRate: it.gstRate ?? 0,
    sgstRate: it.sgstRate ?? 0,
    cgstRate: it.cgstRate ?? 0,
    sgstAmount: it.sgstAmount ?? 0,
    cgstAmount: it.cgstAmount ?? 0,
    gstAmount: it.gstAmount ?? 0,
    taxableAmount: it.taxableAmount ?? 0,
    lineTotal: it.lineTotal ?? 0,
    hsnCode: it.hsnCode || "",
    pack: it.pack || "",
    batchNumber: it.batchNumber || "",
    expiryDate: it.expiryDate ?? null,
    manufacturer: it.manufacturer || "",
  };
}

// Recomputes every total on the server. Rate comes from unitPrice for
// sales-side records and unitCost for purchase-side records; a combined
// gstRate is split equally unless explicit SGST/CGST rates are provided.
// Discount REDUCES the taxable amount (and therefore the total).
function normalizeReportBillItems(items, mode = "auto") {
  let subtotal = 0;
  let discountTotal = 0;
  let sgstTotal = 0;
  let cgstTotal = 0;
  const normalized = (Array.isArray(items) ? items : []).map((line) => {
    const quantity = Number(line?.quantity) || 0;
    const freeQuantity = Number(line?.freeQuantity) || 0;
    const mrp = Number(line?.mrp) || 0;
    const discountPct = Math.min(100, Math.max(0, Number(line?.discountPct) || 0));
    const gstRate = Math.min(100, Math.max(0, Number(line?.gstRate) || 0));
    const sgstRateIn = Math.min(100, Math.max(0, Number(line?.sgstRate) || 0));
    const cgstRateIn = Math.min(100, Math.max(0, Number(line?.cgstRate) || 0));
    const unitPrice = Number(line?.unitPrice) || 0;
    const unitCost = Number(line?.unitCost ?? line?.rate) || 0;
    const rate =
      mode === "sales" ? unitPrice : mode === "purchase" ? unitCost : unitPrice || unitCost;

    const gross = quantity * rate;
    const discount = (gross * discountPct) / 100;
    const taxable = gross - discount;
    const explicitSplit = sgstRateIn > 0 || cgstRateIn > 0;
    const effSgst = explicitSplit ? sgstRateIn : gstRate / 2;
    const effCgst = explicitSplit ? cgstRateIn : gstRate / 2;
    const sgst = (taxable * effSgst) / 100;
    const cgst = (taxable * effCgst) / 100;

    subtotal += gross;
    discountTotal += discount;
    sgstTotal += sgst;
    cgstTotal += cgst;

    return {
      medicineId:
        line?.medicineId && mongoose.isValidObjectId(line.medicineId) ? line.medicineId : null,
      batchId: line?.batchId && mongoose.isValidObjectId(line.batchId) ? line.batchId : null,
      medicineName: String(line?.medicineName ?? "").trim(),
      quantity,
      freeQuantity,
      unitPrice: mode === "purchase" ? null : round2(unitPrice || rate),
      unitCost: mode === "sales" ? null : round2(unitCost || rate),
      mrp,
      discountPct,
      discountAmount: round2(discount),
      gstRate: explicitSplit ? round2(effSgst + effCgst) : round2(gstRate),
      sgstRate: round2(effSgst),
      cgstRate: round2(effCgst),
      sgstAmount: round2(sgst),
      cgstAmount: round2(cgst),
      gstAmount: round2(sgst + cgst),
      taxableAmount: round2(taxable),
      lineTotal: round2(taxable + sgst + cgst),
      hsnCode: String(line?.hsnCode ?? "").trim(),
      pack: String(line?.pack ?? "").trim(),
      batchNumber: String(line?.batchNumber ?? "").trim(),
      expiryDate: parseExpiry(line?.expiryDate ?? line?.batchExpiry),
      manufacturer: String(line?.manufacturer ?? "").trim(),
    };
  });

  const taxableAmount = subtotal - discountTotal;
  const totalGst = sgstTotal + cgstTotal;
  const calculatedGrandTotal = taxableAmount + totalGst;
  return {
    items: normalized,
    totals: {
      subtotal: round2(subtotal),
      discountAmount: round2(discountTotal),
      taxableAmount: round2(taxableAmount),
      sgst: round2(sgstTotal),
      cgst: round2(cgstTotal),
      totalGst: round2(totalGst),
      roundOff: round2(Math.round(calculatedGrandTotal) - calculatedGrandTotal),
      calculatedGrandTotal: round2(calculatedGrandTotal),
    },
  };
}

function validateReportBillInput(data = {}) {
  const errors = [];
  const documentType = String(data.documentType ?? "purchase_invoice").trim();
  if (!REPORT_BILL_DOCUMENT_TYPES.includes(documentType)) {
    errors.push("Invalid document type");
  }
  const invoiceNo = String(
    data.invoice?.invoiceNumber ?? data.invoiceNo ?? data.orderNo ?? "",
  ).trim();
  if (!invoiceNo) errors.push("Invoice number is required");
  const invoiceDate = data.invoice?.invoiceDate ?? data.billDate ?? data.purchaseDate;
  if (invoiceDate !== undefined && invoiceDate !== null && invoiceDate !== "") {
    const d = new Date(invoiceDate);
    if (Number.isNaN(d.getTime())) errors.push("Invalid bill date");
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    errors.push("At least one item is required");
  } else {
    data.items.forEach((it, idx) => {
      const label = `Item ${idx + 1}`;
      const qty = Number(it?.quantity);
      if (!Number.isFinite(qty) || qty <= 0)
        errors.push(`${label}: quantity must be greater than 0`);
      const rate = Number(it?.unitPrice) || Number(it?.unitCost ?? it?.rate);
      if (!Number.isFinite(rate) || rate < 0) errors.push(`${label}: invalid rate`);
      const mrp = Number(it?.mrp) || 0;
      if (mrp < 0) errors.push(`${label}: invalid MRP`);
      const gst = Number(it?.gstRate) || 0;
      if (gst < 0 || gst > 100) errors.push(`${label}: invalid GST rate`);
      const sgst = Number(it?.sgstRate) || 0;
      const cgst = Number(it?.cgstRate) || 0;
      if (sgst < 0 || sgst > 100 || cgst < 0 || cgst > 100) {
        errors.push(`${label}: invalid SGST/CGST rate`);
      }
      const disc = Number(it?.discountPct) || 0;
      if (disc < 0 || disc > 100) errors.push(`${label}: invalid discount`);
      if (!it?.medicineName || !String(it.medicineName).trim()) {
        errors.push(`${label}: product name is required`);
      }
    });
  }
  const printed = Number(data.printedGrandTotal);
  if (
    data.printedGrandTotal !== undefined &&
    data.printedGrandTotal !== null &&
    data.printedGrandTotal !== "" &&
    (!Number.isFinite(printed) || printed < 0)
  ) {
    errors.push("Invalid printed grand total");
  }
  if (
    data.paymentMode !== undefined &&
    data.paymentMode !== "" &&
    !PAYMENT_MODES.includes(String(data.paymentMode).trim())
  ) {
    errors.push(`Invalid payment mode. Use one of: ${PAYMENT_MODES.join(", ")}`);
  }
  if (
    data.paymentStatus !== undefined &&
    data.paymentStatus !== "" &&
    !PAYMENT_STATUSES.includes(String(data.paymentStatus).trim().toLowerCase())
  ) {
    errors.push("Invalid payment status. Use paid, pending or partial");
  }
  if (errors.length) throw ApiError.badRequest(errors.join("; "));
}

// Duplicate protection is ownership-aware and date-scoped (same number on a
// different day is a legitimate repeat). Matches createdBy + invoice number
// (case-insensitive) + the invoice's calendar day.
async function assertNoDuplicateReportBill(
  userId,
  invoiceNumber,
  invoiceDate = new Date(),
  excludeId = null,
) {
  if (!invoiceNumber) return;
  const day = new Date(invoiceDate);
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  const existing = await ReportBill.findOne({
    createdBy: userId,
    "invoice.invoiceNumber": {
      $regex: new RegExp(`^${String(invoiceNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    },
    "invoice.invoiceDate": { $gte: start, $lte: end },
  })
    .select("_id")
    .lean();
  if (existing && (!excludeId || String(existing._id) !== String(excludeId))) {
    throw ApiError.conflict(`Duplicate bill — ${invoiceNumber} already exists for this date.`);
  }
}

// Builds the persisted ReportBill document from either the sales-style or the
// purchase-style form payload, normalizing both to the unified superset shape.
function buildReportBillDoc(data) {
  const documentType = REPORT_BILL_DOCUMENT_TYPES.includes(String(data.documentType ?? "").trim())
    ? String(data.documentType).trim()
    : "purchase_invoice";
  const mode = pickReportBillMode(documentType);
  const isSales = mode === "sales";

  const invoiceNumber = String(
    data.invoice?.invoiceNumber ?? data.invoiceNo ?? data.orderNo ?? "",
  ).trim();
  const invoiceDate =
    parseReportBillDate(data.invoice?.invoiceDate ?? data.billDate ?? data.purchaseDate) ??
    new Date();

  const supplierRaw = data.supplier ?? {};
  const customerRaw = data.customer ?? {};
  const supplierName = String(
    data.supplierName ?? supplierRaw.name ?? data.party?.name ?? "",
  ).trim();
  const supplierGstin = String(
    supplierRaw.gstin ?? data.supplierGstin ?? data.party?.gstin ?? "",
  ).trim();
  const customerName = String(
    data.customerName ?? customerRaw.name ?? (isSales ? (data.party?.name ?? "") : ""),
  ).trim();
  const customerGstin = String(data.customerGstin ?? customerRaw.gstin ?? "").trim();

  const totals = normalizeReportBillItems(data.items ?? [], mode);
  const printed =
    data.printedGrandTotal !== undefined &&
    data.printedGrandTotal !== null &&
    data.printedGrandTotal !== ""
      ? Number(data.printedGrandTotal)
      : null;
  const printedFinal =
    printed !== null && Number.isFinite(printed) && printed >= 0 ? round2(printed) : null;
  const totalsOut = {
    ...totals.totals,
    printedGrandTotal: printedFinal,
    grandTotal: printedFinal ?? totals.totals.calculatedGrandTotal,
  };

  const supplierPhoneRaw = String(supplierRaw.phone ?? data.supplierPhone ?? "").trim();
  const customerPhoneRaw = String(data.customerPhone ?? customerRaw.phone ?? "").trim();

  return {
    documentType,
    invoice: { invoiceNumber, invoiceDate },
    supplier: {
      name: supplierName,
      address: String(supplierRaw.address ?? "").trim(),
      gstin: supplierGstin,
      phone: supplierPhoneRaw ? normalizeIndianPhone(supplierPhoneRaw) : "",
    },
    customer: {
      name: customerName,
      gstin: customerGstin,
      phone: customerPhoneRaw ? normalizeIndianPhone(customerPhoneRaw) : "",
    },
    items: totals.items,
    totals: totalsOut,
    payment: {
      mode: String(data.payment?.mode ?? data.paymentMode ?? "Cash").trim(),
      status: PAYMENT_STATUSES.includes(
        String(data.payment?.status ?? data.paymentStatus ?? "")
          .trim()
          .toLowerCase(),
      )
        ? String(data.payment?.status ?? data.paymentStatus)
            .trim()
            .toLowerCase()
        : "paid",
    },
    status: resolveReportBillStatus(documentType),
    source: BILL_SOURCES.includes(data.source) ? data.source : "manual",
    originalDocument: data.originalDocument ?? data.uploadedFile ?? null,
    notes: String(data.notes ?? "").trim(),
  };
}

export function unifiedFromReportBill(rb, { includeExtraction = false } = {}) {
  const t = rb.totals ?? {};
  const isSales = REPORT_BILL_SALES_TYPES.includes(rb.documentType);
  const partyName = isSales ? rb.customer?.name || "" : rb.supplier?.name || "";
  return {
    id: rb._id,
    kind: "bill",
    invoiceNo: rb.invoice?.invoiceNumber || "",
    orderNo: rb.invoice?.invoiceNumber || "",
    billDate: rb.createdAt ?? rb.invoice?.invoiceDate ?? null,
    purchaseDate: rb.createdAt ?? rb.invoice?.invoiceDate ?? null,
    invoiceDate: rb.invoice?.invoiceDate ?? rb.createdAt ?? null,
    party: {
      name: partyName,
      gstin: isSales ? rb.customer?.gstin || "" : rb.supplier?.gstin || "",
      phone: rb.supplier?.phone || rb.customer?.phone || "",
    },
    customerName: rb.customer?.name || "",
    customerGstin: rb.customer?.gstin || "",
    customerPhone: rb.customer?.phone || "",
    supplierName: rb.supplier?.name || "",
    supplierGstin: rb.supplier?.gstin || "",
    supplierAddress: rb.supplier?.address || "",
    supplierPhone: rb.supplier?.phone || "",
    items: (rb.items || []).map(unifyItem),
    itemCount: (rb.items || []).length,
    itemNames: [...new Set((rb.items || []).map((i) => i.medicineName).filter(Boolean))],
    subtotal: t.subtotal ?? 0,
    discountTotal: t.discountAmount ?? 0,
    discount: t.discountAmount ?? 0,
    taxableAmount: t.taxableAmount ?? 0,
    gstTotal: t.totalGst ?? 0,
    totalSGST: t.sgst ?? 0,
    totalCGST: t.cgst ?? 0,
    roundOff: t.roundOff ?? 0,
    grandTotal: t.grandTotal ?? 0,
    printedGrandTotal: t.printedGrandTotal ?? null,
    calculatedGrandTotal: t.calculatedGrandTotal ?? null,
    paymentMode: rb.payment?.mode || "Cash",
    paymentStatus: rb.payment?.status || "paid",
    status: rb.status ?? "received",
    source: rb.source ?? "manual",
    documentType: rb.documentType ?? "purchase_invoice",
    uploadedFile: rb.originalDocument ?? null,
    originalDocument: rb.originalDocument ?? null,
    notes: rb.notes || "",
    whatsapp: formatWhatsAppDelivery(rb.whatsappDelivery),
    staff: rb.createdByName || "Staff",
    createdAt: rb.createdAt,
    updatedAt: rb.updatedAt,
    ...(includeExtraction ? { extraction: rb.extraction ?? null } : {}),
  };
}

export function unifiedFromSale(s, { includeExtraction = false } = {}) {
  return {
    id: s._id,
    kind: "sale",
    invoiceNo: s.invoiceNo,
    orderNo: "",
    billDate: s.createdAt,
    purchaseDate: null,
    invoiceDate: null,
    party: { name: s.customerName || "", gstin: "", phone: s.customerPhone || "" },
    customerName: s.customerName || "",
    customerGstin: "",
    customerPhone: s.customerPhone || "",
    supplierName: "",
    supplierGstin: "",
    supplierAddress: "",
    supplierPhone: "",
    items: (s.items || []).map(unifyItem),
    itemCount: (s.items || []).length,
    itemNames: [...new Set((s.items || []).map((i) => i.medicineName).filter(Boolean))],
    subtotal: s.subtotal ?? 0,
    discountTotal: s.discountTotal ?? 0,
    discount: s.discountTotal ?? 0,
    taxableAmount: s.taxableAmount ?? 0,
    gstTotal: s.gstTotal ?? 0,
    totalSGST: s.totalSGST ?? round2((s.gstTotal ?? 0) / 2),
    totalCGST: s.totalCGST ?? round2((s.gstTotal ?? 0) / 2),
    roundOff: s.roundOff ?? 0,
    grandTotal: s.grandTotal ?? 0,
    printedGrandTotal: s.printedGrandTotal ?? null,
    calculatedGrandTotal: s.calculatedGrandTotal ?? null,
    paymentMode: s.paymentMode || "Cash",
    paymentStatus: s.paymentStatus ?? "paid",
    status: s.status ?? "completed",
    source: s.source ?? "existing",
    documentType: "sales_invoice",
    uploadedFile: s.uploadedFile ?? null,
    originalDocument: s.uploadedFile ?? null,
    notes: s.notes || "",
    whatsapp: formatWhatsAppDelivery(undefined),
    staff: s.createdByName || "Staff",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(includeExtraction ? { extraction: s.extraction ?? null } : {}),
  };
}

export function unifiedFromPurchase(p, { includeExtraction = false } = {}) {
  return {
    id: p._id,
    kind: "purchase",
    invoiceNo: p.orderNo,
    orderNo: p.orderNo,
    billDate: null,
    purchaseDate: p.createdAt,
    invoiceDate: null,
    party: {
      name: p.supplierId?.name ?? p.supplierName ?? "",
      gstin: p.party?.gstin || "",
      phone: "",
    },
    customerName: "",
    customerGstin: "",
    customerPhone: "",
    supplierName: p.supplierId?.name ?? p.supplierName ?? "",
    supplierGstin: p.supplierId?.gstNumber ?? p.party?.gstin ?? "",
    supplierAddress: "",
    supplierPhone: "",
    items: (p.items || []).map(unifyItem),
    itemCount: (p.items || []).length,
    itemNames: [...new Set((p.items || []).map((i) => i.medicineName).filter(Boolean))],
    subtotal: p.subtotal ?? 0,
    discountTotal: p.discount ?? 0,
    discount: p.discount ?? 0,
    taxableAmount: p.taxableAmount ?? 0,
    gstTotal: p.gstTotal ?? 0,
    totalSGST: p.totalSGST ?? 0,
    totalCGST: p.totalCGST ?? 0,
    roundOff: p.roundOff ?? 0,
    grandTotal: p.grandTotal ?? 0,
    printedGrandTotal: p.printedGrandTotal ?? null,
    calculatedGrandTotal: p.calculatedGrandTotal ?? null,
    paymentMode: "Credit",
    paymentStatus: "paid",
    status: p.status ?? "received",
    source: p.source ?? "existing",
    documentType: p.documentType ?? "purchase_invoice",
    uploadedFile: p.originalDocument ?? null,
    originalDocument: p.originalDocument ?? null,
    notes: p.notes || "",
    whatsapp: formatWhatsAppDelivery(undefined),
    staff: p.createdByName || "Staff",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(includeExtraction ? { extraction: p.extraction ?? null } : {}),
  };
}

// Maps a unified payload back to the field names the legacy sale writer
// expects, so editing a Sale record through the unified manager keeps working.
function unifiedToSaleInput(data) {
  return {
    ...data,
    invoiceNo: data.invoiceNo ?? data.invoice?.invoiceNumber,
    billDate: data.billDate ?? data.invoice?.invoiceDate ?? data.invoiceDate,
    customerName: data.customerName ?? data.party?.name,
    customerPhone: data.customerPhone ?? data.party?.phone,
    paymentMode: data.paymentMode ?? data.payment?.mode,
    paymentStatus: data.paymentStatus ?? data.payment?.status,
    uploadedFile: data.uploadedFile ?? data.originalDocument,
    items: data.items,
  };
}

// Same mapping for the legacy purchase writer.
function unifiedToPurchaseInput(data) {
  return {
    ...data,
    invoiceNo: data.invoiceNo ?? data.invoice?.invoiceNumber ?? data.orderNo,
    purchaseDate: data.purchaseDate ?? data.invoice?.invoiceDate ?? data.invoiceDate,
    supplierName: data.supplierName ?? data.supplier?.name ?? data.party?.name,
    party: data.party ?? { name: data.supplierName ?? "", gstin: data.supplierGstin ?? "" },
    originalDocument: data.originalDocument ?? data.uploadedFile,
    items: data.items,
  };
}

export async function listReportBills({ userId, query = {} }) {
  const {
    search,
    dateFrom,
    dateTo,
    source,
    paymentMode,
    paymentStatus,
    documentType,
    sort = "newest",
  } = query;
  const { page, limit, skip } = buildPagination(query);

  // Each collection contributes at most this many newest records; the union of
  // per-collection top-N always contains the global top-N, so an in-memory
  // merge-sort after that is exact for any requested page.
  const CAP = 1000;
  const fetchLimit = Math.min(CAP, skip + limit);

  let wantSales = true;
  let wantPurchases = true;
  const saleFilter = { createdBy: userId, status: "completed" };
  const purchaseFilter = { createdBy: userId };
  const rbFilter = { createdBy: userId };

  if (search && String(search).trim()) {
    const q = String(search).trim();
    const rgx = { $regex: q, $options: "i" };
    saleFilter.$or = [
      { invoiceNo: rgx },
      { customerName: rgx },
      { customerPhone: rgx },
      { "items.medicineName": rgx },
      { "items.batchNumber": rgx },
    ];
    purchaseFilter.$or = [
      { orderNo: rgx },
      { supplierName: rgx },
      { "items.medicineName": rgx },
      { "items.batchNumber": rgx },
    ];
    rbFilter.$or = [
      { "invoice.invoiceNumber": rgx },
      { "supplier.name": rgx },
      { "customer.name": rgx },
      { "items.medicineName": rgx },
      { "items.batchNumber": rgx },
    ];
  }

  if (dateFrom || dateTo) {
    const from = parseReportBillDate(dateFrom);
    const to = parseReportBillDate(dateTo);
    if (from && to && from.getTime() > to.getTime()) {
      throw ApiError.badRequest("dateFrom cannot be later than dateTo");
    }
    const range = {};
    if (from) range.$gte = new Date(from.setHours(0, 0, 0, 0));
    if (to) range.$lte = new Date(to.setHours(23, 59, 59, 999));
    saleFilter.createdAt = range;
    purchaseFilter.createdAt = range;
    rbFilter["invoice.invoiceDate"] = range;
  }

  if (documentType) {
    const raw = String(documentType).trim();
    const side = resolveBillTypeFilter(raw);
    if (side === "sales") wantPurchases = false;
    if (side === "purchases") wantSales = false;
    if (side === "sales") rbFilter.documentType = { $in: REPORT_BILL_SALES_TYPES };
    if (side === "purchases") rbFilter.documentType = { $in: REPORT_BILL_PURCHASE_TYPES };
    if (REPORT_BILL_DOCUMENT_TYPES.includes(raw)) rbFilter.documentType = raw;
  }

  if (source && BILL_SOURCES.includes(String(source).trim())) {
    const s = String(source).trim();
    saleFilter.source = s;
    purchaseFilter.source = s;
    rbFilter.source = s;
  }
  if (paymentMode) {
    const pm = String(paymentMode).trim();
    saleFilter.paymentMode = pm;
    rbFilter["payment.mode"] = pm;
    if (pm !== "Credit") purchaseFilter._id = null; // purchases are credit transactions
  }
  if (paymentStatus) {
    const ps = String(paymentStatus).trim().toLowerCase();
    saleFilter.paymentStatus = ps;
    rbFilter["payment.status"] = ps;
    if (ps !== "paid") purchaseFilter._id = null; // purchases are treated as settled
  }

  const asc = sort === "oldest" || sort === "lowest";
  const byValue = sort === "highest" || sort === "lowest";
  const dbSort = {
    [byValue ? "grandTotal" : "createdAt"]: asc ? 1 : -1,
    _id: 1,
  };

  const [saleRes, purchaseRes, rbRes] = await Promise.all([
    wantSales
      ? Promise.all([
          Sale.find(saleFilter).sort(dbSort).limit(fetchLimit).lean(),
          Sale.countDocuments(saleFilter),
        ])
      : Promise.resolve([[], 0]),
    wantPurchases
      ? Promise.all([
          Purchase.find(purchaseFilter)
            .populate("supplierId", "name gstNumber")
            .sort(dbSort)
            .limit(fetchLimit)
            .lean(),
          Purchase.countDocuments(purchaseFilter),
        ])
      : Promise.resolve([[], 0]),
    Promise.all([
      ReportBill.find(rbFilter).sort(dbSort).limit(fetchLimit).lean(),
      ReportBill.countDocuments(rbFilter),
    ]),
  ]);

  const [saleDocs, saleTotal] = saleRes;
  const [purchaseDocs, purchaseTotal] = purchaseRes;
  const [rbDocs, rbTotal] = rbRes;

  const combined = [];
  for (const d of saleDocs) combined.push(unifiedFromSale(d));
  for (const d of purchaseDocs) combined.push(unifiedFromPurchase(d));
  for (const d of rbDocs) combined.push(unifiedFromReportBill(d));

  const total = saleTotal + purchaseTotal + rbTotal;
  combined.sort((a, b) => {
    let cmp = 0;
    if (byValue) cmp = (Number(b.grandTotal) || 0) - (Number(a.grandTotal) || 0);
    else cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (asc) cmp = -cmp;
    if (cmp === 0) cmp = String(a.id).localeCompare(String(b.id));
    return cmp;
  });

  return {
    items: combined.slice(skip, skip + limit),
    meta: paginationMeta(total, { page, limit }),
  };
}

export async function getReportBill(id, userId) {
  const rb = await ReportBill.findOne({ _id: id, createdBy: userId }).lean();
  if (rb) return unifiedFromReportBill(rb, { includeExtraction: true });
  const sale = await Sale.findOne({ _id: id, createdBy: userId }).lean();
  if (sale) return unifiedFromSale(sale, { includeExtraction: true });
  const purchase = await Purchase.findOne({ _id: id, createdBy: userId })
    .populate("supplierId", "name gstNumber")
    .lean();
  if (purchase) return unifiedFromPurchase(purchase, { includeExtraction: true });
  throw ApiError.notFound("Bill not found");
}

export async function createReportBill({ data = {}, userId, userName, orgName = "" }) {
  validateReportBillInput(data);
  const doc = buildReportBillDoc(data);
  const invoiceDate = doc.invoice?.invoiceDate ?? new Date();
  await assertNoDuplicateReportBill(userId, doc.invoice?.invoiceNumber || "", invoiceDate);

  const rb = await ReportBill.create({
    ...doc,
    extraction: sanitizeExtraction(data.extraction),
    orgName: String(orgName ?? "").trim(),
    createdBy: userId,
    createdByName: userName || "Staff",
    createdAt: invoiceDate,
  });
  const result = unifiedFromReportBill(rb.toObject(), { includeExtraction: true });

  // Best-effort WhatsApp delivery AFTER the bill is safely persisted. The bill
  // survives every delivery outcome (skipped, failed or sent).
  if (isSalesBill(rb.toObject())) {
    const delivery = await deliverBillToWhatsApp({
      bill: rb.toObject(),
      user: { _id: userId, orgName: String(orgName ?? "").trim() },
    });
    result.whatsapp = delivery;
  }

  return result;
}

async function updateReportBillDoc(id, existing, { data, userId, userName }) {
  const patch = {};
  const mode = pickReportBillMode(existing.documentType);

  const wantsIdentity =
    data.invoiceNo !== undefined ||
    data.orderNo !== undefined ||
    data.invoice?.invoiceNumber !== undefined ||
    data.invoiceDate !== undefined ||
    data.invoice?.invoiceDate !== undefined ||
    data.billDate !== undefined ||
    data.purchaseDate !== undefined;
  if (wantsIdentity) {
    const newNo = String(
      data.invoice?.invoiceNumber ??
        data.invoiceNo ??
        data.orderNo ??
        existing.invoice?.invoiceNumber ??
        "",
    ).trim();
    const newDate =
      parseReportBillDate(
        data.invoice?.invoiceDate ?? data.invoiceDate ?? data.billDate ?? data.purchaseDate,
      ) ??
      existing.invoice?.invoiceDate ??
      existing.createdAt;
    const changedNo =
      String(existing.invoice?.invoiceNumber ?? "").toLowerCase() !== newNo.toLowerCase();
    const changedDate =
      !existing.invoice?.invoiceDate ||
      new Date(existing.invoice?.invoiceDate).getTime() !== new Date(newDate).getTime();
    if (changedNo || changedDate) await assertNoDuplicateReportBill(userId, newNo, newDate, id);
    patch["invoice.invoiceNumber"] = newNo;
    patch["invoice.invoiceDate"] = newDate;
    patch.createdAt = newDate; // keep business date = createdAt semantics
  }

  if (data.items !== undefined) {
    validateReportBillInput({
      ...data,
      documentType: existing.documentType,
      invoiceNo: patch["invoice.invoiceNumber"] ?? existing.invoice?.invoiceNumber,
      invoiceDate: patch["invoice.invoiceDate"] ?? existing.invoice?.invoiceDate,
    });
    const totals = normalizeReportBillItems(data.items, mode);
    patch.items = totals.items;
    patch["totals.subtotal"] = totals.totals.subtotal;
    patch["totals.discountAmount"] = totals.totals.discountAmount;
    patch["totals.taxableAmount"] = totals.totals.taxableAmount;
    patch["totals.sgst"] = totals.totals.sgst;
    patch["totals.cgst"] = totals.totals.cgst;
    patch["totals.totalGst"] = totals.totals.totalGst;
    patch["totals.roundOff"] = totals.totals.roundOff;
    patch["totals.calculatedGrandTotal"] = totals.totals.calculatedGrandTotal;
  }

  if (data.printedGrandTotal !== undefined) {
    const printed =
      data.printedGrandTotal !== null && data.printedGrandTotal !== ""
        ? Number(data.printedGrandTotal)
        : null;
    const printedFinal =
      printed !== null && Number.isFinite(printed) && printed >= 0 ? round2(printed) : null;
    patch["totals.printedGrandTotal"] = printedFinal;
  }

  // Grand total follows the printed total when present, else the calculation.
  const currentPrinted =
    patch["totals.printedGrandTotal"] !== undefined
      ? patch["totals.printedGrandTotal"]
      : (existing.totals?.printedGrandTotal ?? null);
  const currentCalculated =
    patch["totals.calculatedGrandTotal"] !== undefined
      ? patch["totals.calculatedGrandTotal"]
      : (existing.totals?.calculatedGrandTotal ?? 0);
  patch["totals.grandTotal"] = currentPrinted ?? currentCalculated;

  if (
    data.supplierName !== undefined ||
    data.supplier !== undefined ||
    data.supplierPhone !== undefined
  ) {
    const supplierRaw = data.supplier ?? {};
    const supplierPhoneRaw = String(
      supplierRaw.phone ?? data.supplierPhone ?? existing.supplier?.phone ?? "",
    ).trim();
    patch["supplier.name"] = String(
      data.supplierName ?? supplierRaw.name ?? existing.supplier?.name ?? "",
    ).trim();
    patch["supplier.address"] = String(
      supplierRaw.address ?? existing.supplier?.address ?? "",
    ).trim();
    patch["supplier.gstin"] = String(
      supplierRaw.gstin ?? data.supplierGstin ?? existing.supplier?.gstin ?? "",
    ).trim();
    patch["supplier.phone"] = supplierPhoneRaw ? normalizeIndianPhone(supplierPhoneRaw) : "";
  }
  if (
    data.customerName !== undefined ||
    data.customer !== undefined ||
    data.customerPhone !== undefined
  ) {
    const customerRaw = data.customer ?? {};
    const customerPhoneRaw = String(
      data.customerPhone ?? customerRaw.phone ?? existing.customer?.phone ?? "",
    ).trim();
    patch["customer.name"] = String(
      data.customerName ?? customerRaw.name ?? existing.customer?.name ?? "",
    ).trim();
    patch["customer.gstin"] = String(
      data.customerGstin ?? customerRaw.gstin ?? existing.customer?.gstin ?? "",
    ).trim();
    patch["customer.phone"] = customerPhoneRaw ? normalizeIndianPhone(customerPhoneRaw) : "";
  }
  if (data.payment !== undefined || data.paymentMode !== undefined) {
    patch["payment.mode"] = String(
      data.payment?.mode ?? data.paymentMode ?? existing.payment?.mode ?? "Cash",
    ).trim();
  }
  if (data.payment !== undefined || data.paymentStatus !== undefined) {
    const status = String(
      data.payment?.status ?? data.paymentStatus ?? existing.payment?.status ?? "paid",
    )
      .trim()
      .toLowerCase();
    patch["payment.status"] = PAYMENT_STATUSES.includes(status) ? status : "paid";
  }
  if (data.documentType !== undefined && data.documentType !== existing.documentType) {
    const dt = REPORT_BILL_DOCUMENT_TYPES.includes(String(data.documentType).trim())
      ? String(data.documentType).trim()
      : existing.documentType;
    if (dt !== existing.documentType) {
      patch.documentType = dt;
      patch.status = resolveReportBillStatus(dt);
    }
  }
  if (data.source !== undefined && BILL_SOURCES.includes(String(data.source).trim())) {
    patch.source = String(data.source).trim();
  }
  if (data.originalDocument !== undefined || data.uploadedFile !== undefined) {
    patch.originalDocument = data.originalDocument ?? data.uploadedFile ?? null;
  }
  if (data.notes !== undefined) patch.notes = String(data.notes).trim();
  if (data.extraction !== undefined) patch.extraction = sanitizeExtraction(data.extraction);
  if (userName) patch.createdByName = userName;

  const doc = await ReportBill.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
  return unifiedFromReportBill(doc, { includeExtraction: true });
}

export async function updateReportBill({ id, userId, data = {}, userName }) {
  const existing = await ReportBill.findOne({ _id: id, createdBy: userId }).lean();
  if (existing) return updateReportBillDoc(id, existing, { data, userId, userName });

  const sale = await Sale.findOne({ _id: id, createdBy: userId }).lean();
  if (sale) {
    const updated = await updateSalesBill({ id, userId, data: unifiedToSaleInput(data), userName });
    return unifiedFromSale(updated);
  }

  const purchase = await Purchase.findOne({ _id: id, createdBy: userId }).lean();
  if (purchase) {
    const updated = await updatePurchase({
      id,
      userId,
      data: unifiedToPurchaseInput(data),
      userName,
    });
    return unifiedFromPurchase(updated);
  }

  throw ApiError.notFound("Bill not found");
}

export async function deleteReportBill(id, userId) {
  const rb = await ReportBill.findOneAndDelete({ _id: id, createdBy: userId }).lean();
  if (rb) return unifiedFromReportBill(rb);
  const sale = await Sale.findOneAndDelete({ _id: id, createdBy: userId }).lean();
  if (sale) return unifiedFromSale(sale);
  const purchase = await Purchase.findOneAndDelete({ _id: id, createdBy: userId }).lean();
  if (purchase) return unifiedFromPurchase(purchase);
  throw ApiError.notFound("Bill not found");
}

export async function getReportBillsSummary(userId) {
  const group = (valuePath) => ({
    $group: {
      _id: null,
      total: { $sum: 1 },
      uploaded: { $sum: { $cond: [{ $eq: ["$source", "uploaded"] }, 1, 0] } },
      manual: { $sum: { $cond: [{ $eq: ["$source", "manual"] }, 1, 0] } },
      value: { $sum: { $ifNull: [valuePath, 0] } },
    },
  });
  const [rbRows, saleRows, purchaseRows] = await Promise.all([
    ReportBill.aggregate([{ $match: { createdBy: userId } }, group("$totals.grandTotal")]),
    Sale.aggregate([{ $match: { createdBy: userId, status: "completed" } }, group("$grandTotal")]),
    Purchase.aggregate([{ $match: { createdBy: userId } }, group("$grandTotal")]),
  ]);

  const total = { total: 0, uploaded: 0, manual: 0, value: 0 };
  for (const rows of [rbRows, saleRows, purchaseRows]) {
    const r = rows[0];
    if (!r) continue;
    total.total += r.total;
    total.uploaded += r.uploaded;
    total.manual += r.manual;
    total.value += r.value;
  }
  return {
    total: total.total,
    uploaded: total.uploaded,
    manual: total.manual,
    totalValue: round2(total.value),
  };
}
