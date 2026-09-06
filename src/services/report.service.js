import { Batch } from "../models/Batch.js";
import { Sale } from "../models/Sale.js";
import { Purchase } from "../models/Purchase.js";
import { Medicine } from "../models/Medicine.js";
import {
  ReportBill,
  REPORT_BILL_SALES_TYPES,
  REPORT_BILL_PURCHASE_TYPES,
} from "../models/ReportBill.js";

import { AuditLog } from "../models/AuditLog.js";
import { SavedReport } from "../models/SavedReport.js";
import { ScheduledReport } from "../models/ScheduledReport.js";

import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const sumItems = (r, key) => (r.items || []).reduce((acc, i) => acc + (Number(i[key]) || 0), 0);

// Throws a clean 400 when a query/body date is present but not parseable, so
// invalid ranges never silently expand to an unbounded window.
const parseDateParam = (value, name) => {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw ApiError.badRequest(`Invalid "${name}" value — expected a valid date.`);
  }
  return d;
};

export async function salesReport({ from, to, groupBy = "day" }, userId = null) {
  const match = {};
  if (userId) match.createdBy = userId;
  if (from || to) {
    const fromDate = parseDateParam(from, "from");
    const toDate = parseDateParam(to, "to");
    match.createdAt = {};
    if (fromDate) match.createdAt.$gte = startOfDay(fromDate);
    if (toDate) match.createdAt.$lte = endOfDay(toDate);
  }
  const sales = await Sale.find({ ...match, status: "completed" })
    .sort({ createdAt: 1 })
    .lean();

  const buckets = new Map();
  const keyOf =
    {
      day: (d) => d.toISOString().slice(0, 10),
      month: (d) => d.toISOString().slice(0, 7),
      year: (d) => String(d.getUTCFullYear()),
    }[groupBy] ?? ((d) => d.toISOString().slice(0, 10));

  for (const s of sales) {
    const key = keyOf(new Date(s.createdAt));
    const bucket = buckets.get(key) ?? {
      period: key,
      invoices: 0,
      units: 0,
      sales: 0,
      gst: 0,
      items: 0,
    };
    bucket.invoices += 1;
    bucket.units += s.items.reduce((acc, i) => acc + (i.quantity || 0), 0);
    bucket.sales += s.grandTotal || 0;
    bucket.gst += s.gstTotal || 0;
    bucket.items += s.items.length;
    buckets.set(key, bucket);
  }

  return {
    from,
    to,
    groupBy,
    summary: {
      totalSales: sales.reduce((s, x) => s + (x.grandTotal || 0), 0),
      totalInvoices: sales.length,
      totalUnits: sales.reduce((s, x) => s + x.items.reduce((a, i) => a + (i.quantity || 0), 0), 0),
      totalGst: sales.reduce((s, x) => s + (x.gstTotal || 0), 0),
    },
    series: [...buckets.values()],
  };
}

export async function purchaseReport({ from, to }, userId = null) {
  const match = {};
  if (userId) match.createdBy = userId;
  if (from || to) {
    const fromDate = parseDateParam(from, "from");
    const toDate = parseDateParam(to, "to");
    match.createdAt = {};
    if (fromDate) match.createdAt.$gte = startOfDay(fromDate);
    if (toDate) match.createdAt.$lte = endOfDay(toDate);
  }
  const purchases = await Purchase.find(match)
    .populate("supplierId", "name")
    .sort({ createdAt: 1 })
    .lean();
  return {
    summary: {
      totalSpend: purchases.reduce((s, x) => s + (x.grandTotal || 0), 0),
      totalOrders: purchases.length,
      received: purchases.filter((p) => p.status === "received").length,
    },
    records: purchases,
  };
}

export async function expiryReport(days = 90) {
  const horizon = Number.isFinite(days) && days > 0 ? days : 90;
  const cutoff = new Date(Date.now() + horizon * 24 * 60 * 60 * 1000);
  const expired = await Batch.find({ expiryDate: { $lt: new Date() } })
    .populate("medicineId", "name genericName brandName")
    .lean();
  const expiring = await Batch.find({ expiryDate: { $gte: new Date(), $lte: cutoff } })
    .populate("medicineId", "name genericName brandName")
    .sort({ expiryDate: 1 })
    .lean();
  return {
    days: horizon,
    summary: {
      expiredCount: expired.length,
      expiredValue: expired.reduce((s, b) => s + (b.currentStock ?? 0) * (b.purchasePrice ?? 0), 0),
      expiringCount: expiring.length,
    },
    expired,
    expiring,
  };
}

export async function stockValuationReport() {
  const batches = await Batch.find({ currentStock: { $gt: 0 } })
    .populate("medicineId", "name genericName brandName")
    .lean();
  const byStatus = { active: 0, near_expiry: 0, expired: 0, quarantined: 0 };
  let totalValue = 0;
  let totalUnits = 0;
  for (const b of batches) {
    const value = (b.currentStock ?? 0) * (b.purchasePrice ?? 0);
    totalValue += value;
    totalUnits += b.currentStock ?? 0;
    byStatus[b.status] = (byStatus[b.status] ?? 0) + value;
  }
  return {
    summary: { totalUnits, totalValue, byStatus },
    batches,
  };
}

/* ---------------------------------------------------------------------
   Dynamic Custom Report Engine
   ---------------------------------------------------------------------
   Whitelist-based: every field/measure a client may group, filter, or
   aggregate by is defined below and mapped to REAL persisted fields.
   Anything else is rejected with a 400. User input is never passed into
   MongoDB operators, which eliminates query injection.
   --------------------------------------------------------------------- */

const SALES_POPULATE = [
  {
    path: "items.medicineId",
    select: "name hsnCode gstRate categoryId",
    populate: { path: "categoryId", select: "name" },
  },
];

async function loadSalesCosts(rawRecords) {
  const ids = new Set();
  for (const s of rawRecords) {
    for (const it of s.items || []) {
      if (it.batchId) ids.add(String(it.batchId));
    }
  }
  const map = new Map();
  if (ids.size === 0) return map;
  const batches = await Batch.find({ _id: { $in: [...ids] } })
    .select("purchasePrice")
    .lean();
  for (const b of batches) map.set(String(b._id), Number(b.purchasePrice) || 0);
  return map;
}

