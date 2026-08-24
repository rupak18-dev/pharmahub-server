# PharmaHub Server — README

Backend API for the PharmaHub pharmacy management system.

- **Stack:** Node.js + Express + JavaScript (ESM) + MongoDB (Mongoose)
- **Validation:** zod (mirrors the schemas used by the frontend)
- **Auth:** JWT (Bearer) + role-based access control
- **Base URL:** `/api/v1`

## Requirements

- Node.js >= 20
- MongoDB running locally (`mongodb://127.0.0.1:27017`) or a remote connection string

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#   edit .env and set a strong JWT_SECRET, plus your MONGO_URI if needed

# 3. Seed demo data (optional)
npm run seed

# 4. Start in development mode (auto-reload)
npm run dev
```

The API will be available at `http://localhost:5000/api/v1`.

## Scripts

| Command          | Description                                  |
| ---------------- | -------------------------------------------- |
| `npm run dev`    | Start with nodemon (auto-restart)            |
| `npm start`      | Start in production mode                     |
| `npm run seed`   | Seed the database (add `--force` to reset)   |
| `npm test`       | Run tests (Node test runner)                 |
| `npm run lint`   | Lint with ESLint                             |

## Demo accounts

Demo accounts were removed in favor of real authentication. Accounts are created
by registering through the app (or `POST /api/v1/auth/register`).

## Quick smoke test

```bash
curl http://localhost:5000/api/v1/health

curl -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'

curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'
```

Use the returned `token` in the `Authorization: Bearer <token>` header for all
other endpoints.

## Documentation

- [API.md](docs/API.md) — complete endpoint reference
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — folder structure and layering
- [DATA_MODEL.md](docs/DATA_MODEL.md) — MongoDB collections and relationships

## Deployment (Render)

A push to `main` runs the CI + deploy workflow (`.github/workflows/deploy.yml`):
lint and tests, then a deploy is triggered on Render via its REST API.

**GitHub repository secrets** (Settings → Secrets and variables → Actions):

| Secret              | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| `RENDER_API_KEY`    | Render.com → Account settings → API keys                     |
| `RENDER_SERVICE_ID` | The `srv-...` ID from your Render service URL                 |

**Render service env vars** (set in the Render dashboard):

| Var         | Example                                            |
| ----------- | -------------------------------------------------- |
| `MONGO_URI` | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/pharmahub` |
| `JWT_SECRET`| a long random string                                |

The service definition is also version-controlled in [`render.yaml`](render.yaml)
(web service, Node runtime, `npm start`, health check at `/api/v1/health`).

## Folder structure

```
pharmahub-server/
├── src/
│   ├── config/         env, DB connection, constants
│   ├── core/           app bootstrap, server entry, logger, responses, ApiError
│   ├── models/         Mongoose schemas/models
│   ├── controllers/    HTTP request handlers
│   ├── routes/         Express routers (one per resource)
│   ├── services/       business logic (sales, purchases, inventory, reports)
│   ├── middlewares/    auth, authorize, validate, errorHandler, notFound
│   ├── types/          JSDoc typedefs + zod request validation schemas
│   └── utils/          id generation, dates, pagination
├── docs/
├── scripts/            seed.js
└── tests/              integration + health tests
```

## License

MIT
