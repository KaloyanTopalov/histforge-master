# CLAUDE.md Examples

Two examples showing well-structured CLAUDE.md files for different stacks. Pick the one closest to your project for structure and tone guidance.

- **Example 1** (line 9): Node.js Task Management API — Express, PostgreSQL, Drizzle, Jest
- **Example 2** (line 58): Python Data Platform Monorepo — FastAPI, Click, Celery, SQLAlchemy, Poetry

---

## Example 1: Node.js Task Management API (~50 lines)

```markdown
# CLAUDE.md

## Project Overview

Task management API built with Node.js, Express, and PostgreSQL. Serves the React frontend at `../task-ui`.

## Development Commands

pnpm install        # Install dependencies (Node >=20)
pnpm dev             # Start dev server (port 3000)
pnpm test            # Run Jest tests
pnpm lint            # ESLint + Prettier check
pnpm db:migrate      # Run Drizzle migrations
pnpm db:generate     # Generate migration from schema changes

## Architecture

src/
    routes/       # Express route handlers
    services/     # Business logic
    db/
        schema.ts    # Drizzle schema (source of truth)
        migrations/  # Generated – never edit directly
    middleware/   # Auth, validation, error handling
    types/        # Shared TypeScript types

## Key Conventions

- **Schema changes:** Edit `src/db/schema.ts`, run `pnpm db:generate`, never edit migrations directly.
- **Error handling:** Throw `AppError` from services; `errorHandler` middleware formats responses.
- **Auth:** JWT via `authMiddleware`. All routes under `/api/` require auth except `/api/auth/*`.

## Branch Strategy

- `main` – production, deployed on merge via GitHub Actions
- `develop` – integration branch, auto-deploys to staging
- Feature branches from `develop`, PRs require passing CI

## Troubleshooting

- Migration failures: Use the `backend-architecture` skill for Drizzle migration patterns
- Test setup issues: Use the `testing-patterns` skill for database fixtures and mocking
```

---

## Example 2: Python Data Platform Monorepo (~55 lines)

```markdown
# CLAUDE.md

## Project Overview

DataForge — a Python monorepo for dataset and pipeline management. FastAPI async API, Click CLI, shared libs. PostgreSQL, Redis, Celery. Python 3.11+, Poetry.

## Development Commands

poetry install                    # Install dependencies
make dev                          # API server (uvicorn, port 8000, hot-reload)
make test                         # pytest (all services + libs)
make test-cov                     # Coverage report
make lint                         # ruff check + mypy (strict)
make format                       # Auto-fix with ruff
make migrate                      # Apply Alembic migrations
make migrate-create msg="desc"    # Generate migration from model changes
make docker-up / docker-down      # Start/stop Postgres + Redis containers
dataforge                         # Run CLI (Poetry script entry point)

## Architecture

services/
    api/app/
        main.py          # FastAPI app, router registration
        routers/         # Route handlers (users, datasets, pipelines)
        services/        # Business logic layer
        models/          # Pydantic schemas
    cli/
        main.py          # Click CLI entry point
        commands/        # Subcommands: upload, query, pipeline
libs/
    common/
        auth/            # Auth dependencies (get_current_user)
        db/session.py    # Async SQLAlchemy engine + session
    ml-pipeline/         # ML model definitions and data processors
infra/                   # Docker, Terraform

## Key Conventions

- **Layered API:** Router (validate) → Service (logic) → DB. Routers never import from `db/` directly.
- **Async everywhere:** Use `AsyncSession` and `await` for all DB operations.
- **Shared libs:** Import as `libs.common.db.session`, not relative imports across services.
- **Schema changes:** Edit SQLAlchemy models, then `make migrate-create msg="description"`. Never hand-edit migrations.
- **CLI entry point:** `services.cli.main:app`, registered as `dataforge` in Poetry scripts.

## Branch Strategy

- CI: ruff check → mypy → pytest against Postgres 16 service container
- Poetry lock file must be committed

## Troubleshooting

- Database/migration issues: Use the `backend-api` skill for async patterns and Alembic workflows
- CLI or pipeline errors: Use the `cli-pipelines` skill for Click patterns and Celery conventions
```
