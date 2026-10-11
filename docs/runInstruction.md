# Run instructions

How to run the digital wallet backend and its tests on your own computer (Windows, macOS or Linux). Takes about 10 minutes the first time.

## 1. What you need

| Tool | Version | Check with |
| --- | --- | --- |
| Node.js | 22 or newer | `node -v` |
| npm | comes with Node | `npm -v` |
| PostgreSQL | 15 or newer (16 tested) | `psql --version` |

You also need to know your **Postgres username and password** (the user is usually `postgres`; you chose the password when installing). The user must be allowed to create databases, because the tests create temporary ones.

No Postgres yet? Either install it from postgresql.org, or run it in Docker (this is the same setup our CI uses, with no password):

```bash
docker run -d --name wallet-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
```

## 2. Install the project

Open a terminal in the project folder (the one containing `package.json`) and run:

```bash
npm ci
```

## 3. Create your `.env` file

The project reads its settings from a file named `.env` in the project root. Copy the template, then edit it.

| System | Command |
| --- | --- |
| Windows (Command Prompt) | `copy .env.example .env` |
| Windows (PowerShell), macOS, Linux | `cp .env.example .env` |

Open `.env` in any editor and set the two connection URLs:

```ini
DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/wallet
TEST_ADMIN_URL=postgres://postgres:YOURPASSWORD@localhost:5432/postgres
```

- Replace `YOURPASSWORD` with your Postgres password.
- If you used the Docker command above (no password), write the URLs without it: `postgres://postgres@localhost:5432/wallet`.
- If your password contains special characters, URL-encode them: `@` becomes `%40`, `:` becomes `%3A`, `/` becomes `%2F`, `#` becomes `%23`, space becomes `%20`.
- Different user or port? Change `postgres` and `5432` to match.
- Windows tip: make sure the file is named exactly `.env`, not `.env.txt`.

Real environment variables always override the file. Never commit `.env` (it is already in `.gitignore`).

## 4. Create the database (once)

The `wallet` database must exist before the first migration. Choose one:

- **pgAdmin:** right-click *Databases*, then *Create*, then *Database*, name it `wallet`, Save.
- **Command line** (asks for your password):

  ```bash
  createdb -U postgres wallet
  ```

  On Windows, if `createdb` is not found, use the full path, for example: `"C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres wallet` (change `16` to your version).
- **Docker:** `docker exec wallet-pg createdb -U postgres wallet`

## 5. Create the tables and start the API

```bash
npm run migrate      # prints "applied 001_core.sql ..." and "done (4 applied)"
npm run api          # leave this running
```

Check it works: open http://localhost:3000/health in a browser. You should see `{"ok":true}`.

Leave this terminal open. Use a **second terminal** (in the same folder) for everything below.

## 6. Run the demo (recommended first look)

With the API running in the first terminal:

```bash
npm run demo
```

It creates two users, sends money, retries the same request safely (idempotency), triggers a fraud-rule hold and an admin release, runs reconciliation, and asks a plain-English question about the statement. Each step prints what happened.

## 7. Run the tests

```bash
npm run typecheck    # TypeScript check, should print nothing
npm test             # 96 tests in 7 files, about 30 seconds
```

- The tests do not touch your `wallet` database. Each test file clones a temporary database from a template and drops it afterwards.
- Run one file: `npx vitest run test/stampede.test.ts`
- Files: `basics`, `stampede` (100 concurrent transfers, 20 runs), `idempotency`, `reconcile`, `risk`, `qa`, `shard`.

## 8. Optional extras

| Command | What it does |
| --- | --- |
| `npm run seed` | Fills `wallet` with 1,000 users, 2,000 wallets and 100,000 transfers (about 15 s) |
| `npm run worker -- --once` | Runs the nightly job once: reconciliation, then flag explanations, then old-key cleanup |
| `npm run worker` | Runs the nightly scheduler (default 02:00 India time; change `RECON_CRON` in `.env`) |
| `npm run lab:naive` | Proves the naive transfer loses money and the locked one does not (rewrites `docs/naive-stampede.md`) |
| `npm run lab:isolation` | Replays the two-session isolation experiments (rewrites `docs/isolation.md`) |
| `npm run lab:bench` | Measures the cost of the fraud rules (needs `npm run seed` first) |
| `npm run lab:explain` | Builds a large benchmark database and writes `docs/explain.md`. Slow, optional |

The labs overwrite files in `docs/` with numbers from your machine.

## 9. Try the API by hand

Users identify themselves with the `X-User-Id` header and admins with `X-Admin-Token` (a stand-in for real login). Every POST needs a fresh `Idempotency-Key` UUID. Easiest from Node, in a Command Prompt, PowerShell or any shell:

```bash
node -e "fetch('http://localhost:3000/users',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:'Test User',email:'t'+Date.now()+'@example.com',phone:'+91'+String(Date.now()).slice(-10)})}).then(r=>r.json()).then(console.log)"
```

For the full list of endpoints, see the API table in `README.md`. `scripts/demo.ts` is a complete worked example of every call.

## 10. Run everything with Docker instead (optional)

```bash
docker compose up
```

This starts Postgres, the API on port 3000 and the nightly worker, and runs migrations automatically. It uses its own database user and password defined in `docker-compose.yml`, so your `.env` is not needed. **Note:** this path has not been tested by the author (no Docker in the build environment). If it fails, use sections 2 to 6.

## 11. Start fresh

To wipe the data and begin again, drop and recreate the database, then migrate:

```bash
dropdb -U postgres wallet
createdb -U postgres wallet
npm run migrate
```

## Troubleshooting

| You see | Cause and fix |
| --- | --- |
| `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` | Postgres wants a password and none reached the app. Check `.env` exists in the project root, is named exactly `.env`, and the URLs contain your password. |
| `password authentication failed for user "postgres"` | Wrong password or username in the URL. Test it: `psql "postgres://postgres:YOURPASSWORD@localhost:5432/postgres" -c "select 1"` |
| `database "wallet" does not exist` | Skipped section 4. Create the database, then re-run `npm run migrate`. |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres is not running (start the service or the Docker container), or it is on another port. |
| `Cannot reach the API at http://localhost:3000` (from `npm run demo`) | Start the API first in another terminal: `npm run api`. |
| `EADDRINUSE ... 3000` | Something else uses port 3000. Set `PORT=3001` in `.env` (and `API=http://localhost:3001` when running the demo). |
| `permission denied to create database` (tests) | The user in `TEST_ADMIN_URL` needs the CREATEDB right. Use a superuser such as `postgres`. |
| Tests print `Tests closed successfully but something prevents Vite server from exiting` | Harmless message when the run itself passed. Press Ctrl+C if it does not return. |
| Special characters in the password break the URL | URL-encode them (see section 3). |
| Settings in `.env` seem ignored, as if there were no file | Node is older than 20.12, which silently skips `.env`. Check `node -v` and install Node 22 or newer. |

## About the LLM features

With no `ANTHROPIC_API_KEY` in `.env`, the statement Q&A and fraud-flag explanations use a built-in **mock model**: deterministic and offline, good for the demo and the tests. To use a real model, put your key in `.env` as `ANTHROPIC_API_KEY=...`. Automated tests always use the mock.