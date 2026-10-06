import { Schema, model } from "mongoose";

const ticketActivitySchema = new Schema(
  {
    event: { type: String, required: true },
    status: { type: String, required: true },
    title: { type: String, default: "" },
    description: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    by: { type: String, default: "Support Team" },
  },
  { _id: true },
);

const ticketMessageSchema = new Schema(
  {
    sender: { type: String, enum: ["admin", "user"], default: "admin" },
    senderName: { type: String, required: true, trim: true },
    senderRole: { type: String, default: "Support Team" },
    message: { type: String, required: true, trim: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ticketSchema = new Schema(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 250 },
    issueTitle: { type: String, trim: true, maxlength: 250 },
    issueType: { type: String, required: true, trim: true, index: true },
    description: { type: String, required: true, trim: true },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      index: true,
    },
    screenshot: { type: String, default: null },
    hasScreenshot: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["open", "acknowledged", "assigned", "in_progress", "waiting_for_user", "resolved", "closed"],
      default: "open",
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userName: { type: String, trim: true, default: "PharmaHub User" },
    userEmail: { type: String, trim: true, lowercase: true, default: "" },
    userRole: { type: String, default: "Staff" },
    orgName: { type: String, default: "PharmaHub Pharmacy" },
    confirmationEmailSent: { type: Boolean, default: false },
    activityTimeline: {
      type: [ticketActivitySchema],
      default: [],
    },
    messages: {
      type: [ticketMessageSchema],
      default: [],
    },
  },
  { timestamps: true },
);

ticketSchema.index({ createdAt: -1 });

export const Ticket = model("Ticket", ticketSchema);
