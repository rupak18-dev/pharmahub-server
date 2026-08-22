# PharmaHub Server — Data Model

## Collections

```
users ────────┐
roles ────────┼─ references (by role name / _id)
categories ───┤
manufacturers ─┤
suppliers ─────┤
              │
medicines ◄───┘   (categoryId, manufacturerId)
  │
  ▼
batches          (medicineId, supplierId)  — one row per received lot
  │
  ├──► inventoryItems  (batchId + location) — quantity per location/rack
  ├──► inventoryLedgers (batchId)           — audit of every quantity change
  └──► stockMovements   (medicineId, batchId) — in/out/adjustment log

purchases  ──► items[] ──► medicineId (+ batchId after GRN)
sales      ──► items[] ──► medicineId + batchId (FEFO picks)

auditLogs      — user action trail
notifications  — expiry / low-stock / system alerts
```

## Field highlights

### users

`name`, `email` (unique), `passwordHash` (bcrypt, hidden from JSON), `role`,
`orgName`, `active`.

### roles

`name` (unique), `permissions` (Map of module → `{view, create, update,
delete, approve, export}`), `isSystem`. System roles are seeded by
`Role.ensureSystemRoles()` with the same defaults as the frontend's
`src/lib/permissions.js`.

### medicines

Master product record. Includes enterprise fields mirrored from the frontend:
`saltComposition`, `strength`, `dosageForm`, `packSize`, `gtin`, `drugSchedule`,
`dosageInfo`, `usageInstructions`, `contraindications`, `sideEffects`,
`maxStockLevel`, `ptr`, `rackLocation`. Text index on `name/genericName/brandName`.

### batches

`medicineId`, `batchNumber` (unique per medicine), `mfgDate`, `expiryDate`,
`mrp`, `purchasePrice`, `sellingPrice`, `supplierId`, `currentStock`, `status`.

`status` is auto-derived from `expiryDate`:
`active` → `near_expiry` (within 90 days) → `expired`.

### inventoryItems

One document per `(batchId, locationType, rackCode)`. `quantityOnHand` and
`reservedQuantity`. `currentStock` on the batch is kept in sync inside
transactions.

### purchases

`orderNo` (unique), `supplierId`, `items[]` (`medicineId`, `quantity`,
`quantityReceived`, `unitCost`, `gstRate`, `lineTotal`), totals, `status`
(`draft/ordered/received/partially_received/cancelled`).

Receiving a purchase (`POST /purchases/:id/receive`) creates/updates batches and
adds stock + ledger entries atomically.

### sales

`invoiceNo` (unique), customer info, `items[]` (`medicineId`, `batchId`,
`medicineName`, `batchNumber`, `quantity`, `unitPrice`, `discountPct`, `gstRate`,
`lineTotal`), `subtotal`, `discountTotal`, `gstTotal`, `roundOff`, `grandTotal`,
`paymentMode`, `tender`, `change`, `status` (`completed/void/refunded`).

Stock is deducted from batches using FEFO (first-expiry-first-out). Voiding a
sale restores the stock.

### inventoryLedgers / stockMovements

Immutable logs. Ledger records `movementType`, `quantityChange`, user, reference
doc. Movements separate in/out/adjustment per medicine.

### auditLogs

`userId`, `userName`, `action`, `entityType`, `entityId`, `details` (mixed),
`ip`, timestamps.

### notifications

`title`, `body`, `type` (`expiry/low_stock/system/purchase/sale/audit`),
`userId` (null = broadcast), `read`, `readAt`.

## Indexes

- Unique: `users.email`, `roles.name`, `categories.name`, `manufacturers.name`,
  `suppliers.name`, `medicines.barcode`, `batches(medicineId, batchNumber)`,
  `inventoryItems(batchId, locationType, rackCode)`, `purchases.orderNo`,
  `sales.invoiceNo`.
- Frequent query patterns (status, expiry, date ranges) are indexed on
  `batches`, `sales`, `inventoryLedgers`, `auditLogs`, `notifications`.
