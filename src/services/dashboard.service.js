import { Batch } from "../models/Batch.js";
import { Medicine } from "../models/Medicine.js";
import { Purchase } from "../models/Purchase.js";
import { Sale } from "../models/Sale.js";
import { Notification } from "../models/Notification.js";

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export async function dashboardStats() {
  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const weekAgo = startOfDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));

  const [todaySales, weekSales, totalMedicines, purchaseCount, stockAgg] =
    await Promise.all([
      Sale.find({ status: "completed", createdAt: { $gte: today, $lt: tomorrow } }).lean(),
      Sale.find({ status: "completed", createdAt: { $gte: weekAgo } }).lean(),
      Medicine.countDocuments({ isActive: true }),
      Purchase.countDocuments(),
      Batch.aggregate([
        {
          $group: {
            _id: "$medicineId",
            totalStock: { $sum: { $ifNull: ["$stock.quantityOnHand", 0] } },
            stockValue: {
              $sum: {
                $multiply: [
                  { $ifNull: ["$stock.quantityOnHand", 0] },
                  { $ifNull: ["$pricing.purchasePrice", 0] },
                ],
              },
            },
          },
        },
      ]),
    ]);

  const stockByMedicine = new Map(stockAgg.map((a) => [String(a._id), a]));
  const totalStock = stockAgg.reduce((s, a) => s + a.totalStock, 0);
  const stockValue = stockAgg.reduce((s, a) => s + a.stockValue, 0);

  const lowStockMedicines = await Medicine.find({ isActive: true }).lean();
  const lowStockList = lowStockMedicines.filter(
    (m) => (stockByMedicine.get(String(m._id))?.totalStock ?? 0) <= m.reorderThreshold,
  );

  const [expiringCount, expiredCount] = await Promise.all([
    Batch.countDocuments({
      "dates.expiryDate": { $gt: new Date(), $lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
    }),
    Batch.countDocuments({ "dates.expiryDate": { $lt: new Date() } }),
  ]);

  const totalUnitsSoldToday = todaySales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.quantity, 0), 0);

  const daily = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(weekAgo.getTime() + i * 24 * 60 * 60 * 1000);
    daily.push({
      date: day.toISOString().slice(0, 10),
      sales: 0,
      invoices: 0,
    });
  }
  for (const s of weekSales) {
    const idx = Math.floor((new Date(s.createdAt) - weekAgo) / (24 * 60 * 60 * 1000));
    if (idx >= 0 && idx < 7) {
      daily[idx].sales += s.grandTotal;
      daily[idx].invoices += 1;
    }
  }

  return {
    today: {
      sales: todaySales.reduce((s, x) => s + x.grandTotal, 0),
      invoices: todaySales.length,
      units: totalUnitsSoldToday,
    },
    week: {
      sales: weekSales.reduce((s, x) => s + x.grandTotal, 0),
      invoices: weekSales.length,
    },
    inventory: {
      totalMedicines,
      totalStock,
      stockValue,
      lowStockCount: lowStockList.length,
      nearExpiryCount: expiringCount,
      expiredCount,
      pendingPurchases: purchaseCount,
    },
    salesTrend: daily,
  };
}

export async function getDashboardNotifications(limit = 20) {
  const lowStock = await getLowStockList();
  const expiring = await Batch.find({
    "dates.expiryDate": { $gt: new Date(), $lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
  })
    .populate("medicineId", "name")
    .sort({ "dates.expiryDate": 1 })
    .limit(limit)
    .lean();
  const expired = await Batch.find({ "dates.expiryDate": { $lt: new Date() } })
    .populate("medicineId", "name")
    .sort({ "dates.expiryDate": -1 })
    .limit(limit)
    .lean();

  const notifications = [];
  for (const m of lowStock.slice(0, limit)) {
    notifications.push({
      type: "low_stock",
      title: "Low stock",
      body: `${m.medicine.name}: ${m.currentStock} left (threshold ${m.reorderThreshold})`,
      entityType: "medicine",
      entityId: String(m.medicine._id),
      createdAt: new Date(),
    });
  }
  for (const b of expiring.slice(0, limit)) {
    notifications.push({
      type: "expiry",
      title: "Batch expiring soon",
      body: `${b.medicineId?.name ?? "Medicine"} · batch ${b.batchNumber} expires ${new Date(b.dates?.expiryDate).toISOString().slice(0, 10)}`,
      entityType: "batch",
      entityId: String(b._id),
      createdAt: new Date(),
    });
  }
  for (const b of expired.slice(0, limit)) {
    notifications.push({
      type: "expiry",
      title: "Batch expired",
      body: `${b.medicineId?.name ?? "Medicine"} · batch ${b.batchNumber} has expired`,
      entityType: "batch",
      entityId: String(b._id),
      createdAt: new Date(),
    });
  }
  notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const stored = await Notification.find({ userId: null }).sort({ createdAt: -1 }).limit(limit).lean();
  const storedMapped = stored.map((n) => ({ ...n, _id: undefined }));
  const merged = [...storedMapped, ...notifications];
  const seen = new Set();
  return {
    notifications: merged.filter((n) => {
      const key = `${n.type}-${n.entityId}-${n.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

async function getLowStockList(limit = 50) {
  const stockAgg = await Batch.aggregate([
    {
      $group: {
        _id: "$medicineId",
        totalStock: { $sum: { $ifNull: ["$stock.quantityOnHand", 0] } },
      },
    },
  ]);
  const stockByMedicine = new Map(stockAgg.map((a) => [String(a._id), a.totalStock]));

  const medicines = await Medicine.find({ isActive: true }).lean();
  const list = medicines
    .filter((m) => (stockByMedicine.get(String(m._id)) ?? 0) <= m.reorderThreshold)
    .map((m) => ({
      medicine: m,
      currentStock: stockByMedicine.get(String(m._id)) ?? 0,
      reorderThreshold: m.reorderThreshold,
    }))
    .sort((a, b) => a.currentStock - b.currentStock)
    .slice(0, limit);
  return list;
}
