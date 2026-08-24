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
    bucket.units += s.items.reduce((acc, i) => acc + i.quantity, 0);
    bucket.sales += s.grandTotal;
    bucket.gst += s.gstTotal;
    bucket.items += s.items.length;
    buckets.set(key, bucket);
  }

  return {
    from,
    to,
    groupBy,
    summary: {
      totalSales: sales.reduce((s, x) => s + x.grandTotal, 0),
      totalInvoices: sales.length,
      totalUnits: sales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.quantity, 0), 0),
      totalGst: sales.reduce((s, x) => s + x.gstTotal, 0),
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
