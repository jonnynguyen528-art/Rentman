import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const RENTMAN_BASE = "https://api.rentman.net";
const RENTMAN_TOKEN = process.env.RENTMAN_TOKEN;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET;

if (!RENTMAN_TOKEN) {
  console.error("Missing RENTMAN_TOKEN env var. Set it before starting the server.");
}

// ---------- Rentman API helpers ----------

async function rentmanRequest(path, { params, followCursor = true, maxPages = 10 } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${RENTMAN_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const allData = [];
  let currentUrl = url.toString();
  let pages = 0;
  let lastMeta = null;

  while (currentUrl && pages < maxPages) {
    const res = await fetch(currentUrl, {
      headers: {
        Authorization: `Bearer ${RENTMAN_TOKEN}`,
        Accept: "application/json"
      }
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Rentman returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(`Rentman API error (HTTP ${res.status}): ${JSON.stringify(body)}`);
    }

    lastMeta = { itemCount: body.itemCount, limit: body.limit, offset: body.offset };

    if (Array.isArray(body.data)) {
      allData.push(...body.data);
    } else if (body.data) {
      // single-item response
      return { data: body.data, meta: lastMeta };
    }

    pages += 1;

    if (!followCursor || !body.next_page_url) {
      currentUrl = null;
    } else {
      // Known Rentman API quirk: on some nested endpoints next_page_url comes back
      // with a literal "{id}" placeholder instead of the real path segment.
      // Guard against that by falling back to stopping pagination rather than
      // requesting a broken URL.
      if (body.next_page_url.includes("{id}")) {
        currentUrl = null;
      } else {
        currentUrl = body.next_page_url;
      }
    }
  }

  return { data: allData, meta: lastMeta, truncated: pages >= maxPages };
}

async function resolveName(resource, id) {
  if (!id) return null;
  try {
    const { data } = await rentmanRequest(`/${resource}/${id}`);
    return data?.displayname || data?.name || `[${resource} ${id}]`;
  } catch {
    return `[${resource} ${id}]`;
  }
}

function summarizeProject(p) {
  return {
    id: p.id,
    displayname: p.displayname,
    number: p.number,
    reference: p.reference,
    created: p.created,
    usageperiod_start: p.usageperiod_start,
    usageperiod_end: p.usageperiod_end
  };
}

function extractId(ref) {
  if (ref === null || ref === undefined) return null;
  const match = String(ref).match(/(\d+)$/);
  return match ? match[1] : null;
}

// ---------- MCP server / tools ----------

function createMcpServer() {
  const server = new McpServer({ name: "rentman", version: "1.0.0" });

  server.tool(
    "rentman_query",
    "Generic read-only query against any Rentman API resource (e.g. projects, contacts, crew, " +
      "contactpersons, equipment, projectequipment, projectequipmentgroup, costs, warehouses, " +
      "contracts). Filters are passed through as Rentman API query params (e.g. {\"customer\": \"7997\"}). " +
      "Automatically paginates up to 10 pages (3000 items) unless a limit is given.",
    {
      resource: z.string().describe("Rentman resource path, e.g. 'projects' or 'contacts'"),
      filters: z.record(z.string()).optional().describe("Query filters as key/value pairs"),
      limit: z.number().optional().describe("Rentman page size (max ~300 per page)"),
      offset: z.number().optional(),
      all_pages: z.boolean().optional().describe("If true, follow pagination to collect all matches (default true)")
    },
    async ({ resource, filters, limit, offset, all_pages }) => {
      const { data, meta, truncated } = await rentmanRequest(`/${resource}`, {
        params: { ...filters, limit, offset },
        followCursor: all_pages !== false
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: Array.isArray(data) ? data.length : 1, meta, truncated, data }, null, 2)
          }
        ]
      };
    }
  );

  server.tool(
    "rentman_get",
    "Fetch a single Rentman record by resource type and internal numeric ID (e.g. resource='projects', id=5616).",
    {
      resource: z.string(),
      id: z.number()
    },
    async ({ resource, id }) => {
      const { data } = await rentmanRequest(`/${resource}/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "rentman_search_projects",
    "Search Rentman projects by free-text query (matches displayname, name, or reference — " +
      "Rentman's API has no server-side text search, so this scans recent projects client-side, " +
      "most recently created first). Also supports exact filtering by customer id, location id, " +
      "or project number. For a known internal project id, use rentman_get instead.",
    {
      query: z.string().optional().describe("Text to match against project name/reference"),
      number: z.string().optional().describe("Exact visible project number"),
      customer_id: z.number().optional(),
      location_id: z.number().optional(),
      limit: z.number().optional().default(10),
      scan_pages: z.number().optional().default(6).describe("How many 300-item pages of recent projects to scan when using 'query' (max ~10)")
    },
    async ({ query, number, customer_id, location_id, limit, scan_pages }) => {
      // Exact filters Rentman's API does support server-side.
      if (number || customer_id || location_id) {
        const filters = { sort: "-created" };
        if (number) filters.number = number;
        if (customer_id) filters.customer = `/contacts/${customer_id}`;
        if (location_id) filters.location = `/contacts/${location_id}`;

        const { data } = await rentmanRequest("/projects", {
          params: { ...filters, limit: Math.max(limit, 50) },
          followCursor: false
        });

        const results = data.slice(0, limit).map(summarizeProject);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      if (!query) {
        return {
          content: [{ type: "text", text: "Provide at least one of: query, number, customer_id, location_id." }],
          isError: true
        };
      }

      // Rentman has no icontains/text-search filter on /projects, so we page through
      // recent projects (sorted newest-created-first) and filter client-side.
      // Note: Rentman's cursor pagination (next_page_url) does not advance when a
      // sort param is combined with limit=300 — it comes back null after page 1 even
      // though more results exist. Use plain offset paging instead, which does work.
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [];
      let pages = 0;

      while (pages < scan_pages) {
        const res = await fetch(
          `${RENTMAN_BASE}/projects?sort=-created&limit=300&offset=${pages * 300}`,
          { headers: { Authorization: `Bearer ${RENTMAN_TOKEN}`, Accept: "application/json" } }
        );
        const body = await res.json();
        if (!res.ok) throw new Error(`Rentman API error (HTTP ${res.status}): ${JSON.stringify(body)}`);

        for (const p of body.data || []) {
          const haystack = `${p.displayname || ""} ${p.name || ""} ${p.reference || ""}`.toLowerCase();
          if (tokens.every((t) => haystack.includes(t))) {
            matches.push(p);
          }
        }

        pages += 1;
        if (!body.data || body.data.length < 300) break; // reached the end of all projects
        if (matches.length >= limit * 3) break; // enough candidates, stop scanning early
      }

      const results = matches.slice(0, limit).map(summarizeProject);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ pages_scanned: pages, match_count: matches.length, results }, null, 2)
          }
        ]
      };
    }
  );

  server.tool(
    "rentman_project_details",
    "Get full details for one Rentman project by internal ID, with customer, location, contacts, " +
      "and account manager resolved to readable names instead of raw IDs.",
    { project_id: z.number() },
    async ({ project_id }) => {
      const { data: p } = await rentmanRequest(`/projects/${project_id}`);

      const [customer, location, custContact, locContact, accountManager] = await Promise.all([
        resolveName("contacts", extractId(p.customer)),
        resolveName("contacts", extractId(p.location)),
        resolveName("contactpersons", extractId(p.cust_contact)),
        resolveName("contactpersons", extractId(p.loc_contact)),
        resolveName("crew", extractId(p.account_manager))
      ]);

      const summary = {
        id: p.id,
        displayname: p.displayname,
        number: p.number,
        reference: p.reference,
        created: p.created,
        usageperiod_start: p.usageperiod_start,
        usageperiod_end: p.usageperiod_end,
        customer,
        location,
        cust_contact: custContact,
        loc_contact: locContact,
        account_manager: accountManager,
        project_total_price: p.project_total_price,
        project_rental_price: p.project_rental_price,
        project_crew_price: p.project_crew_price
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "rentman_project_equipment",
    "Get every equipment line booked on a Rentman project, grouped by equipment group " +
      "(e.g. 'Main Stage', 'Registration'). Handles pagination automatically. Use this instead of " +
      "manually calling rentman_query on projectequipmentgroup/projectequipment.",
    { project_id: z.number() },
    async ({ project_id }) => {
      const { data: groups } = await rentmanRequest("/projectequipmentgroup", {
        params: { project: `/projects/${project_id}`, limit: 300 }
      });

      const grouped = [];
      for (const group of groups) {
        const { data: lines } = await rentmanRequest("/projectequipment", {
          params: { equipment_group: `/projectequipmentgroup/${group.id}`, limit: 300 }
        });

        grouped.push({
          group: group.displayname || group.name,
          group_id: group.id,
          item_count: lines.length,
          total_units: lines.reduce((sum, l) => sum + (l.quantity || 0), 0),
          items: lines.map((l) => ({
            name: l.name || l.displayname,
            quantity: l.quantity,
            unit_price: l.unit_price,
            is_option: l.is_option
          }))
        });
      }

      return { content: [{ type: "text", text: JSON.stringify({ project_id, groups: grouped }, null, 2) }] };
    }
  );

  server.tool(
    "rentman_search_equipment",
    "Search Rentman equipment/inventory items by free-text query (matches name, displayname, or " +
      "code — Rentman's API has no server-side text search, so this scans equipment client-side). " +
      "Use this to find an item's internal id before calling rentman_equipment_inventory, or to " +
      "browse inventory by category/brand keyword.",
    {
      query: z.string().describe("Text to match against item name/displayname/code, e.g. 'Moab Sofa'"),
      limit: z.number().optional().default(20),
      scan_pages: z.number().optional().default(25).describe("How many 300-item pages of equipment to scan (our inventory is ~5,200 items / ~18 pages, so this defaults high enough to cover all of it)")
    },
    async ({ query, limit, scan_pages }) => {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [];
      let pages = 0;

      while (pages < scan_pages) {
        const res = await fetch(
          `${RENTMAN_BASE}/equipment?limit=300&offset=${pages * 300}`,
          { headers: { Authorization: `Bearer ${RENTMAN_TOKEN}`, Accept: "application/json" } }
        );
        const body = await res.json();
        if (!res.ok) throw new Error(`Rentman API error (HTTP ${res.status}): ${JSON.stringify(body)}`);

        for (const item of body.data || []) {
          const haystack = `${item.displayname || ""} ${item.name || ""} ${item.code || ""}`.toLowerCase();
          if (tokens.every((t) => haystack.includes(t))) {
            matches.push({
              id: item.id,
              name: item.displayname || item.name,
              code: item.code,
              price: item.price,
              rental_sales: item.rental_sales,
              stock_management: item.stock_management
            });
          }
        }

        pages += 1;
        if (!body.data || body.data.length < 300) break; // reached the end of all equipment
        if (matches.length >= limit * 3) break; // enough candidates, stop scanning early
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { pages_scanned: pages, match_count: matches.length, results: matches.slice(0, limit) },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.tool(
    "rentman_equipment_inventory",
    "Get how many units of an equipment item we own, by internal equipment id. Uses Rentman's " +
      "own current_quantity field (its actual stock count for that item) plus, for individually " +
      "serialized/asset-tracked items, a count of registered serial numbers as a cross-check. " +
      "Use rentman_search_equipment first to find the id if you only have a name.",
    { equipment_id: z.number() },
    async ({ equipment_id }) => {
      const [item, total, active] = await Promise.all([
        rentmanRequest(`/equipment/${equipment_id}`),
        rentmanRequest("/serialnumbers", { params: { equipment: `/equipment/${equipment_id}`, limit: 1 } }),
        rentmanRequest("/serialnumbers", { params: { equipment: `/equipment/${equipment_id}`, active: 1, limit: 1 } })
      ]);

      const summary = {
        equipment_id,
        name: item.data?.displayname || item.data?.name,
        code: item.data?.code,
        stock_management: item.data?.stock_management,
        current_quantity: item.data?.current_quantity,
        current_quantity_excl_cases: item.data?.current_quantity_excl_cases,
        registered_serial_numbers: total.meta?.itemCount ?? total.data.length,
        active_serial_numbers: active.meta?.itemCount ?? active.data.length
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  return server;
}

// ---------- HTTP transport (Express app — used by both server.js and api/index.js) ----------

export const app = express();
app.use(express.json({ limit: "5mb" }));

function checkAuth(req, res) {
  if (!SHARED_SECRET) return true; // no auth configured — not recommended for anything but local testing
  const key = req.query.key || req.headers["x-rentman-mcp-key"];
  if (key !== SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized. Missing or invalid connector key." });
    return false;
  }
  return true;
}

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  }
});

app.get("/health", (req, res) => res.json({ ok: true, hasToken: Boolean(RENTMAN_TOKEN) }));

export default app;
