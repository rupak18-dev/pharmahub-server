export const constants = {
  app: {
    name: "PharmaHub",
    version: "1.0.0",
    apiPrefix: "/api/v1",
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

  batchStatuses: ["active", "near_expiry", "expired", "quarantined"],

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

  modules: [
    "dashboard",
    "medicines",
    "batches",
    "inventory",
    "purchases",
    "sales",
    "expiry",
    "audit",
    "users",
    "reports",
    "notifications",
    "ai",
    "admin",
  ],

  actions: ["view", "create", "update", "delete", "approve", "export"],
};
