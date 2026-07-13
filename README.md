# Rentman MCP Server

A small remote MCP (Model Context Protocol) server that gives ChatGPT and Claude direct, live
access to our Rentman account — projects, equipment, contacts, crew, and any other Rentman
resource — without the endpoint cap, CSV lookup table, or pagination bugs the old Custom GPT had.

Once deployed, every AE adds this as a **custom connector** in ChatGPT or Claude Desktop (one URL,
pasted once) and can just ask things like "what equipment is booked on the 47G Summit" in plain
English.

Tested end-to-end against the live Rentman API before handoff — see "What was tested" below.

## Tools it exposes

- **rentman_search_projects** — free-text project search (client-side scan, since Rentman's API
  has no text-search filter), or exact lookup by project number / customer id / location id.
- **rentman_project_details** — full project info with customer/venue/contacts/account manager
  resolved to real names (replaces the static CSV mapping file).
- **rentman_project_equipment** — every equipment line on a project, grouped and paginated
  automatically.
- **rentman_get** — fetch any single record by resource + id (e.g. `contacts`, `crew`, `costs`).
- **rentman_query** — generic filtered list against any Rentman resource, for anything not covered
  by the tools above.

## Deploying

Push this folder to a GitHub repo first (private is fine) — both options below deploy from that
repo. The server is written to work either way: it's stateless per-request (a fresh MCP session on
every call, no in-memory state kept between requests), so it runs equally well as a long-lived
process or as a serverless function.

### Option A — Vercel

1. Import the GitHub repo in Vercel (New Project → pick the repo).
2. Vercel auto-detects `api/index.js` as a serverless function — no build config needed.
3. Project Settings → Environment Variables: add `RENTMAN_TOKEN` and `MCP_SHARED_SECRET`.
4. Deploy. Vercel gives you a URL like `https://rentman-mcp.vercel.app`.
5. Your connector URL is: `https://rentman-mcp.vercel.app/mcp?key=<MCP_SHARED_SECRET>`

`vercel.json` rewrites every path to `api/index.js`, so `/mcp` and `/health` both work normally
even though Vercel only auto-routes `/api/*` by default. Cold starts are typically ~1s, much
faster than Render's free tier.

### Option B — Render (free tier)

1. In Render: **New → Web Service**, connect the same GitHub repo.
2. Build command: `npm install`. Start command: `npm start` (runs `server.js`, a normal always-on
   Node process — not the `api/` serverless entry point Vercel uses).
3. Environment tab: add `RENTMAN_TOKEN` and `MCP_SHARED_SECRET`.
4. Deploy. Render gives you a URL like `https://rentman-mcp.onrender.com`.
5. Your connector URL is: `https://rentman-mcp.onrender.com/mcp?key=<MCP_SHARED_SECRET>`

Render's free tier spins the service down after inactivity, so the first request after a while
will be slow (~30s cold start) — Vercel doesn't have this problem, which makes it the better
default choice for this project.

### Local dev

```bash
npm install
cp .env.example .env   # fill in RENTMAN_TOKEN and MCP_SHARED_SECRET
npm start               # runs server.js on http://localhost:3000
```

## Connecting from ChatGPT

Settings → Apps → enable Developer Mode → Add custom connector → paste the connector URL above.

## Connecting from Claude Desktop

Customize → Connectors → "+" → Add custom connector → paste the connector URL above.

## Security notes

- The Rentman token lives only in the server's environment variables — it's never sent to or
  stored by any AE's device.
- The `key` query param is a shared secret gate so random people who find the URL can't query our
  Rentman data. Treat the connector URL itself as sensitive (don't post it in public channels).
- If the Rentman token needs to be rotated, update the `RENTMAN_TOKEN` env var on the host — no
  code change needed.

## What was tested before handoff

Ran locally against the live Rentman API (intheevent account):
- MCP `initialize` handshake
- Auth rejection when the shared-secret key is missing
- `tools/list` — all 5 tools register correctly
- `rentman_search_projects` — found "2026 47G Zero Gravity Summit @ Salt Palace Convention Center"
  (project 5616) as the most recent 47G match, matching manual verification
- `rentman_project_details` — resolved customer/venue/contacts/account manager to real names
- `rentman_project_equipment` — returned all 22 equipment groups / 447 line items for project 5616,
  matching a manual pull done earlier in this project

One real Rentman API quirk found and worked around: cursor-based pagination (`next_page_url`)
silently stops working when a `sort` param is combined with `limit=300` — it returns `null` after
the first page even though more results exist. The search tool uses `offset`-based paging instead,
which does work correctly.
