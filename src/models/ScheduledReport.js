import mongoose from "mongoose";

const scheduledReportSchema = new mongoose.Schema(
  {
    reportName: {
      type: String,
      required: true,
      trim: true,
    },
    savedReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SavedReport",
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
    },
    recipients: [
      {
        type: String,
        required: true,
        trim: true,
      },
    ],
    frequency: {
      type: String,
      enum: ["daily", "weekly", "monthly"],
      default: "daily",
    },
    time: {
      type: String,
      default: "09:00",
    },
    status: {
      type: String,
      enum: ["active", "paused"],
      default: "active",
    },
    lastSentAt: {
      type: Date,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

export const ScheduledReport = mongoose.model("ScheduledReport", scheduledReportSchema);