// Report Data's "reportbills" collection stores its business date on
// invoice.invoiceDate rather than createdAt, so the engine translates the
// module's date-range match onto that field (ownership scope is preserved).
async function loadReportBills(match, dateField, documentTypes) {
  const rbMatch = {};
  if (match.createdBy) rbMatch.createdBy = match.createdBy;
  if (documentTypes && documentTypes.length) rbMatch.documentType = { $in: documentTypes };
  const range = match[dateField];
  if (range && typeof range === "object") rbMatch["invoice.invoiceDate"] = range;
  return ReportBill.find(rbMatch).sort({ createdAt: -1 }).lean();
}

// Normalizes a ReportBill to the shape the sales-side modules expect, so they
// consume uploaded/manual report bills exactly like POS sales.
function reportBillToSale(rb) {
  const t = rb.totals ?? {};
  return {
    _id: rb._id,
    invoiceNo: rb.invoice?.invoiceNumber || "",
    customerName: rb.customer?.name || "",
    customerPhone: rb.customer?.phone || "",
    items: (rb.items || []).map((it) => ({
      medicineId: it.medicineId ?? null,
      batchId: it.batchId ?? null,
      medicineName: it.medicineName || "",
      quantity: it.quantity ?? 0,
      unitPrice: it.unitPrice ?? it.unitCost ?? 0,
      discountPct: it.discountPct ?? 0,
      gstRate: it.gstRate ?? 0,
      sgstRate: it.sgstRate ?? 0,
      cgstRate: it.cgstRate ?? 0,
      taxableAmount: it.taxableAmount ?? 0,
      gstAmount: it.gstAmount ?? 0,
      lineTotal: it.lineTotal ?? 0,
      batchNumber: it.batchNumber || "",
      hsnCode: it.hsnCode || "",
    })),
    subtotal: t.subtotal ?? 0,
    discountTotal: t.discountAmount ?? 0,
    taxableAmount: t.taxableAmount ?? 0,
    gstTotal: t.totalGst ?? 0,
    roundOff: t.roundOff ?? 0,
    grandTotal: t.grandTotal ?? 0,
    paymentMode: rb.payment?.mode || "Cash",
    paymentStatus: rb.payment?.status || "paid",
    status: "completed",
    source: rb.source || "manual",
    createdAt: rb.createdAt,
    createdByName: rb.createdByName || "Staff",
  };
}

// Same for the purchase-side modules.
function reportBillToPurchase(rb) {
  const t = rb.totals ?? {};
  return {
    _id: rb._id,
    orderNo: rb.invoice?.invoiceNumber || "",
    supplierId: null,
    supplierName: rb.supplier?.name || "",
    party: { name: rb.supplier?.name || "", gstin: rb.supplier?.gstin || "" },
    items: (rb.items || []).map((it) => ({
      medicineName: it.medicineName || "",
      quantity: it.quantity ?? 0,
      freeQuantity: it.freeQuantity ?? 0,
      unitCost: it.unitCost ?? it.unitPrice ?? 0,
      mrp: it.mrp ?? 0,
      discountPct: it.discountPct ?? 0,
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
    })),
    subtotal: t.subtotal ?? 0,
    discount: t.discountAmount ?? 0,
    taxableAmount: t.taxableAmount ?? 0,
    totalSGST: t.sgst ?? 0,
    totalCGST: t.cgst ?? 0,
    gstTotal: t.totalGst ?? 0,
    printedGrandTotal: t.printedGrandTotal ?? null,
    calculatedGrandTotal: t.calculatedGrandTotal ?? null,
    roundOff: t.roundOff ?? 0,
    grandTotal: t.grandTotal ?? 0,
    documentType: rb.documentType || "purchase_invoice",
    status: "received",
    source: rb.source || "manual",
    createdAt: rb.createdAt,
    createdByName: rb.createdByName || "Staff",
  };
}

