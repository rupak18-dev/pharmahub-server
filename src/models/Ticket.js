import { Schema, model } from "mongoose";

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
    issueType: { type: String, required: true, trim: true, index: true },
    description: { type: String, required: true, trim: true },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      index: true,
    },
    screenshot: { type: String, default: null },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userName: { type: String, trim: true, default: "PharmaHub User" },
    userEmail: { type: String, trim: true, lowercase: true, default: "" },
    userRole: { type: String, default: "Staff" },
    orgName: { type: String, default: "PharmaHub Pharmacy" },
  },
  { timestamps: true },
);

ticketSchema.index({ createdAt: -1 });

export const Ticket = model("Ticket", ticketSchema);
