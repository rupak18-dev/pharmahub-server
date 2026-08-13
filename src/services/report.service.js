import { Batch } from "../models/Batch.js";
import { Sale } from "../models/Sale.js";
import { Purchase } from "../models/Purchase.js";
import { Medicine } from "../models/Medicine.js";
import { Supplier } from "../models/Supplier.js";
import { User } from "../models/User.js";
import { StockMovement } from "../models/StockMovement.js";
import { AuditLog } from "../models/AuditLog.js";
import { SavedReport } from "../models/SavedReport.js";
import { ScheduledReport } from "../models/ScheduledReport.js";

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export async function salesReport({ from, to, groupBy = "day" }) {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = startOfDay(new Date(from));
    if (to) match.createdAt.$lte = new Date(to);
  }
  const sales = await Sale.find({ ...match, status: "completed" }).sort({ createdAt: 1 }).lean();

  const buckets = new Map();
  const keyOf = {
    day: (d) => d.toISOString().slice(0, 10),
    month: (d) => d.toISOString().slice(0, 7),
    year: (d) => String(d.getUTCFullYear()),
  }[groupBy] ?? ((d) => d.toISOString().slice(0, 10));

  for (const s of sales) {
    const key = keyOf(new Date(s.createdAt));
    const bucket = buckets.get(key) ?? { period: key, invoices: 0, units: 0, sales: 0, gst: 0, items: 0 };
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

export async function purchaseReport({ from, to }) {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = startOfDay(new Date(from));
    if (to) match.createdAt.$lte = new Date(to);
  }
  const purchases = await Purchase.find(match).populate("supplierId", "name").sort({ createdAt: 1 }).lean();
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
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const expired = await Batch.find({ expiryDate: { $lt: new Date() } }).populate("medicineId", "name genericName brandName").lean();
  const expiring = await Batch.find({ expiryDate: { $gte: new Date(), $lte: cutoff } }).populate("medicineId", "name genericName brandName").sort({ expiryDate: 1 }).lean();
  return {
    days,
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
   --------------------------------------------------------------------- */

export async function customReport({ module, groupBy = [], summarizeBy = [], filters = [], dateFrom, dateTo }) {
  let targetModel;
  switch (module) {
    case "sales":
    case "gst":
    case "payments":
      targetModel = Sale;
      break;
    case "purchases":
      targetModel = Purchase;
      break;
    case "inventory":
    case "expiry":
      targetModel = Batch;
      break;
    case "medicines":
    case "items":
      targetModel = Medicine;
      break;
    case "suppliers":
      targetModel = Supplier;
      break;
    case "audit":
      targetModel = AuditLog;
      break;
    default:
      targetModel = Sale;
      break;
  }

  const match = {};
  if (dateFrom || dateTo) {
    match.createdAt = {};
    if (dateFrom) match.createdAt.$gte = new Date(dateFrom);
    if (dateTo) match.createdAt.$lte = new Date(dateTo);
  }

  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!f.field || f.value === undefined || f.value === null || f.value === "") continue;
      const key = f.field;
      const val = f.value;
      switch (f.operator) {
        case "equals":
          match[key] = val;
          break;
        case "not_equals":
          match[key] = { $ne: val };
          break;
        case "contains":
          match[key] = { $regex: val, $options: "i" };
          break;
        case "greater_than":
          match[key] = { $gt: Number(val) };
          break;
        case "less_than":
          match[key] = { $lt: Number(val) };
          break;
        case "between":
          if (Array.isArray(val) && val.length === 2) {
            match[key] = { $gte: val[0], $lte: val[1] };
          }
          break;
        case "in":
          if (Array.isArray(val)) {
            match[key] = { $in: val };
          }
          break;
        default:
          match[key] = val;
          break;
      }
    }
  }

  const rawRecords = await targetModel.find(match).sort({ createdAt: -1 }).lean();

  if (rawRecords.length === 0) {
    return {
      columns: [],
      rows: [],
      totals: {},
      message: "No data found for the selected criteria.",
    };
  }

  const primaryGroup = groupBy[0] || null;
  const groupsMap = new Map();

  for (const record of rawRecords) {
    let groupKeyVal = "Total";
    if (primaryGroup) {
      groupKeyVal = String(record[primaryGroup] ?? record._id ?? "N/A");
    }

    const current = groupsMap.get(groupKeyVal) || {
      groupVal: groupKeyVal,
      count: 0,
      records: [],
    };
    current.count += 1;
    current.records.push(record);
    groupsMap.set(groupKeyVal, current);
  }

  const rows = [];
  const totals = {};

  for (const [gKey, gData] of groupsMap.entries()) {
    const row = {};
    if (primaryGroup) {
      row[primaryGroup] = gKey;
    }

    for (const sumObj of summarizeBy) {
      const fieldKey = typeof sumObj === "string" ? sumObj : sumObj.field;
      const agg = typeof sumObj === "string" ? "SUM" : (sumObj.aggregation || "SUM").toUpperCase();
      const vals = gData.records
        .map((r) => Number(r[fieldKey] ?? 0))
        .filter((v) => !isNaN(v));

      let resultVal = 0;
      if (agg === "COUNT") {
        resultVal = gData.count;
      } else if (vals.length > 0) {
        if (agg === "SUM") resultVal = vals.reduce((a, b) => a + b, 0);
        else if (agg === "AVG") resultVal = vals.reduce((a, b) => a + b, 0) / vals.length;
        else if (agg === "MIN") resultVal = Math.min(...vals);
        else if (agg === "MAX") resultVal = Math.max(...vals);
      }

      row[fieldKey] = Number(resultVal.toFixed(2));
      totals[fieldKey] = Number(((totals[fieldKey] || 0) + row[fieldKey]).toFixed(2));
    }

    rows.push(row);
  }

  return {
    module,
    groupBy,
    summarizeBy,
    filters,
    dateFrom,
    dateTo,
    rows,
    totals,
    totalRecords: rawRecords.length,
  };
}

/* ---------------------------------------------------------------------
   Saved Reports & Schedules CRUD
   --------------------------------------------------------------------- */

export async function getSavedReports(userId) {
  return await SavedReport.find(userId ? { createdBy: userId } : {}).sort({ createdAt: -1 }).lean();
}

export async function createSavedReport(data, userId) {
  return await SavedReport.create({ ...data, createdBy: userId });
}

export async function updateSavedReport(id, data) {
  return await SavedReport.findByIdAndUpdate(id, data, { new: true }).lean();
}

export async function deleteSavedReport(id) {
  return await SavedReport.findByIdAndDelete(id);
}

export async function getScheduledReports() {
  return await ScheduledReport.find().populate("savedReportId").sort({ createdAt: -1 }).lean();
}

export async function createScheduledReport(data, userId) {
  return await ScheduledReport.create({ ...data, createdBy: userId });
}

export async function updateScheduledReport(id, data) {
  return await ScheduledReport.findByIdAndUpdate(id, data, { new: true }).lean();
}

export async function deleteScheduledReport(id) {
  return await ScheduledReport.findByIdAndDelete(id);
}
