import { Schema, model } from "mongoose";

const demoLoginTokenSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  },
);

demoLoginTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DemoLoginToken = model("DemoLoginToken", demoLoginTokenSchema);
