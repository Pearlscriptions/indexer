#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv(resolve(".env"));

const databaseUrl = process.env.PRL20_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  process.stderr.write("PRL20_DATABASE_URL or DATABASE_URL is required\n");
  process.exit(1);
}

const schemaPath = resolve("db/schema-postgres-v0.sql");
const schemaSql = readFileSync(schemaPath, "utf8");
const { Pool } = await import("pg");
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(schemaSql);
  process.stdout.write("database migration applied\n");
} finally {
  await pool.end();
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = unquoteEnvValue(line.slice(separator + 1).trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
