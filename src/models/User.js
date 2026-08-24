import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // Optional so Google-created accounts have no password; guarded at login.
    passwordHash: { type: String, select: false },
    role: { type: String, required: true, default: "Pharmacist", index: true },
    orgName: { type: String, trim: true },
    provider: { type: String, enum: ["email", "google"], default: "email", index: true },
    googleId: { type: String, sparse: true, unique: true },
    picture: { type: String, trim: true },
    emailVerified: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    onboarded: { type: Boolean, default: false },
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
