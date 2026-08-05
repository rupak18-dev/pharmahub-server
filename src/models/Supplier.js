import { Schema, model } from "mongoose";

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, maxlength: 160 },
    contactInfo: { type: String, trim: true },
    gstNumber: { type: String, trim: true, maxlength: 40 },
    paymentTerms: { type: String, trim: true, maxlength: 80 },
    address: { type: String, trim: true },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Supplier = model("Supplier", supplierSchema);
