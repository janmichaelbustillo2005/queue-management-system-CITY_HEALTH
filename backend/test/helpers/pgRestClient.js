// Test-only stand-in for the supabase-js client, backed by a real PostgreSQL pool, so the real
// queueService, presenceService and routes run against installed migrations instead of an
// in-memory model. It implements only the query-builder subset the backend uses and follows
// PostgREST's observable contract where the backend depends on it:
//   * every request is one autocommitted statement, run as service_role in UTC;
//   * rows are serialized with row_to_json (PostgREST's timestamp/bigint JSON format);
//   * an RPC that is not in the schema returns { code: "PGRST202" } (schema-cache miss);
//   * database errors return { code: SQLSTATE, message, details, hint } and never throw;
//   * .single() / .maybeSingle() report PGRST116 for the wrong row count.
// Not a PostgREST reimplementation: no embedding, no Prefer headers, no row limits.
// Disposable loopback databases only; never pointed at Supabase.

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return `"${name}"`;
}

// JSON columns (jsonb/arrays of objects) are sent as JSON text; scalars as-is.
const param = (value) => (value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value);

function toError(error) {
  return { code: error.code, message: error.message, details: error.detail ?? null, hint: error.hint ?? null };
}

function createPgRestClient(pool, { onRequest } = {}) {
  class Query {
    constructor(table) {
      this.name = table;
      this.table = quoteIdent(table);
      this.action = "select";
      this.columns = "*";
      this.returning = false;
      this.where = [];
      this.values = [];
      this.orders = [];
      this.limitValue = null;
      this.offsetValue = null;
    }
    bind(value) { this.values.push(value); return `$${this.values.length}`; }
    select(columns = "*") { this.columns = columns; if (this.action !== "select") this.returning = true; return this; }
    insert(payload) { this.action = "insert"; this.payload = payload; return this; }
    upsert(payload, options = {}) { this.action = "upsert"; this.payload = payload; this.upsertOptions = options; return this; }
    update(payload) { this.action = "update"; this.payload = payload; return this; }
    delete() { this.action = "delete"; return this; }
    compare(column, operator, value) { this.where.push(`t.${quoteIdent(column)} ${operator} ${this.bind(param(value))}`); return this; }
    eq(column, value) { return this.compare(column, "=", value); }
    neq(column, value) { return this.compare(column, "<>", value); }
    gt(column, value) { return this.compare(column, ">", value); }
    gte(column, value) { return this.compare(column, ">=", value); }
    lt(column, value) { return this.compare(column, "<", value); }
    lte(column, value) { return this.compare(column, "<=", value); }
    like(column, value) { return this.compare(column, "LIKE", value); }
    in(column, values) { this.where.push(`t.${quoteIdent(column)} = ANY(${this.bind(values)})`); return this; }
    is(column, value) {
      if (![null, true, false].includes(value)) throw new Error(`Unsupported is(${value})`);
      this.where.push(`t.${quoteIdent(column)} IS ${value === null ? "NULL" : String(value).toUpperCase()}`);
      return this;
    }
    match(object) { for (const [key, value] of Object.entries(object)) this.eq(key, value); return this; }
    order(column, { ascending = true } = {}) { this.orders.push(`t.${quoteIdent(column)} ${ascending ? "ASC" : "DESC"}`); return this; }
    limit(count) { this.limitValue = count; return this; }
    range(from, to) { this.offsetValue = from; this.limitValue = to - from + 1; return this; }
    single() { this.cardinality = "single"; return this.run(); }
    maybeSingle() { this.cardinality = "maybe"; return this.run(); }
    then(resolve, reject) { return this.run().then(resolve, reject); }

    projection(alias) {
      if (this.columns.trim() === "*") return `row_to_json(${alias})`;
      const columns = this.columns.split(",").map((column) => `${alias}.${quoteIdent(column.trim())}`);
      return `(SELECT row_to_json(s) FROM (SELECT ${columns.join(", ")}) AS s)`;
    }
    sql() {
      const where = this.where.length ? ` WHERE ${this.where.join(" AND ")}` : "";
      if (this.action === "select") {
        return `SELECT ${this.projection("t")} AS row FROM public.${this.table} AS t${where}` +
          (this.orders.length ? ` ORDER BY ${this.orders.join(", ")}` : "") +
          (this.limitValue != null ? ` LIMIT ${Number(this.limitValue)}` : "") +
          (this.offsetValue != null ? ` OFFSET ${Number(this.offsetValue)}` : "");
      }
      const returning = ` RETURNING *) SELECT ${this.projection("t")} AS row FROM changed AS t`;
      if (this.action === "update") {
        const sets = Object.entries(this.payload).map(([key, value]) => `${quoteIdent(key)} = ${this.bind(param(value))}`);
        return `WITH changed AS (UPDATE public.${this.table} AS t SET ${sets.join(", ")}${where}${returning}`;
      }
      if (this.action === "delete") return `WITH changed AS (DELETE FROM public.${this.table} AS t${where}${returning}`;
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const tuples = rows.map((row) => `(${keys.map((key) => (key in row ? this.bind(param(row[key])) : "DEFAULT")).join(", ")})`);
      let conflict = "";
      if (this.action === "upsert") {
        const target = (this.upsertOptions.onConflict || "id").split(",").map((key) => quoteIdent(key.trim()));
        conflict = this.upsertOptions.ignoreDuplicates ? ` ON CONFLICT (${target.join(", ")}) DO NOTHING`
          : ` ON CONFLICT (${target.join(", ")}) DO UPDATE SET ${keys.map((key) => `${quoteIdent(key)} = EXCLUDED.${quoteIdent(key)}`).join(", ")}`;
      }
      return `WITH changed AS (INSERT INTO public.${this.table} (${keys.map(quoteIdent).join(", ")}) VALUES ${tuples.join(", ")}${conflict}${returning}`;
    }
    async run() {
      if (onRequest) await onRequest({ kind: "table", table: this.name, action: this.action, values: this.values });
      let rows;
      try {
        rows = (await pool.query(this.sql(), this.values)).rows.map((row) => row.row);
      } catch (error) {
        return { data: null, error: toError(error) };
      }
      if (this.action !== "select" && !this.returning) return { data: null, error: null };
      if (this.cardinality) {
        if (rows.length > 1 || (this.cardinality === "single" && rows.length === 0)) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        }
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    }
  }

  async function rpc(name, args = {}) {
    if (onRequest) await onRequest({ kind: "rpc", name, args });
    const keys = Object.keys(args);
    try {
      // PostgREST resolves a function by name and argument names from its schema cache.
      const { rows: [fn] } = await pool.query(`SELECT p.oid::regprocedure::text AS signature, p.proretset AS set,
          p.prorettype = 'pg_catalog.void'::regtype AS void
        FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1 AND $2::text[] <@ COALESCE(p.proargnames, '{}')
        ORDER BY p.oid LIMIT 1`, [name, keys]);
      if (!fn) {
        return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}(${keys.join(", ")}) in the schema cache` } };
      }
      const call = `public.${quoteIdent(name)}(${keys.map((key, index) => `${quoteIdent(key)} => $${index + 1}`).join(", ")})`;
      const values = keys.map((key) => param(args[key]));
      if (fn.void) { await pool.query(`SELECT ${call}`, values); return { data: null, error: null }; }
      if (fn.set) {
        const { rows } = await pool.query(`SELECT to_jsonb(r) AS value FROM ${call} AS r`, values);
        return { data: rows.map((row) => row.value), error: null };
      }
      const { rows: [row] } = await pool.query(`SELECT to_jsonb(${call}) AS value`, values);
      return { data: row.value, error: null };
    } catch (error) {
      return { data: null, error: toError(error) };
    }
  }

  return { from: (table) => new Query(table), rpc };
}

module.exports = { createPgRestClient };
