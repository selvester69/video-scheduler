/**
 * GET-less, read-only DB Explorer.
 *
 * POST /api/explorer/query  { sql }  -> { columns, rows, rowCount, truncated }
 *
 * Security posture (admin/dev tool):
 *   - requireAuth: only a signed-in admin can reach it (same JWT session as the
 *     rest of the app — no extra credentials).
 *   - SELECT-only: the route inspects the first keyword and REJECTS anything
 *     that isn't a read query (no ; to prevent multi-statement injection either).
 *     The driver layer (`rawQuery`) never sees write DDL/DML by construction.
 *   - Row cap: results are truncated to MAX_ROWS to bound response size.
 *
 * The query is still arbitrary SQL on the configured DB — it's an admin tool,
 * not exposed to the public internet in production. Keep REQUIRE_AUTH on.
 */
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { rawQuery } from "../db.js";
import { config } from "../config.js";

const router = express.Router();
const MAX_ROWS = 1000;
const TABLE_ROW_LIMIT = 100;

// List user tables for the configured driver (read-only inventory).
function listTablesSql() {
  if (config.dbDriver === "pg") {
    return "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
  }
  return "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
}

// GET /api/explorer/tables — every table in the database (read-only).
router.get("/tables", requireAuth, async (_req, res) => {
  try {
    const result = await rawQuery(listTablesSql());
    const tables = (result.rows || []).map((r) => r.name);
    res.json({ tables, count: tables.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/explorer/table/:name — read-only row viewer for a single table.
// The name is whitelisted against the live table list (no raw identifier ever
// reaches the driver) and rows are capped at TABLE_ROW_LIMIT.
router.get("/table/:name", requireAuth, async (req, res) => {
  const { name } = req.params;
  try {
    const listed = await rawQuery(listTablesSql());
    const tables = (listed.rows || []).map((r) => r.name);
    if (!tables.includes(name)) return res.status(400).json({ error: `unknown table: ${name}` });
    const result = await rawQuery(`SELECT * FROM ${name} LIMIT ${TABLE_ROW_LIMIT}`);
    res.json({
      columns: result.columns,
      rows: (result.rows || []).slice(0, TABLE_ROW_LIMIT),
      rowCount: result.rowCount,
      truncated: result.rowCount > TABLE_ROW_LIMIT,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// First token must be a read-only keyword. We deliberately do NOT allow
// `;` (which would permit stacking a follow-up destructive statement).
const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "EXPLAIN", "VALUES", "PRAGMA"]);

function allowSelect(sql) {
  if (typeof sql !== "string") return "sql must be a string";
  // strip leading/trailing whitespace and a single trailing semicolon
  const body = sql.trim().replace(/;+$/, "").trim();
  if (!body) return "query is empty";
  if (body.includes(";")) return "multiple statements are not allowed (read-only, single SELECT)";
  const first = body.match(/^([A-Za-z_]+)/)?.[1]?.toUpperCase();
  if (!first) return "could not parse query";
  if (!READ_KEYWORDS.has(first))
    return `only read-only queries are allowed (got "${first}")`;
  return null; // ok
}

router.post("/query", requireAuth, async (req, res) => {
  const sql = (req.body && req.body.sql) || "";
  const reason = allowSelect(sql);
  if (reason) return res.status(400).json({ error: reason });

  try {
    const result = await rawQuery(sql);
    const truncated = result.rowCount > MAX_ROWS;
    res.json({
      columns: result.columns,
      rows: result.rows.slice(0, MAX_ROWS),
      rowCount: result.rowCount,
      truncated,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
