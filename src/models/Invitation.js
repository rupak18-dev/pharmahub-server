import { Schema, model } from "mongoose";

// Same per-action shape as User.permissions so the Owner's invitation-time
// restrictions can be transferred verbatim to the accepted user document.
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

const invitationSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    role: { type: String, required: true, trim: true },
    // Role record the invitation targets — transferred to the user on acceptance.
    roleId: { type: Schema.Types.ObjectId, ref: "Role", default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    orgName: { type: String, trim: true },
    phone: { type: String, trim: true },
    // Department captured on the New Staff form — transferred to the user on
    // acceptance so the staff directory shows the same department the Owner
    // entered when inviting.
    department: { type: String, trim: true, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["pending", "accepted", "used", "expired", "cancelled", "revoked"],
      default: "pending",
      index: true,
    },
    name: { type: String, trim: true },
    message: { type: String, trim: true },
    permissions: { type: Map, of: permissionAction, default: {} },
    featureAccess: { type: Object, default: {} },
    // Explicit allowed-module whitelist configured by the Owner at invite time,
    // persisted verbatim so the granted modules survive a refresh / re-login
    // instead of being re-inferred from role defaults.
    accessIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Raw tokens are never stored — only their SHA-256 hash. Each invitation has a
// unique token so one link can never satisfy another invitation.
invitationSchema.index({ tokenHash: 1 }, { unique: true });

// Auto-expire pending invitations once their link has lapsed. Accepted/used/
// cancelled/expired records are kept for the Users & Roles invitation history.
invitationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: "pending" } },
);

// Invitations are scoped to an organization (denormalized orgName — the app
// has no separate Organization collection) for fast filtered lookups.
invitationSchema.index({ orgName: 1 });

export const Invitation = model("Invitation", invitationSchema);
