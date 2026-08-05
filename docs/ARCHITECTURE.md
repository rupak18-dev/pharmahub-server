# PharmaHub Server — Architecture

## Layering

```
routes ──> controllers ──> services ──> models ──> MongoDB
   │            │              │
   │            └──────────────┴── middlewares (auth / authorize / validate)
   │
   └── shared: core (app, logger, responses, ApiError), config, utils, types
```

- **routes/** — define HTTP verbs and wire middleware + controllers. No business logic.
- **controllers/** — parse requests, call services, shape HTTP responses. No DB queries.
- **services/** — business rules and data access (transactions, FEFO picking, GRN receiving). No HTTP concerns.
- **models/** — Mongoose schemas, indexes, virtuals, and model statics.
- **middlewares/** — cross-cutting concerns: JWT auth, role/permission checks, zod validation, error handling.
- **config/** — environment loading, DB connection, domain constants.
- **core/** — app factory, server entry, logger, response helpers, `ApiError`.
- **types/** — JSDoc typedefs and zod validation schemas for request bodies.
- **utils/** — pure helpers (id generation, dates, pagination).

## Request lifecycle

1. Request arrives → `helmet`, `cors`, `json`, `morgan`, rate limiter.
2. Routed under `/api/v1`.
3. `auth` middleware verifies the JWT and loads the user.
4. `authorize(module, action)` checks the role's permission matrix (from `Role`).
5. `validate(schema)` (zod) validates and sanitizes the body.
6. Controller calls a service; service performs the work (optionally in a Mongo transaction).
7. Response helpers emit the standard `{ success, data, message, meta }` envelope.
8. Errors are centralized: `ApiError` → correct status code; unknown errors → 500.

## Key services

| Service                | Responsibility                                            |
| ---------------------- | --------------------------------------------------------- |
| `sale.service.js`      | FEFO batch picking, stock deduction, invoice totals, void (restore stock) |
| `purchase.service.js`  | Purchase orders, GRN receiving → creates batches + stock  |
| `inventory.service.js` | Stock add/remove/adjust inside Mongo transactions, ledger + movements |
| `batch.service.js`     | Auto-classify batch status from expiry dates              |
| `report.service.js`    | Sales/purchase/expiry/stock valuation aggregates          |
| `dashboard.service.js` | Today/week metrics, sales trend, alerts                   |
| `audit.service.js`     | Non-blocking audit trail writes                           |

## Transactions

Multi-step operations (sales, GRN receiving, stock adjustments, voiding) run
inside Mongo sessions with `withTransaction` so stock is never partially
deducted on failure.

## Conventions

- ESM modules (`"type": "module"`).
- Controllers are thin; services hold the logic.
- All async controller handlers are wrapped with `asyncHandler` so thrown errors reach the error middleware.
- Route files export a single `Router`.
- Endpoints are mapped to the permission matrix via `authorize("module", "action")`; roles mirror `src/lib/permissions.js` in the frontend repo.
- Validation schemas live in `src/types/index.js` and are zod-based, matching the frontend's zod usage.

## Testing

- `tests/health.test.js` — server smoke tests (no DB required).
- `tests/api.test.js` — full flow against a real MongoDB (skipped automatically if unavailable).
- Run: `npm test`.
