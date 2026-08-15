import { Schema, model } from "mongoose";

// One-time passcode for email verification. Codes are stored as SHA-256 hashes
// (never plaintext), expire after 10 minutes, and are auto-removed by MongoDB's
// TTL index on `expiresAt`.
const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp = model("Otp", otpSchema);
