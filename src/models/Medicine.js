import { Schema, model } from "mongoose";

const medicineSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    genericName: { type: String, trim: true },
    brandName: { type: String, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", index: true },
    manufacturerId: { type: Schema.Types.ObjectId, ref: "Manufacturer", index: true },
    hsnCode: { type: String, trim: true, maxlength: 20 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    storageRequirements: { type: String, trim: true },
    barcode: { type: String, trim: true, unique: true, sparse: true, index: true },
    reorderThreshold: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    prefix: { type: String, trim: true, maxlength: 10 },
    saltComposition: { type: String, trim: true },
    strength: { type: String, trim: true, maxlength: 40 },
    dosageForm: { type: String, trim: true, maxlength: 40 },
    packSize: { type: String, trim: true, maxlength: 40 },
    gtin: { type: String, trim: true, maxlength: 40 },
    drugSchedule: { type: String, trim: true, maxlength: 40 },
    dosageInfo: { type: String, trim: true },
    usageInstructions: { type: String, trim: true },
    contraindications: { type: String, trim: true },
    sideEffects: { type: String, trim: true },
    maxStockLevel: { type: Number, min: 0 },
    ptr: { type: Number, min: 0, default: 0 },
    rackLocation: { type: String, trim: true, maxlength: 40 },
  },
  { timestamps: true },
);

medicineSchema.index({ name: "text", genericName: "text", brandName: "text" });

export const Medicine = model("Medicine", medicineSchema);
