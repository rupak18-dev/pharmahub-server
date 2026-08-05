import { Schema, model } from "mongoose";

const manufacturerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, maxlength: 160 },
    contactInfo: { type: String, trim: true },
    address: { type: String, trim: true },
  },
  { timestamps: true },
);

export const Manufacturer = model("Manufacturer", manufacturerSchema);
