import { Schema, model } from "mongoose";

// Per-user permission overrides, keyed by module.
// Mirrors the Role permission shape:
// module -> { view, create, update, delete, approve, export }
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
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // Optional for Google-created accounts; guarded at login.
    passwordHash: {
      type: String,
      select: false,
    },

    role: {
      type: String,
      required: true,
      default: "Pharmacist",
      index: true,
    },

    // Denormalized reference to the Role record assigned to this user.
    // Keeps custom role assignments stable across refresh/re-login.
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      default: null,
    },

    orgName: {
      type: String,
      trim: true,
      index: true,
    },

    // Authentication provider information
    provider: {
      type: String,
      enum: ["email", "google"],
      default: "email",
      index: true,
    },

    googleId: {
      type: String,
      sparse: true,
      unique: true,
    },

    picture: {
      type: String,
      trim: true,
    },

    emailVerified: {
      type: Boolean,
      default: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    status: {
      type: String,
      enum: ["active", "suspended", "inactive", "removed"],
      default: "active",
      index: true,
    },

    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    phoneVerified: {
      type: Boolean,
      default: false,
    },

    phoneVerifiedAt: {
      type: Date,
      default: null,
    },

    // Profile fields
    avatarUrl: {
      type: String,
      trim: true,
    },

    tagline: {
      type: String,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
    },

    businessEmail: {
      type: String,
      trim: true,
    },

    website: {
      type: String,
      trim: true,
    },

    address: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    state: {
      type: String,
      trim: true,
    },

    pincode: {
      type: String,
      trim: true,
    },

    gstin: {
      type: String,
      trim: true,
    },

    licenseNo: {
      type: String,
      trim: true,
    },

    businessType: {
      type: String,
      trim: true,
    },

    services: {
      type: String,
      trim: true,
    },

    businessHours: {
      type: String,
      trim: true,
    },

    metaPixelId: {
      type: String,
      trim: true,
    },

    branches: [{ type: String }],

    active: {
      type: Boolean,
      default: true,
    },

    onboarded: {
      type: Boolean,
      default: false,
    },

    // Per-user permission overrides.
    // Used by Users & Roles.
    permissions: {
      type: Map,
      of: permissionAction,
      default: {},
    },

    featureAccess: {
      type: Object,
      default: {},
    },

    // Explicit access configured by Owner through Staff Access.
    // Persists configured access across refresh/re-login.
    accessIds: {
      type: [String],
      default: [],
    },

    department: {
      type: String,
      trim: true,
      default: null,
    },

    designation: {
      type: String,
      trim: true,
      default: null,
    },

    // Profile completion information.
    profileCompletion: {
      percentage: {
        type: Number,
        default: 0,
      },

      completedCount: {
        type: Number,
        default: 0,
      },

      totalCount: {
        type: Number,
        default: 13,
      },

      completedFields: {
        type: [String],
        default: [],
      },

      missingFields: {
        type: [String],
        default: [],
      },

      updatedAt: {
        type: Date,
        default: null,
      },
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