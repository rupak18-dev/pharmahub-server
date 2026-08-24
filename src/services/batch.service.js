import { Batch } from "../models/Batch.js";
import { Medicine } from "../models/Medicine.js";
import { constants } from "../config/constants.js";

export async function getNearExpiryBatches(days = constants.expiry.nearExpiryDays) {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return Batch.find({ "dates.expiryDate": { $lte: cutoff } })
    .sort({ "dates.expiryDate": 1 })
    .populate("medicineId", "name genericName brandName")
    .lean();
}

export async function getExpiredBatches() {
  return Batch.find({ "dates.expiryDate": { $lt: new Date() } })
    .sort({ "dates.expiryDate": 1 })
    .populate("medicineId", "name genericName brandName")
    .lean();
}

export async function getLowStockMedicines() {
  const medicines = await Medicine.find({ isActive: true }).lean();
  const batches = await Batch.find({}).lean();
  const perMedicine = new Map();
  for (const b of batches) {
    const key = String(b.medicineId);
    perMedicine.set(key, (perMedicine.get(key) ?? 0) + (b.stock?.quantityOnHand ?? 0));
  }
  return medicines
    .filter((m) => (perMedicine.get(String(m._id)) ?? 0) <= m.reorderThreshold)
    .map((m) => ({
      medicine: m,
      currentStock: perMedicine.get(String(m._id)) ?? 0,
      reorderThreshold: m.reorderThreshold,
    }));
}
