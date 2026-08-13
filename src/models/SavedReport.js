import mongoose from "mongoose";

const savedReportSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    module: {
      type: String,
      required: true,
      trim: true,
    },
    reportType: {
      type: String,
      default: "custom",
    },
    groupBy: [
      {
        type: String,
      },
    ],
    summarizeBy: [
      {
        field: { type: String, required: true },
        aggregation: { type: String, default: "SUM" },
      },
    ],
    filters: [
      {
        field: { type: String, required: true },
        operator: { type: String, default: "equals" },
        value: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    dateConfig: {
      presetId: { type: String, default: "thisMonth" },
      from: { type: Date },
      to: { type: Date },
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

export const SavedReport = mongoose.model("SavedReport", savedReportSchema);
