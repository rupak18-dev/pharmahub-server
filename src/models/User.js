import { Schema, model } from "mongoose";

// Per-user permission overrides, keyed by module. Mirrors the Role permission
// shape (module -> { view, create, update, delete, approve, export }) so the
// exact same matrix can be merged over role defaults. Only the deltas the
// Owner configured are stored here — role defaults live in the Role collection.
const permissionAction = new Schema(
  {
    view: { type: Boolean, default: false },
    create: { type: Boolean, default: false },
    update: { type: Boolean, default: false },
    delete: { type: Boolean, default: false },
    approve: { type: Boolean, default: false },
    export: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, default: "Pharmacist", index: true },
    // Denormalized reference to the Role record the user is assigned to, kept
    // in sync whenever the role name changes so custom roles survive refresh.
    roleId: { type: Schema.Types.ObjectId, ref: "Role", default: null },
    orgName: { type: String, trim: true, index: true },
    phone: { type: String, trim: true },
    status: {
      type: String,
      enum: ["active", "suspended", "inactive", "removed"],
      default: "active",
      index: true,
    },
    removedAt: { type: Date, default: null },
    removedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },
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
    onboarded: { type: Boolean, default: true },
    permissions: { type: Map, of: permissionAction, default: {} },
    featureAccess: { type: Object, default: {} },
    // Explicit allowed-module whitelist configured by the Owner through the
    // Staff Access dialog. Persisted verbatim so granted modules survive a
    // refresh / re-login instead of being re-inferred from role defaults.
    accessIds: { type: [String], default: [] },
    department: { type: String, trim: true, default: null },
    designation: { type: String, trim: true, default: null },
    profileCompletion: {
      percentage: { type: Number, default: 0 },
      completedCount: { type: Number, default: 0 },
      totalCount: { type: Number, default: 13 },
      completedFields: { type: [String], default: [] },
      missingFields: { type: [String], default: [] },
      updatedAt: { type: Date, default: null },
    },
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
