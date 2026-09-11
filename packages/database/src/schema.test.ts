import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { isTable, getTableName } from "drizzle-orm";
import { getTableConfig, IndexedColumn, type PgTable } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";

import * as schema from "./schema/index.js";

type DefaultValue =
  | { kind: "none" }
  | { kind: "sql" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; value: unknown[] };

interface ParsedColumn {
  type: string;
  notNull: boolean;
  primary: boolean;
  defaultValue: DefaultValue;
}

interface ParsedTable {
  columns: Map<string, ParsedColumn>;
  uniques: Map<string, string[]>;
}

interface ParsedForeignKey {
  table: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface ParsedSchema {
  tables: Map<string, ParsedTable>;
  indexes: Map<string, { table: string; unique: boolean; columns: string[] }>;
  foreignKeys: Map<string, ParsedForeignKey>;
}

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const DRIZZLE_TYPE_BY_SQL_TYPE: Record<string, string> = {
  text: "string",
  integer: "number",
  boolean: "boolean",
  timestamp: "date",
  "text[]": "array",
};

function parseColumnList(raw: string): string[] {
  return raw
    .split(",")
    .map((column) => column.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function parseDefault(raw: string | undefined): DefaultValue {
  if (raw === undefined) return { kind: "none" };
  const value = raw.trim();

  if (value.endsWith("()")) return { kind: "sql" };
  if (value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (inner.startsWith("{") && inner.endsWith("}")) {
      return { kind: "array", value: parseColumnList(inner.slice(1, -1)) };
    }
    return { kind: "literal", value: inner };
  }
  if (value === "true" || value === "false") return { kind: "literal", value: value === "true" };
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return { kind: "literal", value: Number(value) };

  throw new Error(`Unsupported default expression: ${value}`);
}

function parseColumn(line: string): [string, ParsedColumn] {
  const match = line.match(/^"([^"]+)" ([a-z]+(?:\[\])?)(.*)$/);
  if (!match) throw new Error(`Unsupported column definition: ${line}`);

  const [, name, type, rawFlags] = match;
  if (!(type in DRIZZLE_TYPE_BY_SQL_TYPE)) throw new Error(`Unsupported column type: ${type}`);

  let flags = rawFlags;
  const primary = /\bPRIMARY KEY\b/.test(flags);
  flags = flags.replace(/\bPRIMARY KEY\b/, "");
  const notNull = /\bNOT NULL\b/.test(flags);
  flags = flags.replace(/\s*\bNOT NULL\b/, "");
  const defaultMatch = flags.match(/\bDEFAULT (.+)$/);

  return [
    name,
    {
      type: DRIZZLE_TYPE_BY_SQL_TYPE[type],
      notNull,
      primary,
      defaultValue: parseDefault(defaultMatch?.[1]),
    },
  ];
}

function parseCreateTable(name: string, body: string, parsed: ParsedSchema): void {
  const table: ParsedTable = { columns: new Map(), uniques: new Map() };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (!line) continue;

    const unique = line.match(/^CONSTRAINT "([^"]+)" UNIQUE\(([^)]*)\)$/);
    if (unique) {
      table.uniques.set(unique[1], parseColumnList(unique[2]));
      continue;
    }

    const [columnName, column] = parseColumn(line);
    table.columns.set(columnName, column);
  }

  parsed.tables.set(name, table);
}

function parseSql(statements: string[]): ParsedSchema {
  const parsed: ParsedSchema = { tables: new Map(), indexes: new Map(), foreignKeys: new Map() };

  for (const statement of statements) {
    const createTable = statement.match(/^CREATE TABLE "([^"]+)" \(([\s\S]*)\)$/);
    if (createTable) {
      parseCreateTable(createTable[1], createTable[2], parsed);
      continue;
    }

    const foreignKey = statement.match(
      /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "public"\."([^"]+)"\(([^)]*)\) ON DELETE (.+?) ON UPDATE (.+)$/,
    );
    if (foreignKey) {
      parsed.foreignKeys.set(foreignKey[2], {
        table: foreignKey[1],
        columns: parseColumnList(foreignKey[3]),
        foreignTable: foreignKey[4],
        foreignColumns: parseColumnList(foreignKey[5]),
        onDelete: foreignKey[6],
        onUpdate: foreignKey[7],
      });
      continue;
    }

    const createIndex = statement.match(/^CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)" USING \w+ \(([^)]*)\)$/);
    if (createIndex) {
      parsed.indexes.set(createIndex[2], {
        table: createIndex[3],
        unique: Boolean(createIndex[1]),
        columns: parseColumnList(createIndex[4]),
      });
      continue;
    }

    const addColumn = statement.match(/^ALTER TABLE "([^"]+)" ADD COLUMN (.+)$/);
    if (addColumn) {
      const table = parsed.tables.get(addColumn[1]);
      if (!table) throw new Error(`Unknown table in ALTER TABLE: ${addColumn[1]}`);
      const [columnName, column] = parseColumn(addColumn[2]);
      table.columns.set(columnName, column);
      continue;
    }

    const dropColumn = statement.match(/^ALTER TABLE "([^"]+)" DROP COLUMN "([^"]+)"$/);
    if (dropColumn) {
      const table = parsed.tables.get(dropColumn[1]);
      if (!table) throw new Error(`Unknown table in ALTER TABLE: ${dropColumn[1]}`);
      table.columns.delete(dropColumn[2]);
      continue;
    }

    throw new Error(`Unsupported DDL statement: ${statement}`);
  }

  return parsed;
}

