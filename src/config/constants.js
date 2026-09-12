import { env } from "./env.js";

export const constants = {
  app: {
    name: "PharmaHub",
    version: "1.0.0",
    apiPrefix: "/api/v1",
  },

  development: {
    demoOwner: {
      name: "PharmaHub Demo Owner",
      email: "demo@pharmahub.local",
      password: env.devDemoPassword,
      role: "Owner",
      orgName: "PharmaHub",
    },
  },

  limits: {
    defaultPageSize: 20,
    maxPageSize: 100,
  },

  expiry: {
    nearExpiryDays: 90,
    expiredStatus: "expired",
    nearExpiryStatus: "near_expiry",
  },

  batchStatuses: ["active", "near_expiry", "expired", "quarantined", "blocked", "recalled", "retired"],

  manualStatuses: ["quarantined", "blocked", "recalled", "retired"],

  locationTypes: ["Front Shelf", "Backroom", "Cold Storage", "Quarantine"],

  movementTypes: [
    "Purchase Inward",
    "Sales Outward",
    "Stock Adjustment",
    "Write Off",
    "Transfer Out",
    "Transfer In",
    "Opening Stock",
  ],

  saleStatuses: ["completed", "void", "refunded"],
  purchaseStatuses: ["draft", "ordered", "received", "partially_received", "cancelled"],

  currencies: ["₹", "$", "€"],
  defaultCurrency: "₹",

  roles: ["Owner", "Admin", "Pharmacist", "Cashier", "Store Keeper", "Inventory Manager"],

  security: {
    invitationTtlHours: 24,
    invitationTtlMs: 24 * 60 * 60 * 1000,
  },

  // Permission modules mirror the app sidebar exactly (same keys, same
  // order): Home, Stock Management, Purchase & Trades, Analytics, Access
  // Management. `modules` drives permission matrices; `accessModules` drives
  // the per-user access whitelist. Keep both in sync with the sidebar.
  modules: [
    "dashboard",
    "medicines",
    "batches",
    "expiry",
    "audit",
    "purchases",
    "sales",
    "shortbook",
    "reports",
    "users",
    "admin",
    "integrations",
  ],

  accessModules: [
    "dashboard",
    "medicines",
    "batches",
    "expiry",
    "audit",
    "purchases",
    "sales",
    "shortbook",
    "reports",
    "users",
    "admin",
    "integrations",
  ],

  actions: ["view", "create", "update", "delete", "approve", "export"],
};
