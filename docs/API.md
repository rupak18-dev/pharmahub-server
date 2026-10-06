# PharmaHub API Reference

Base URL: `/api/v1`

All endpoints except `/auth/register`, `/auth/login`, `/health` and `/info`
require an `Authorization: Bearer <token>` header.

## Response envelope

Successful responses:

```json
{ "success": true, "message": "optional", "data": {}, "meta": {} }
```

Errors:

```json
{ "success": false, "error": { "message": "reason", "details": [] } }
```

`meta` is included on list endpoints (`page`, `limit`, `total`, `pages`, `hasMore`).

## Auth

| Method | Path                    | Description                  |
| ------ | ----------------------- | ---------------------------- |
| POST   | `/auth/register`        | Register (role = Pharmacist) |
| POST   | `/auth/login`           | Sign in, returns JWT         |
| GET    | `/auth/me`              | Current user profile         |
| POST   | `/auth/change-password` | Change own password          |

## Users & roles

| Method | Path         | Permission   | Description              |
| ------ | ------------ | ------------ | ------------------------ |
| GET    | `/users`     | users.view   | List users               |
| POST   | `/users`     | users.create | Create user              |
| GET    | `/users/:id` | users.view   | Get user                 |
| PATCH  | `/users/:id` | users.update | Update user              |
| DELETE | `/users/:id` | users.delete | Delete user              |
| GET    | `/roles`     | users.view   | List roles + permissions |
| PATCH  | `/roles/:id` | users.update | Update role permissions  |

## Medicines master data

| Method | Path             | Permission       | Description         |
| ------ | ---------------- | ---------------- | ------------------- |
| GET    | `/medicines`     | medicines.view   | List medicines      |
| POST   | `/medicines`     | medicines.create | Create medicine     |
| GET    | `/medicines/:id` | medicines.view   | Get + stock summary |
| PATCH  | `/medicines/:id` | medicines.update | Update medicine     |
| DELETE | `/medicines/:id` | medicines.delete | Delete medicine     |
| GET    | `/categories`    | medicines.view   | List categories     |
| POST   | `/categories`    | medicines.create | Create category     |
| GET    | `/manufacturers` | medicines.view   | List manufacturers  |
| POST   | `/manufacturers` | medicines.create | Create manufacturer |
| GET    | `/suppliers`     | purchases.view   | List suppliers      |
| POST   | `/suppliers`     | purchases.create | Create supplier     |

List endpoints accept `?q=` for search and `?page=&limit=` for pagination.

## Batches

| Method | Path           | Permission     | Description                                               |
| ------ | -------------- | -------------- | --------------------------------------------------------- |
| GET    | `/batches`     | batches.view   | List batches (`?medicineId=`, `?status=`, `?expiryDate=`) |
| POST   | `/batches`     | batches.create | Create batch (status auto-computed from expiry)           |
| GET    | `/batches/:id` | batches.view   | Get batch + locations                                     |
| PATCH  | `/batches/:id` | batches.update | Update batch                                              |
| DELETE | `/batches/:id` | batches.delete | Delete batch (no stock allowed)                           |

## Inventory

| Method | Path                       | Permission       | Description                |
| ------ | -------------------------- | ---------------- | -------------------------- |
| GET    | `/inventory`               | inventory.view   | List inventory items       |
| GET    | `/inventory/ledger`        | inventory.view   | Inventory movement ledger  |
| GET    | `/inventory/movements`     | inventory.view   | Stock movements            |
| GET    | `/inventory/medicines/:id` | inventory.view   | Stock summary per medicine |
| POST   | `/inventory/add`           | inventory.create | Add stock to a batch       |
| POST   | `/inventory/adjust`        | inventory.update | Set stock to a new level   |
| POST   | `/inventory/movements`     | inventory.update | Record a movement          |

## Purchases

| Method | Path                     | Permission       | Description                          |
| ------ | ------------------------ | ---------------- | ------------------------------------ |
| GET    | `/purchases`             | purchases.view   | List purchase orders                 |
| POST   | `/purchases`             | purchases.create | Create purchase order                |
| GET    | `/purchases/:id`         | purchases.view   | Get purchase order                   |
| POST   | `/purchases/:id/receive` | purchases.update | Receive stock (GRN), creates batches |
| PATCH  | `/purchases/:id/status`  | purchases.update | Change status                        |
| DELETE | `/purchases/:id`         | purchases.delete | Delete a draft order                 |

## Sales

| Method | Path              | Permission   | Description                       |
| ------ | ----------------- | ------------ | --------------------------------- |
| GET    | `/sales`          | sales.view   | List sales (`?from=&to=&status=`) |
| POST   | `/sales`          | sales.create | Complete a sale (FEFO batch pick) |
| GET    | `/sales/:id`      | sales.view   | Get sale invoice                  |
| POST   | `/sales/:id/void` | sales.update | Void a sale and restore stock     |

## Reports

| Method | Path                       | Permission   | Description                          |
| ------ | -------------------------- | ------------ | ------------------------------------ |
| GET    | `/reports/sales`           | reports.view | Sales report `?from=&to=&groupBy=day | month | year` |
| GET    | `/reports/purchases`       | reports.view | Purchase spend report                |
| GET    | `/reports/expiry`          | reports.view | Expiry report `?days=90`             |
| GET    | `/reports/stock-valuation` | reports.view | Stock valuation by status            |

## Dashboard

| Method | Path                       | Permission     | Description                               |
| ------ | -------------------------- | -------------- | ----------------------------------------- |
| GET    | `/dashboard/stats`         | dashboard.view | Today/week sales, inventory health, trend |
| GET    | `/dashboard/notifications` | dashboard.view | Expiry + low-stock alerts                 |

## Audit & notifications

| Method | Path                          | Permission           | Description        |
| ------ | ----------------------------- | -------------------- | ------------------ |
| GET    | `/audit`                      | audit.view           | List audit logs    |
| POST   | `/audit`                      | audit.create         | Write an audit log |
| GET    | `/notifications`              | notifications.view   | List notifications |
| PATCH  | `/notifications/read`         | notifications.update | Mark as read       |
| GET    | `/notifications/unread-count` | notifications.view   | Unread count       |

## Health

| Method | Path      | Description                    |
| ------ | --------- | ------------------------------ |
| GET    | `/health` | Service + DB connection status |
| GET    | `/info`   | Service name, version, mode    |
