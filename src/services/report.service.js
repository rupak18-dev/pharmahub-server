import { Batch } from "../models/Batch.js";
import { Sale } from "../models/Sale.js";
import { Purchase } from "../models/Purchase.js";
import { classifyBatchStatus } from "../utils/date.js";
import { constants } from "../config/constants.js";

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export async function salesReport({ from, to, groupBy = "day" }) {
  const match = { status: "completed" };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = startOfDay(new Date(from));
    if (to) match.createdAt.$lte = new Date(to);
  }

  const dateFormat = {
    day: "%Y-%m-%d",
    month: "%Y-%m",
    year: "%Y",
  }[groupBy] ?? "%Y-%m-%d";

  const [aggResult, summaryResult] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: "$createdAt" } },
          invoices: { $sum: 1 },
          units: { $sum: { $sum: "$items.quantity" } },
          sales: { $sum: "$grandTotal" },
          gst: { $sum: "$gstTotal" },
          items: { $sum: { $size: "$items" } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          period: "$_id",
          invoices: 1,
          units: 1,
          sales: 1,
          gst: 1,
          items: 1,
        },
      },
    ]),
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$grandTotal" },
          totalInvoices: { $sum: 1 },
          totalUnits: { $sum: { $sum: "$items.quantity" } },
          totalGst: { $sum: "$gstTotal" },
        },
      },
    ]),
  ]);

  const summary = summaryResult[0] ?? { totalSales: 0, totalInvoices: 0, totalUnits: 0, totalGst: 0 };
  delete summary._id;

  return {
    from,
    to,
    groupBy,
    summary,
    series: aggResult,
  };
}

export async function purchaseReport({ from, to }) {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = startOfDay(new Date(from));
    if (to) match.createdAt.$lte = new Date(to);
  }
  const purchases = await Purchase.find(match).sort({ createdAt: 1 }).lean();
  return {
    summary: {
      totalSpend: purchases.reduce((s, x) => s + x.grandTotal, 0),
      totalOrders: purchases.length,
      received: purchases.filter((p) => p.status === "received").length,
    },
    records: purchases,
  };
}

export async function expiryReport(days = 90) {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const expired = await Batch.find({ "dates.expiryDate": { $lt: new Date() } }).populate("medicineId", "name genericName brandName").lean();
  const expiring = await Batch.find({ "dates.expiryDate": { $gte: new Date(), $lte: cutoff } }).populate("medicineId", "name genericName brandName").sort({ "dates.expiryDate": 1 }).lean();
  return {
    days,
    summary: {
      expiredCount: expired.length,
      expiredValue: expired.reduce((s, b) => s + (b.stock?.quantityOnHand ?? 0) * (b.pricing?.purchasePrice ?? 0), 0),
      expiringCount: expiring.length,
    },
    expired,
    expiring,
  };
}

const manualStates = new Set(["QUARANTINED", "RECALLED", "BLOCKED", "RETIRED"]);
function statusBucketOf(b) {
  const state = b.status?.state;
  if (manualStates.has(state)) return state.toLowerCase();
  return classifyBatchStatus(b.dates?.expiryDate, constants.expiry.nearExpiryDays);
}

export async function stockValuationReport() {
  const batches = await Batch.find({ "stock.quantityOnHand": { $gt: 0 } })
    .populate("medicineId", "name genericName brandName")
    .lean();
  const byStatus = { active: 0, near_expiry: 0, expired: 0, quarantined: 0 };
  let totalValue = 0;
  let totalUnits = 0;
  for (const b of batches) {
    const value = (b.stock?.quantityOnHand ?? 0) * (b.pricing?.purchasePrice ?? 0);
    totalValue += value;
    totalUnits += b.stock?.quantityOnHand ?? 0;
    byStatus[statusBucketOf(b)] = (byStatus[statusBucketOf(b)] ?? 0) + value;
  }
  return {
    summary: { totalUnits, totalValue, byStatus },
    batches,
  };
}