async function loadMedicineStock() {
  const rows = await Batch.aggregate([
    { $match: { medicineId: { $ne: null }, currentStock: { $gt: 0 } } },
    {
      $group: {
        _id: "$medicineId",
        qty: { $sum: "$currentStock" },
        value: { $sum: { $multiply: ["$currentStock", { $ifNull: ["$purchasePrice", 0] }] } },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { qty: r.qty, value: r.value });
  return map;
}

async function loadMedicineSales() {
  const rows = await Sale.aggregate([
    { $match: { status: "completed", "items.0": { $exists: true } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.medicineId",
        qty: { $sum: "$items.quantity" },
        value: { $sum: { $ifNull: ["$items.lineTotal", 0] } },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { qty: r.qty, value: r.value });
  return map;
}

// Sales-side modules (sales / payments / customers) union POS sales with the
// Report Data "reportbills" collection (sales-type documents). Costs are loaded
// across both so profit reports stay accurate for uploaded bills.
async function loadSalesUnion(match) {
  const [sales, rb] = await Promise.all([
    Sale.find(match).populate(SALES_POPULATE).sort({ createdAt: -1 }).lean(),
    loadReportBills(match, "createdAt", REPORT_BILL_SALES_TYPES),
  ]);
  const reportBills = rb.map(reportBillToSale);
  const rawRecords = [...sales, ...reportBills];
  return { rawRecords, enrich: { costs: await loadSalesCosts(rawRecords) } };
}

// Purchase-side modules (purchases / suppliers) union POS purchases with the
// "reportbills" collection (purchase-type documents).
async function loadPurchaseUnion(match) {
  const [purchases, rb] = await Promise.all([
    Purchase.find(match)
      .populate([{ path: "supplierId", select: "name gstNumber" }])
      .sort({ createdAt: -1 })
      .lean(),
    loadReportBills(match, "createdAt", REPORT_BILL_PURCHASE_TYPES),
  ]);
  return { rawRecords: [...purchases, ...rb.map(reportBillToPurchase)], enrich: {} };
}

function salesBase() {
  return {
    model: Sale,
    dateField: "createdAt",
    populate: SALES_POPULATE,
    enrich: { costs: loadSalesCosts },
    load: loadSalesUnion,
    ownerScoped: true,
  };
}

const MODULE_CONFIGS = {
  sales: {
    ...salesBase(),
    fields: {
      staff: (r) => r.createdByName || "Staff",
      customer: (r) => r.customerName || "Walk-in Customer",
      customerPhone: (r) => r.customerPhone || "N/A",
      medicine: (r) => r.items?.[0]?.medicineId?.name || r.items?.[0]?.medicineName || "Medicine",
      batch: (r) => r.items?.[0]?.batchNumber || "N/A",
      category: (r) => r.items?.[0]?.medicineId?.categoryId?.name || "General",
      invoice: (r) => r.invoiceNo || String(r._id),
      billDate: (r) => r.createdAt,
      date: (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "N/A"),
      paymentMode: (r) => r.paymentMode || "Cash",
      paymentStatus: (r) => r.paymentStatus || "paid",
      source: (r) => r.source || "existing",
      hsnCode: (r) => r.items?.[0]?.medicineId?.hsnCode || "N/A",
    },
    measures: {
      netSales: (r) => r.grandTotal ?? 0,
      grossSales: (r) => r.subtotal ?? r.grandTotal ?? 0,
      subtotal: (r) => r.subtotal ?? 0,
      taxableAmount: (r) => r.taxableAmount ?? (r.subtotal ?? 0) - (r.discountTotal ?? 0),
      grandTotal: (r) => r.grandTotal ?? 0,
      gstAmount: (r) => r.gstTotal ?? 0,
      quantity: (r) => sumItems(r, "quantity"),
      unitPrice: (r) => sumItems(r, "unitPrice"),
      discount: (r) => r.discountTotal ?? 0,
      gst: (r) => r.gstTotal ?? 0,
      profit: (r, ctx) => {
        const total = r.grandTotal ?? 0;
        let cost = 0;
        for (const it of r.items || []) {
          cost += (ctx.costs.get(String(it.batchId)) ?? 0) * (it.quantity || 0);
        }
        return round2(total - cost);
      },
    },
  },
  gst: {
    model: Sale,
    dateField: "createdAt",
    populate: SALES_POPULATE,
    ownerScoped: true,
    // GST covers both what we collected on sales and what we paid on
    // purchased invoices (uploaded documents appear here too). Union all
    // collections under the same owner/date scope and tag each record with
    // its source so reports can be broken down by transaction type. Report
    // Data bills are partitioned: sales-type records join the sales side,
    // purchase-type records join the purchases side (each bill once).
    load: async (match) => {
      const [sales, rbSales, purchases, rbPurchases] = await Promise.all([
        Sale.find({ ...match, status: "completed" })
          .populate(SALES_POPULATE)
          .sort({ createdAt: -1 })
          .lean(),
        loadReportBills(match, "createdAt", REPORT_BILL_SALES_TYPES),
        Purchase.find({ ...match, status: "received" })
          .populate([{ path: "supplierId", select: "name gstNumber" }])
          .sort({ createdAt: -1 })
          .lean(),
        loadReportBills(match, "createdAt", REPORT_BILL_PURCHASE_TYPES),
      ]);
      const rawRecords = [
        ...sales,
        ...rbSales.map(reportBillToSale),
        ...purchases,
        ...rbPurchases.map(reportBillToPurchase),
      ];
      return { rawRecords, enrich: {} };
    },
    fields: {
      gstSlab: (r) => {
        const it = r.items?.[0];
        if (!it) return 0;
        return (
          it.gstRate ||
          (Number(it.sgstRate) || 0) + (Number(it.cgstRate) || 0) ||
          it.medicineId?.gstRate ||
          0
        );
      },
      hsnCode: (r) => r.items?.[0]?.medicineId?.hsnCode || r.items?.[0]?.hsnCode || "N/A",
      customer: (r) => r.customerName || "N/A",
      supplier: (r) => r.supplierId?.name || r.supplierName || "N/A",
      supplierGstin: (r) => r.supplierId?.gstNumber || r.party?.gstin || "N/A",
      invoice: (r) => r.invoiceNo || r.orderNo || String(r._id),
      billDate: (r) => r.createdAt,
      date: (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "N/A"),
      source: (r) => r.source || "existing",
      documentType: (r) => r.documentType || "sales_invoice",
      paymentMode: (r) => r.paymentMode || "Credit",
    },
    measures: {
      taxableAmount: (r) =>
        r.taxableAmount ?? (r.subtotal ?? 0) - (r.discountTotal ?? r.discount ?? 0),
      gstAmount: (r) => r.gstTotal ?? 0,
      totalSGST: (r) => r.totalSGST ?? round2((r.gstTotal ?? 0) / 2),
      totalCGST: (r) => r.totalCGST ?? round2((r.gstTotal ?? 0) / 2),
      netSales: (r) => r.grandTotal ?? 0,
      grossSales: (r) => r.subtotal ?? r.grandTotal ?? 0,
      discount: (r) => r.discountTotal ?? r.discount ?? 0,
      invoiceCount: () => 1,
    },
  },
  payments: {
    ...salesBase(),
    fields: {
      paymentMode: (r) => r.paymentMode || "Cash",
      customer: (r) => r.customerName || "Walk-in Customer",
      medicine: (r) => r.items?.[0]?.medicineId?.name || r.items?.[0]?.medicineName || "Medicine",
      billDate: (r) => r.createdAt,
      invoice: (r) => r.invoiceNo || String(r._id),
    },
    measures: {
      collectedAmount: (r) => r.grandTotal ?? 0,
      transactionCount: () => 1,
      netSales: (r) => r.grandTotal ?? 0,
    },
  },
  customers: {
    ...salesBase(),
    fields: {
      customer: (r) => r.customerName || "Walk-in Customer",
      city: () => "Local",
      customerType: () => "Retail",
      purchaseDate: (r) => r.createdAt,
    },
    measures: {
      purchaseAmount: (r) => r.grandTotal ?? 0,
      invoiceCount: () => 1,
      netSales: (r) => r.grandTotal ?? 0,
    },
  },
  purchases: {
    model: Purchase,
    dateField: "createdAt",
    populate: [{ path: "supplierId", select: "name gstNumber" }],
    load: loadPurchaseUnion,
    ownerScoped: true,
    fields: {
      supplier: (r) => r.supplierId?.name || r.supplierName || "Supplier",
      supplierGstin: (r) => r.supplierId?.gstNumber || r.party?.gstin || "N/A",
      medicine: (r) => r.items?.[0]?.medicineName || "Medicine",
      category: () => "General",
      invoice: (r) => r.orderNo || String(r._id),
      purchaseDate: (r) => r.createdAt,
      date: (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "N/A"),
      paymentMode: () => "Credit",
      batch: (r) => r.items?.[0]?.batchNumber || "N/A",
      batchNumber: (r) => r.items?.[0]?.batchNumber || "N/A",
      hsnCode: (r) => r.items?.[0]?.hsnCode || "N/A",
      pack: (r) => r.items?.[0]?.pack || "N/A",
      manufacturer: (r) => r.items?.[0]?.manufacturer || "N/A",
      expiryDate: (r) => r.items?.[0]?.expiryDate ?? null,
      source: (r) => r.source || "existing",
      documentType: (r) => r.documentType || "purchase_invoice",
    },
    measures: {
      purchaseAmount: (r) => r.grandTotal ?? 0,
      purchaseQty: (r) => sumItems(r, "quantity"),
      quantity: (r) => sumItems(r, "quantity"),
      purchaseGst: (r) => r.gstTotal ?? 0,
      totalGst: (r) => r.gstTotal ?? 0,
      taxableAmount: (r) => r.taxableAmount ?? (r.subtotal ?? 0) - (r.discount ?? 0),
      totalSGST: (r) => r.totalSGST ?? 0,
      totalCGST: (r) => r.totalCGST ?? 0,
      subtotal: (r) => r.subtotal ?? 0,
      discount: (r) => r.discount ?? 0,
    },
  },
  suppliers: {
    model: Purchase,
    dateField: "createdAt",
    populate: [{ path: "supplierId", select: "name" }],
    load: loadPurchaseUnion,
    ownerScoped: true,
    fields: {
      supplier: (r) => r.supplierId?.name || r.supplierName || "Supplier",
      supplierGstin: (r) => r.supplierId?.gstNumber || r.party?.gstin || "N/A",
      city: () => "Local",
      medicine: (r) => r.items?.[0]?.medicineName || "Medicine",
      purchaseDate: (r) => r.createdAt,
    },
    measures: {
      purchaseAmount: (r) => r.grandTotal ?? 0,
      purchaseQty: (r) => sumItems(r, "quantity"),
      purchaseGst: (r) => r.gstTotal ?? 0,
      taxableAmount: (r) => r.taxableAmount ?? (r.subtotal ?? 0) - (r.discount ?? 0),
      totalSGST: (r) => r.totalSGST ?? 0,
      totalCGST: (r) => r.totalCGST ?? 0,
    },
  },
  inventory: {
    model: Batch,
    dateField: "createdAt",
    populate: [
      {
        path: "medicineId",
        select: "name reorderThreshold categoryId",
        populate: { path: "categoryId", select: "name" },
      },
      { path: "supplierId", select: "name" },
    ],
    fields: {
      medicine: (r) => r.medicineId?.name || r.medicineName || "Medicine",
      batch: (r) => r.batchNumber || String(r._id),
      category: (r) => r.medicineId?.categoryId?.name || "General",
      supplier: (r) => r.supplierId?.name || "Unknown",
      expiryDate: (r) => r.expiryDate,
      stockStatus: (r) => {
        const qty = r.currentStock || 0;
        if (qty === 0) return "Out of Stock";
        if (qty < (r.medicineId?.reorderThreshold ?? 0)) return "Low Stock";
        return "In Stock";
      },
    },
    measures: {
      stockQty: (r) => r.currentStock ?? 0,
      stockValue: (r) => round2((r.currentStock ?? 0) * (r.purchasePrice ?? 0)),
    },
  },
  expiry: {
    model: Batch,
    dateField: "expiryDate",
    populate: [
      {
        path: "medicineId",
        select: "name reorderThreshold categoryId",
        populate: { path: "categoryId", select: "name" },
      },
      { path: "supplierId", select: "name" },
    ],
    fields: {
      medicine: (r) => r.medicineId?.name || r.medicineName || "Medicine",
      batch: (r) => r.batchNumber || String(r._id),
      expiryDate: (r) => r.expiryDate,
      category: (r) => r.medicineId?.categoryId?.name || "General",
      supplier: (r) => r.supplierId?.name || "Unknown",
    },
    measures: {
      expiringQty: (r) => (r.status === "near_expiry" ? (r.currentStock ?? 0) : 0),
      stockQty: (r) => r.currentStock ?? 0,
      stockValue: (r) => round2((r.currentStock ?? 0) * (r.purchasePrice ?? 0)),
    },
  },
  medicines: {
    model: Medicine,
    dateField: "createdAt",
    populate: [{ path: "categoryId", select: "name" }],
    enrich: { stock: loadMedicineStock, sales: loadMedicineSales },
    fields: {
      medicine: (r) => r.name || "Medicine",
      category: (r) => r.categoryId?.name || "General",
      hsnCode: (r) => r.hsnCode || "N/A",
      stockStatus: (r, ctx) => {
        const qty = ctx.stock.get(String(r._id))?.qty ?? 0;
        if (qty === 0) return "Out of Stock";
        if (qty < (r.reorderThreshold ?? 0)) return "Low Stock";
        return "In Stock";
      },
    },
    measures: {
      stockQty: (r, ctx) => ctx.stock.get(String(r._id))?.qty ?? 0,
      stockValue: (r, ctx) => round2(ctx.stock.get(String(r._id))?.value ?? 0),
      saleQty: (r, ctx) => ctx.sales.get(String(r._id))?.qty ?? 0,
      saleValue: (r, ctx) => round2(ctx.sales.get(String(r._id))?.value ?? 0),
    },
  },
  audit: {
    model: AuditLog,
    dateField: "createdAt",
    fields: {
      actionType: (r) => r.action || "Log",
      staff: (r) => r.userName || "User",
      medicine: () => "N/A",
      transactionId: (r) => String(r._id),
      billDate: (r) => r.createdAt,
    },
    measures: {
      movementCount: (r) => (/movement|stock|sale|purchase/i.test(r.action || "") ? 1 : 0),
      adjustmentCount: (r) => (/adjust|correct|manual|audit/i.test(r.action || "") ? 1 : 0),
      quantity: () => 0,
    },
  },
};

const ALLOWED_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "less_than",
  "between",
  "in",
]);
const ALLOWED_AGGS = new Set(["SUM", "COUNT", "AVG", "MIN", "MAX"]);

function applyFilters(record, filters) {
  for (const f of filters || []) {
    if (!f.field || f.value === undefined || f.value === null || f.value === "") continue;
    const raw = record[f.field];
    if (raw === undefined || raw === null) continue;

    // Date-typed fields (e.g. billDate / expiryDate) compare against the
    // ISO day of the supplied value, which is what the UI's FilterBuilder
    // expects, instead of a locale string.
    if (raw instanceof Date) {
      const day = raw.toISOString().slice(0, 10);
      const ts = raw.getTime();
      const rawString = String(raw).toLowerCase();
      const target = String(f.value).toLowerCase();
      switch (f.operator) {
        case "equals":
          if (day !== target.slice(0, 10)) return false;
          break;
        case "not_equals":
          if (day === target.slice(0, 10)) return false;
          break;
        case "contains":
          if (!rawString.includes(target)) return false;
          break;
        case "greater_than": {
          const t = new Date(f.value).getTime();
          if (!Number.isNaN(t) && ts <= t) return false;
          break;
        }
        case "less_than": {
          const t = new Date(f.value).getTime();
          if (!Number.isNaN(t) && ts >= t) return false;
          break;
        }
        case "between": {
          const [lo, hi] = String(f.value)
            .split(",")
            .map((v) => new Date(v.trim()));
          if (!Number.isNaN(lo.getTime()) && ts < lo.getTime()) return false;
          // The upper bound is inclusive — a "10th–11th" range must include
          // the whole of the 11th, not just its start of day.
          if (!Number.isNaN(hi.getTime()) && ts > endOfDay(hi).getTime()) return false;
          break;
        }
        default:
          break;
      }
      continue;
    }

    const a = String(raw).toLowerCase();
    const b = String(f.value).toLowerCase();
    const num = Number(raw);
    const isNumeric = raw !== "" && !Number.isNaN(num);
    switch (f.operator) {
      case "equals":
        if (a !== b) return false;
        break;
      case "not_equals":
        if (a === b) return false;
        break;
      case "contains":
        if (!a.includes(b)) return false;
        break;
      case "in": {
        const parts = String(f.value)
          .split(",")
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean);
        if (parts.length > 0 && !parts.includes(a)) return false;
        break;
      }
      case "greater_than":
        if (!isNumeric || !(num > Number(f.value))) return false;
        break;
      case "less_than":
        if (!isNumeric || !(num < Number(f.value))) return false;
        break;
      case "between": {
        const [lo, hi] = String(f.value)
          .split(",")
          .map((v) => Number(v.trim()));
        if (!Number.isNaN(lo) && !(num >= lo)) return false;
        if (!Number.isNaN(hi) && !(num <= hi)) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

async function loadModuleData(config, match) {
  // A custom loader lets a module union records across collections (e.g. GST
  // reads both Sales and Purchases) while still honoring the same match /
  // date-range / owner-scope filters the rest of the engine applies.
  if (config.load) {
    const result = await config.load(match);
    return { rawRecords: result.rawRecords ?? [], enrich: result.enrich ?? {} };
  }

  const query = config.model.find(match);
  for (const p of config.populate ?? []) query.populate(p);
  const rawRecords = await query.sort({ [config.dateField]: -1 }).lean();

  const enrich = {};
  for (const [key, loader] of Object.entries(config.enrich ?? {})) {
    enrich[key] = await loader(rawRecords);
  }
  return { rawRecords, enrich };
}

export async function customReport(payload = {}, userId = null) {
  const {
    module,
    selectedFields = [],
    groupBy = [],
    summarizeBy = [],
    filters = [],
    dateFrom,
    dateTo,
  } = payload;

  const config = MODULE_CONFIGS[module];
  if (!config) throw ApiError.badRequest(`Unsupported report module: "${module}"`);
  if (config.ownerScoped && !userId) {
    throw ApiError.badRequest(`Module "${module}" requires a signed-in owner`);
  }

  // Every requested grouping field must exist in the module whitelist. Unlike
  // the single-primary-group behaviour, ALL selected fields are grouped on so
  // the returned rows match every column the UI renders.
  const groupKeys =
    Array.isArray(groupBy) && groupBy.length
      ? groupBy
      : Array.isArray(selectedFields) && selectedFields.length
        ? selectedFields
        : [];
  for (const key of groupKeys) {
    if (typeof key !== "string" || !config.fields[key]) {
      throw ApiError.badRequest(`Unknown field "${String(key)}" for module "${module}"`);
    }
  }

  const measures = (Array.isArray(summarizeBy) ? summarizeBy : []).map((m) => {
    const fieldKey = typeof m === "string" ? m : m?.field;
    const agg = (typeof m === "string" ? "SUM" : m?.aggregation || "SUM").toUpperCase();
    if (!fieldKey || !config.measures[fieldKey]) {
      throw ApiError.badRequest(`Unknown measure "${fieldKey}" for module "${module}"`);
    }
    return { fieldKey, agg: ALLOWED_AGGS.has(agg) ? agg : "SUM" };
  });

  const activeFilters = (Array.isArray(filters) ? filters : []).filter(
    (f) => f.field && f.value !== undefined && f.value !== null && f.value !== "",
  );
  for (const f of activeFilters) {
    if (!config.fields[f.field] && !config.measures[f.field]) {
      throw ApiError.badRequest(`Unknown filter field "${f.field}" for module "${module}"`);
    }
    if (f.operator && !ALLOWED_OPERATORS.has(f.operator)) {
      throw ApiError.badRequest(`Unsupported filter operator "${f.operator}"`);
    }
  }

  // Measures referenced by filters are materialized on every record (in
  // addition to the requested aggregates) so numeric filters like
  // "grandTotal greater than X" work against real persisted values.
  const filterMeasureKeys = new Set(
    activeFilters.map((f) => (config.measures[f.field] ? f.field : null)).filter(Boolean),
  );

  // Date range is applied at the DB level against the module's real date field
  // only. Invalid dates get a clean 400 instead of an unbounded window, and an
  // inverted range is rejected outright. Owner-owned modules are scoped to the
  // signed-in user so uploaded/saved data never leaks across organizations.
  const match = {};
  if (config.ownerScoped && userId) match.createdBy = userId;
  const from = parseDateParam(dateFrom, "dateFrom");
  const to = parseDateParam(dateTo, "dateTo");
  if (from && to && from.getTime() > to.getTime()) {
    throw ApiError.badRequest("dateFrom cannot be later than dateTo");
  }
  if (from || to) {
    match[config.dateField] = {};
    if (from) match[config.dateField].$gte = startOfDay(from);
    if (to) match[config.dateField].$lte = endOfDay(to);
  }

  const { rawRecords, enrich } = await loadModuleData(config, match);

  // Normalize every record to the whitelisted virtual fields the UI expects.
  const normalizedRecords = rawRecords.map((r) => {
    const norm = {};
    for (const key of Object.keys(config.fields)) norm[key] = config.fields[key](r, enrich);
    for (const m of measures) norm[m.fieldKey] = config.measures[m.fieldKey](r, enrich);
    for (const key of filterMeasureKeys) norm[key] = config.measures[key](r, enrich);
    return norm;
  });

  const filtered = normalizedRecords.filter((rec) => applyFilters(rec, activeFilters));

  if (filtered.length === 0) {
    return {
      module,
      groupBy: groupKeys,
      summarizeBy: measures,
      rows: [],
      totals: {},
      totalRecords: 0,
      message: "No data found for the selected criteria.",
    };
  }

  const groups = new Map();
  for (const rec of filtered) {
    const key = groupKeys.length
      ? groupKeys.map((k) => String(rec[k] ?? "N/A")).join("\u0001")
      : "Total";
    if (!groups.has(key))
      groups.set(key, { values: groupKeys.map((k) => rec[k] ?? "N/A"), recs: [] });
    groups.get(key).recs.push(rec);
  }

  const rows = [];
  const totals = {};
  for (const { values, recs } of groups.values()) {
    const row = {};
    groupKeys.forEach((k, i) => {
      row[k] = values[i];
    });
    for (const { fieldKey, agg } of measures) {
      const vals = recs.map((r) => Number(r[fieldKey])).filter((v) => !Number.isNaN(v));
      let val = 0;
      if (agg === "COUNT") val = recs.length;
      else if (vals.length > 0) {
        if (agg === "SUM") val = vals.reduce((a, b) => a + b, 0);
        else if (agg === "AVG") val = vals.reduce((a, b) => a + b, 0) / vals.length;
        else if (agg === "MIN") val = Math.min(...vals);
        else if (agg === "MAX") val = Math.max(...vals);
      }
      row[fieldKey] = round2(val);
      totals[fieldKey] = round2((totals[fieldKey] || 0) + val);
    }
    rows.push(row);
  }

  return {
    module,
    groupBy: groupKeys,
    summarizeBy: measures,
    filters: activeFilters,
    dateFrom: from ? from.toISOString() : undefined,
    dateTo: to ? to.toISOString() : undefined,
    rows,
    totals,
    totalRecords: filtered.length,
  };
}

/* ---------------------------------------------------------------------
   Predefined Catalog
   --------------------------------------------------------------------- */

const FIELD_LABELS = {
  staff: "Staff",
  customer: "Customer",
  customerPhone: "Customer Phone",
  medicine: "Medicine",
  batch: "Batch",
  category: "Category",
  invoice: "Invoice",
  billDate: "Bill Date",
  date: "Date",
  purchaseDate: "Purchase Date",
  paymentMode: "Payment Method",
  paymentStatus: "Payment Status",
  source: "Source",
  hsnCode: "HSN Code",
  supplier: "Supplier",
  supplierGstin: "Supplier GSTIN",
  expiryDate: "Expiry Date",
  pack: "Pack",
  manufacturer: "Manufacturer",
  documentType: "Document Type",
  batchNumber: "Batch Number",
  city: "City",
  customerType: "Customer Type",
  stockStatus: "Stock Status",
  gstSlab: "GST Slab",
  actionType: "Action Type",
  transactionId: "Transaction ID",
};

const MEASURE_LABELS = {
  netSales: "Net Sale Amount",
  grossSales: "Gross Sale Amount",
  subtotal: "Subtotal",
  grandTotal: "Grand Total",
  quantity: "Quantity",
  unitPrice: "Unit Price",
  discount: "Discount",
  gst: "GST",
  profit: "Profit",
  taxableAmount: "Taxable Amount",
  gstAmount: "GST Amount",
  collectedAmount: "Collected Amount",
  transactionCount: "Transaction Count",
  purchaseAmount: "Purchase Amount",
  purchaseQty: "Purchase Quantity",
  purchaseGst: "Purchase GST",
  totalGst: "Total GST",
  totalSGST: "Total SGST",
  totalCGST: "Total CGST",
  stockQty: "Stock Quantity",
  stockValue: "Stock Value",
  expiringQty: "Expiring Quantity",
  saleQty: "Sale Quantity",
  saleValue: "Sale Value",
  movementCount: "Movement Count",
  adjustmentCount: "Adjustment Count",
  invoiceCount: "Invoice Count",
};

const DATE_FIELD_KEYS = new Set(["billDate", "purchaseDate", "expiryDate"]);

const MODULE_META = {
  sales: {
    name: "Sales & Returns",
    description: "Daily sales, revenue, discounts and GST with staff/customer breakdowns.",
    category: "Sales",
    dateField: "Bill Date",
    defaultDatePreset: "month",
  },
  gst: {
    name: "GST Report",
    description:
      "Taxable value and GST across sales and purchase invoices, per slab, HSN code, supplier or customer.",
    category: "GST",
    dateField: "Bill Date",
    defaultDatePreset: "month",
  },
  payments: {
    name: "Payments Report",
    description: "Amount collected per payment mode with invoice-level detail.",
    category: "Payments",
    dateField: "Bill Date",
    defaultDatePreset: "month",
  },
  customers: {
    name: "Customer Report",
    description: "Customer purchase behaviour — spend, invoices and frequency.",
    category: "Customers",
    dateField: "Purchase Date",
    defaultDatePreset: "month",
  },
  purchases: {
    name: "Purchase Report",
    description: "Procurement spend, quantities and GST per supplier or medicine.",
    category: "Purchases",
    dateField: "Purchase Date",
    defaultDatePreset: "month",
  },
  suppliers: {
    name: "Supplier Report",
    description: "Supplier-wise purchase totals across the selected period.",
    category: "Purchases",
    dateField: "Purchase Date",
    defaultDatePreset: "month",
  },
  inventory: {
    name: "Inventory Report",
    description: "Current stock quantity and valuation by medicine, batch or status.",
    category: "Inventory",
    dateField: "Batch Date",
    defaultDatePreset: "month",
  },
  expiry: {
    name: "Expiry Report",
    description: "Batches expiring within the window with quantity and value at risk.",
    category: "Inventory",
    dateField: "Expiry Date",
    defaultDatePreset: "next90",
  },
  medicines: {
    name: "Medicine Report",
    description: "Catalogue with live stock and sales performance per medicine.",
    category: "Medicines",
    dateField: "Bill Date",
    defaultDatePreset: "month",
  },
  audit: {
    name: "Audit Log Report",
    description: "User activity trail with action-type and staff breakdowns.",
    category: "Audit",
    dateField: "Bill Date",
    defaultDatePreset: "month",
  },
};

const STANDARD_ENDPOINTS = {
  sales: "/reports/sales",
  purchases: "/reports/purchases",
  expiry: "/reports/expiry",
  "stock-valuation": "/reports/stock-valuation",
};

export async function getReportCatalog() {
  const catalog = Object.entries(MODULE_META).map(([key, meta]) => ({
    id: key,
    key,
    name: meta.name,
    title: meta.name,
    description: meta.description,
    category: meta.category,
    type: "custom",
    endpoint: STANDARD_ENDPOINTS[key] ?? null,
    dateField: meta.dateField,
    defaultDatePreset: meta.defaultDatePreset,
    availableFields: Object.keys(MODULE_CONFIGS[key].fields).map((f) => ({
      key: f,
      label: FIELD_LABELS[f] ?? f,
      date: DATE_FIELD_KEYS.has(f),
    })),
    measures: Object.keys(MODULE_CONFIGS[key].measures).map((m) => ({
      key: m,
      label: MEASURE_LABELS[m] ?? m,
    })),
    filters: Object.keys(MODULE_CONFIGS[key].fields),
  }));

  if (!catalog.some((r) => r.key === "stock-valuation")) {
    catalog.push({
      id: "stock-valuation",
      key: "stock-valuation",
      name: "Stock Valuation",
      title: "Stock Valuation",
      description: "Total inventory valuation, batch counts and stock status metrics.",
      category: "Inventory",
      type: "standard",
      endpoint: STANDARD_ENDPOINTS["stock-valuation"],
      dateField: null,
      defaultDatePreset: null,
      availableFields: [],
      measures: [],
      filters: [],
    });
  }

  return catalog;
}

/* ---------------------------------------------------------------------
   Saved Reports (scoped to the owning user)
   --------------------------------------------------------------------- */

export function formatSavedReport(r) {
  return {
    id: r._id,
    name: r.name,
    module: r.module,
    reportType: r.reportType ?? "custom",
    fields: r.fields ?? r.groupBy ?? [],
    groupBy: r.groupBy ?? [],
    summarizeBy: (r.summarizeBy ?? []).map((m) => ({
      field: m.field,
      aggregation: m.aggregation ?? "SUM",
    })),
    // Stable per-filter ids so the builder can edit/re-apply saved filters
    // without React key collisions (FilterBuilder keys rows by filter.id).
    filters: (r.filters ?? []).map((f, i) => ({
      id: `f-${i + 1}`,
      field: f.field,
      operator: f.operator ?? "equals",
      value: f.value,
    })),
    dateConfig: r.dateConfig ?? {},
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// Coerce a loose client payload (ReportBuilder's save shape) into the exact
// persisted fields. Unknown keys (id, createdAt, etc.) are never persisted.
function buildSavedReportUpdate(data = {}) {
  const patch = {};
  if (data.name !== undefined) patch.name = String(data.name).trim();
  if (data.module !== undefined) patch.module = String(data.module).trim();
  if (data.reportType !== undefined) patch.reportType = String(data.reportType);
  const groupKeys = Array.isArray(data.groupBy)
    ? data.groupBy
    : Array.isArray(data.fields)
      ? data.fields
      : null;
  if (groupKeys !== null) patch.groupBy = groupKeys.filter((f) => typeof f === "string");
  if (data.summarizeBy !== undefined) {
    patch.summarizeBy = (Array.isArray(data.summarizeBy) ? data.summarizeBy : []).map((m) => ({
      field: typeof m === "string" ? m : m?.field,
      aggregation: (typeof m === "string" ? "SUM" : m?.aggregation || "SUM").toUpperCase(),
    }));
  }
  if (data.filters !== undefined) {
    patch.filters = (Array.isArray(data.filters) ? data.filters : []).map((f) => ({
      field: f?.field,
      operator: f?.operator ?? "equals",
      value: f?.value,
    }));
  }
  if (data.dateConfig && typeof data.dateConfig === "object") {
    patch.dateConfig = {
      presetId: data.dateConfig.presetId ?? "thisMonth",
      from: data.dateConfig.from || null,
      to: data.dateConfig.to || null,
    };
  }
  return patch;
}

export async function getSavedReports(userId) {
  const docs = await SavedReport.find({ createdBy: userId }).sort({ createdAt: -1 }).lean();
  return docs.map(formatSavedReport);
}

// The frontend sends the existing report id on re-save. When it is a valid
// ObjectId owned by this user, re-saving updates that report instead of
// creating a duplicate.
export async function createSavedReport(data, userId) {
  const patch = buildSavedReportUpdate(data);
  if (!patch.name || !patch.module) {
    throw ApiError.badRequest("Saved report requires a name and a report module.");
  }
  if (data?.id && mongoose.isValidObjectId(data.id)) {
    const existing = await SavedReport.findOne({ _id: data.id, createdBy: userId }).lean();
    if (existing) {
      const updated = await SavedReport.findByIdAndUpdate(
        data.id,
        { $set: patch },
        { new: true },
      ).lean();
      return formatSavedReport(updated);
    }
  }
  const doc = await SavedReport.create({ ...patch, createdBy: userId });
  return formatSavedReport(doc.toObject());
}

export async function updateSavedReport(id, userId, data) {
  const patch = buildSavedReportUpdate(data);
  const doc = await SavedReport.findOneAndUpdate(
    { _id: id, createdBy: userId },
    { $set: patch },
    { new: true },
  ).lean();
  if (!doc) throw ApiError.notFound("Saved report not found");
  return formatSavedReport(doc);
}

export async function deleteSavedReport(id, userId) {
  const doc = await SavedReport.findOneAndDelete({ _id: id, createdBy: userId });
  if (!doc) throw ApiError.notFound("Saved report not found");
  return doc;
}

/* ---------------------------------------------------------------------
   Scheduled Reports (scoped to the owning user)
   --------------------------------------------------------------------- */

export function formatScheduledReport(s) {
  return {
    id: s._id,
    reportName: s.reportName,
    savedReportId: s.savedReportId?._id ?? s.savedReportId ?? null,
    config: s.config ?? {},
    recipients: s.recipients ?? [],
    frequency: s.frequency ?? "daily",
    time: s.time ?? "09:00",
    status: s.status ?? "active",
    enabled: (s.status ?? "active") !== "paused",
    format: s.format ?? "csv",
    nextRunAt: s.nextRunAt ?? null,
    lastRunAt: s.lastRunAt ?? s.lastSentAt ?? null,
    lastSentAt: s.lastSentAt ?? null,
    lastError: s.lastError ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function computeNextRunAt({ frequency = "daily", time = "09:00" } = {}, now = new Date()) {
  const [h, m] = (time || "09:00").split(":").map(Number);
  const base = new Date(now);
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0, 0, 0);
  if (frequency === "weekly") {
    const daysUntilMonday = (8 - next.getDay()) % 7;
    next.setDate(next.getDate() + daysUntilMonday);
    if (next <= base) next.setDate(next.getDate() + 7);
  } else if (frequency === "monthly") {
    next.setMonth(next.getMonth() + 1, 1);
    if (next <= base) next.setMonth(next.getMonth() + 1, 1);
  } else {
    if (next <= base) next.setDate(next.getDate() + 1);
  }
  return next;
}

const VALID_FREQUENCIES = new Set(["daily", "weekly", "monthly"]);
const VALID_FORMATS = new Set(["csv"]);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
// Reserved TLDs that exist only for testing/demo (matches the acceptance
// criteria: @pharmahub.demo addresses are rejected at schedule creation).
const BLOCKED_TLDS = new Set(["demo", "test", "example", "invalid", "localhost", "local"]);

export function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  const [local, domain] = trimmed.split("@");
  if (!local || local.length > 64) return false;
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false;
  const tld = domain.split(".").pop().toLowerCase();
  if (!tld || BLOCKED_TLDS.has(tld)) return false;
  return true;
}

function validateScheduledInput(data = {}, { partial = false } = {}) {
  const errors = [];
  if (!partial || data.reportName !== undefined) {
    if (typeof data.reportName !== "string" || !data.reportName.trim()) {
      errors.push("reportName is required");
    }
  }
  if (data.frequency !== undefined && !VALID_FREQUENCIES.has(data.frequency)) {
    errors.push(`frequency must be one of: ${[...VALID_FREQUENCIES].join(", ")}`);
  }
  if (data.time !== undefined && !TIME_PATTERN.test(String(data.time))) {
    errors.push("time must be a 24-hour HH:MM value");
  }
  if (data.format !== undefined && !VALID_FORMATS.has(data.format)) {
    errors.push(`format must be one of: ${[...VALID_FORMATS].join(", ")}`);
  }
  if (data.recipients !== undefined) {
    if (!Array.isArray(data.recipients)) {
      errors.push("recipients must be an array of email addresses");
    } else {
      const invalid = (Array.isArray(data.recipients) ? data.recipients : []).filter(
        (r) => !isValidEmail(r),
      );
      if (invalid.length) errors.push(`invalid recipient email address(es): ${invalid.join(", ")}`);
    }
  }
  if (errors.length) throw ApiError.badRequest(`Invalid scheduled report: ${errors.join("; ")}`);
}

const cleanRecipients = (recipients) => [
  ...new Set(
    (Array.isArray(recipients) ? recipients : []).map((e) => String(e).trim()).filter(Boolean),
  ),
];

export async function getScheduledReports(userId) {
  const docs = await ScheduledReport.find({ createdBy: userId })
    .populate("savedReportId")
    .sort({ createdAt: -1 })
    .lean();
  return docs.map(formatScheduledReport);
}

export async function createScheduledReport(data, userId) {
  validateScheduledInput(data);
  const doc = await ScheduledReport.create({
    reportName: String(data.reportName).trim(),
    savedReportId: data.savedReportId || null,
    config: data.config ?? {},
    recipients: cleanRecipients(data.recipients),
    frequency: data.frequency ?? "daily",
    time: data.time ?? "09:00",
    status: data.status === "paused" ? "paused" : "active",
    format: data.format ?? "csv",
    createdBy: userId,
    nextRunAt: computeNextRunAt({
      frequency: data.frequency ?? "daily",
      time: data.time ?? "09:00",
    }),
  });
  return formatScheduledReport(doc.toObject());
}

function buildScheduledReportPatch(data = {}) {
  const patch = {};
  if (data.reportName !== undefined) patch.reportName = String(data.reportName).trim();
  if (data.savedReportId !== undefined) patch.savedReportId = data.savedReportId || null;
  if (data.config !== undefined) patch.config = data.config ?? {};
  if (data.recipients !== undefined) patch.recipients = cleanRecipients(data.recipients);
  if (data.frequency !== undefined) patch.frequency = data.frequency;
  if (data.time !== undefined) patch.time = data.time;
  if (data.format !== undefined) patch.format = data.format;
  if (data.status !== undefined) patch.status = data.status === "paused" ? "paused" : "active";
  return patch;
}

export async function updateScheduledReport(id, userId, data) {
  validateScheduledInput(data, { partial: true });
  const existing = await ScheduledReport.findOne({ _id: id, createdBy: userId }).lean();
  if (!existing) throw ApiError.notFound("Scheduled report not found");

  const patch = buildScheduledReportPatch(data);
  // Recompute the next occurrence whenever the cadence or active state changes
  // so edits take effect immediately instead of on the next worker tick.
  if (patch.frequency !== undefined || patch.time !== undefined || patch.status !== undefined) {
    const merged = { ...existing, ...patch };
    if (merged.status === "active") {
      patch.nextRunAt = computeNextRunAt(merged);
    } else {
      patch.nextRunAt = null;
    }
  }

  const doc = await ScheduledReport.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
  return formatScheduledReport(doc);
}

export async function deleteScheduledReport(id, userId) {
  const doc = await ScheduledReport.findOneAndDelete({ _id: id, createdBy: userId });
  if (!doc) throw ApiError.notFound("Scheduled report not found");
  return doc;
}
