import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, default: "Pharmacist", index: true },
    orgName: { type: String, trim: true },
    phone: { type: String, trim: true },
    avatarUrl: { type: String, trim: true },
    tagline: { type: String, trim: true },
    description: { type: String, trim: true },
    businessEmail: { type: String, trim: true },
    website: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    gstin: { type: String, trim: true },
    licenseNo: { type: String, trim: true },
    businessType: { type: String, trim: true },
    services: { type: String, trim: true },
    businessHours: { type: String, trim: true },
    metaPixelId: { type: String, trim: true },
    branches: [{ type: String }],
    active: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const User = model("User", userSchema);
