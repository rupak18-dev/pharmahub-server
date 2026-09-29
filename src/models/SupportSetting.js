import { Schema, model } from "mongoose";

const supportCategorySchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    icon: { type: String, default: "💬" },
    desc: { type: String, default: "" },
  },
  { _id: false },
);

const supportSettingSchema = new Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
      index: true,
    },
    title: {
      type: String,
      default: "Help & Support Desk",
      trim: true,
    },
    description: {
      type: String,
      default:
        "Submit support tickets, report technical or inventory issues, and monitor active ticket resolution.",
      trim: true,
    },
    supportEmail: {
      type: String,
      default: "pharmahub.team@gmail.com",
      trim: true,
    },
    supportPhone: {
      type: String,
      default: "1800-PHARMA-HELP",
      trim: true,
    },
    slaText: {
      type: String,
      default: "Priority Live Helpdesk · Standard 4h-24h turnaround",
      trim: true,
    },
    helpInfo: {
      type: String,
      default:
        "Critical issues receive an immediate response within 1 hour. High severity tickets are answered in 4 hours, and standard inquiries within 12-24 hours.",
      trim: true,
    },
    categories: {
      type: [supportCategorySchema],
      default: [
        {
          id: "billing_pos",
          label: "Billing, POS & Invoicing Issue",
          icon: "💳",
          desc: "Cash register errors, discount discrepancies, tax calculation, thermal bill printing",
        },
        {
          id: "inventory_stock",
          label: "Inventory & Stock Discrepancy",
          icon: "📦",
          desc: "Physical stock vs system count mismatch, negative balance, rack placement",
        },
        {
          id: "medicines_batches",
          label: "Medicine Catalog & Batch Tracking",
          icon: "💊",
          desc: "Barcode/QR scan failure, batch number collision, missing HSN or salt details",
        },
        {
          id: "expiry_returns",
          label: "Expiry & Returns Management",
          icon: "⏳",
          desc: "Near-expiry alerts, quarantine batch issue, credit note or vendor return error",
        },
        {
          id: "purchases_suppliers",
          label: "Purchase Orders & Supplier Sync",
          icon: "🚚",
          desc: "GRN creation failure, supplier ledger mismatch, purchase invoice upload issue",
        },
        {
          id: "user_access",
          label: "User Access, Roles & Permissions",
          icon: "🔐",
          desc: "Login failure, role capability restrictions, invitation link expired",
        },
        {
          id: "reports_export",
          label: "Reports & PDF/Excel Export",
          icon: "📊",
          desc: "GST report generation error, Excel export broken, sales analytics discrepancies",
        },
        {
          id: "hardware_integrations",
          label: "Integrations & Hardware Setup",
          icon: "🖨️",
          desc: "Thermal receipt printer, barcode reader, WhatsApp notification gateway",
        },
        {
          id: "system_bug",
          label: "System Bug / Technical Error",
          icon: "⚠️",
          desc: "Unexpected UI glitch, freeze, 500 error code, or performance lag",
        },
        {
          id: "general_inquiry",
          label: "General Inquiry / Feature Feedback",
          icon: "💬",
          desc: "How-to guidance, new pharmacy feature request, or process questions",
        },
      ],
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedByName: {
      type: String,
      default: "System Admin",
    },
  },
  { timestamps: true },
);

export const SupportSetting = model("SupportSetting", supportSettingSchema);
