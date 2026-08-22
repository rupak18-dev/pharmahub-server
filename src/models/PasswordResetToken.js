import { Schema, model } from "mongoose";

const passwordResetTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    status: { type: String, enum: ["pending", "used"], default: "pending", index: true },
  },
  { timestamps: true },
);

// Raw reset tokens are never stored — only their SHA-256 hash.
passwordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });

// One-time, expiring reset links: pending tokens are auto-removed shortly after
// they lapse. Used tokens are kept briefly for audit/replay rejection.
passwordResetTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: "pending" } },
);

export const PasswordResetToken = model("PasswordResetToken", passwordResetTokenSchema);