function loadSql(): ParsedSchema {
  const files = readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, `expected committed migrations in ${drizzleDir}`);

  const statements = files.flatMap((file) =>
    readFileSync(join(drizzleDir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim().replace(/;$/, ""))
      .filter(Boolean),
  );

  return parseSql(statements);
}

function normalizeDrizzleDefault(value: unknown): DefaultValue {
  if (value === undefined) return { kind: "none" };
  if (value instanceof SQL) return { kind: "sql" };
  if (Array.isArray(value)) return { kind: "array", value };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value };
  }

  throw new Error(`Unsupported drizzle default: ${String(value)}`);
}

function drizzleTables(): PgTable[] {
  return Object.values(schema).filter(isTable);
}

function indexColumnName(column: unknown): string {
  if (column instanceof IndexedColumn && typeof column.name === "string") return column.name;

  throw new Error("Only named index columns are supported");
}

function sorted<T>(values: T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

const sql = loadSql();
const tablesByName = new Map(drizzleTables().map((table) => [getTableName(table), table]));

test("committed migrations define exactly the drizzle tables", () => {
  assert.deepEqual(
    sorted([...sql.tables.keys()], (name) => name),
    sorted([...tablesByName.keys()], (name) => name),
  );
});

test("table columns match the drizzle schema", () => {
  for (const [name, table] of tablesByName) {
    const config = getTableConfig(table);
    const expected = [...config.columns]
      .map((column) => ({
        name: column.name,
        type: column.dataType,
        notNull: column.notNull,
        primary: column.primary,
        defaultValue: normalizeDrizzleDefault(column.default),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const actual = [...(sql.tables.get(name)?.columns ?? new Map())]
      .map(([columnName, column]) => ({ name: columnName, ...column }))
      .sort((left, right) => left.name.localeCompare(right.name));

    assert.deepEqual(actual, expected, `column mismatch for table ${name}`);
  }
});

test("unique constraints match the drizzle schema", () => {
  for (const [name, table] of tablesByName) {
    const config = getTableConfig(table);
    const expected = config.columns
      .filter((column) => column.isUnique)
      .map((column) => ({ name: column.uniqueName, columns: [column.name] }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const actual = [...(sql.tables.get(name)?.uniques ?? new Map())]
      .map(([constraintName, columns]) => ({ name: constraintName, columns }))
      .sort((left, right) => left.name.localeCompare(right.name));

    assert.deepEqual(actual, expected, `unique constraint mismatch for table ${name}`);
  }
});

test("indexes match the drizzle schema", () => {
  const expected = drizzleTables()
    .flatMap((table) =>
      getTableConfig(table).indexes.map((index) => ({
        name: index.config.name,
        table: getTableName(table),
        unique: index.config.unique,
        columns: index.config.columns.map(indexColumnName),
      })),
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const actual = [...sql.indexes]
    .map(([indexName, index]) => ({ name: indexName, ...index }))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(actual, expected);
});

test("foreign keys match the drizzle schema", () => {
  const expected = drizzleTables()
    .flatMap((table) =>
      getTableConfig(table).foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();

        return {
          name: foreignKey.getName(),
          table: getTableName(table),
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableName(reference.foreignTable),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete ?? "no action",
          onUpdate: foreignKey.onUpdate ?? "no action",
        };
      }),
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const actual = [...sql.foreignKeys]
    .map(([constraintName, foreignKey]) => ({ name: constraintName, ...foreignKey }))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(actual, expected);
});
