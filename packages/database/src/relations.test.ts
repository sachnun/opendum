import { expect, test } from "bun:test";

import {
  createTableRelationsHelpers,
  getTableName,
  isTable,
  Many,
  One,
  Relations,
  type AnyTable,
} from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import * as relations from "./relations.js";
import * as schema from "./schema/index.js";

interface ResolvedRelation {
  kind: "one" | "many";
  referencedTable: string;
  fields: string[];
  references: string[];
}

function resolve(relation: One<string> | Many<string>): ResolvedRelation {
  if (relation instanceof Many) {
    return { kind: "many", referencedTable: relation.referencedTableName, fields: [], references: [] };
  }

  const config = relation.config;

  return {
    kind: "one",
    referencedTable: relation.referencedTableName,
    fields: (config?.fields ?? []).map((column: { name: string }) => column.name),
    references: (config?.references ?? []).map((column: { name: string }) => column.name),
  };
}

function resolveRelations(definition: Relations): Map<string, ResolvedRelation> {
  const helpers = createTableRelationsHelpers(definition.table as AnyTable<{ name: string }>);
  const config = definition.config(helpers) as Record<string, One<string> | Many<string>>;
  const resolved = new Map<string, ResolvedRelation>();

  for (const [fieldName, relation] of Object.entries(config)) {
    expect(relation instanceof One || relation instanceof Many).toBeTruthy();
    resolved.set(fieldName, resolve(relation));
  }

  return resolved;
}

const tablesByName = new Map<string, AnyTable<{ name: string }>>(
  Object.values(schema)
    .filter(isTable)
    .map((table) => [getTableName(table), table as AnyTable<{ name: string }>]),
);

const relationsBySourceTable = new Map<string, Map<string, ResolvedRelation>>();
for (const definition of Object.values(relations)) {
  if (!(definition instanceof Relations)) continue;

  const sourceTable = getTableName(definition.table);
  expect(!relationsBySourceTable.has(sourceTable)).toBeTruthy();
  relationsBySourceTable.set(sourceTable, resolveRelations(definition));
}

interface ForeignKeyShape {
  sourceTable: string;
  columns: string[];
  targetTable: string;
  targetColumns: string[];
}

const foreignKeys: ForeignKeyShape[] = [...tablesByName].flatMap(([tableName, table]) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();

    return {
      sourceTable: tableName,
      columns: reference.columns.map((column) => column.name),
      targetTable: getTableName(reference.foreignTable),
      targetColumns: reference.foreignColumns.map((column) => column.name),
    };
  }),
);

const tablesWithForeignKeys = new Set(
  foreignKeys.flatMap((foreignKey) => [foreignKey.sourceTable, foreignKey.targetTable]),
);

test("relations are declared for exactly the tables connected by foreign keys", () => {
  expect([...relationsBySourceTable.keys()].sort()).toEqual([...tablesWithForeignKeys].sort());
});

test("relation targets exist in the schema", () => {
  for (const [sourceTable, definition] of relationsBySourceTable) {
    for (const [fieldName, relation] of definition) {
      expect(tablesByName.has(relation.referencedTable)).toBeTruthy();
    }
  }
});

test("every foreign key has a matching to-one relation on its source table", () => {
  for (const foreignKey of foreignKeys) {
    const definition = relationsBySourceTable.get(foreignKey.sourceTable);
    expect(definition, `${foreignKey.sourceTable} has no relations`).toBeTruthy();
    if (!definition) return;

    const matches = [...definition].filter(
      ([, relation]) =>
        relation.kind === "one" &&
        relation.referencedTable === foreignKey.targetTable &&
        relation.fields.join() === foreignKey.columns.join() &&
        relation.references.join() === foreignKey.targetColumns.join(),
    );

    expect(matches.length).toBe(1);
  }
});

test("every foreign key is reachable back from its target table", () => {
  for (const foreignKey of foreignKeys) {
    const definition = relationsBySourceTable.get(foreignKey.targetTable);
    expect(definition, `${foreignKey.targetTable} has no relations`).toBeTruthy();
    if (!definition) continue;

    const matches = [...definition].filter(
      ([, relation]) => relation.referencedTable === foreignKey.sourceTable,
    );

    expect(matches.length > 0).toBeTruthy();

    for (const [fieldName, relation] of matches) {
      if (relation.kind === "one") {
        expect({ fields: relation.references, references: relation.fields }).toEqual({ fields: foreignKey.columns, references: foreignKey.targetColumns });
      }
    }
  }
});

test("to-many relations are backed by a foreign key", () => {
  for (const [sourceTable, definition] of relationsBySourceTable) {
    for (const [fieldName, relation] of definition) {
      if (relation.kind !== "many") continue;

      expect(foreignKeys.some(
          (foreignKey) =>
            foreignKey.sourceTable === relation.referencedTable &&
            foreignKey.targetTable === sourceTable,
        )).toBeTruthy();
    }
  }
});

test("to-one relations follow a foreign key in one of its two directions", () => {
  for (const [sourceTable, definition] of relationsBySourceTable) {
    for (const [fieldName, relation] of definition) {
      if (relation.kind !== "one") continue;

      const matches = foreignKeys.some(
        (foreignKey) =>
          (foreignKey.sourceTable === sourceTable &&
            foreignKey.targetTable === relation.referencedTable &&
            foreignKey.columns.join() === relation.fields.join() &&
            foreignKey.targetColumns.join() === relation.references.join()) ||
          (foreignKey.sourceTable === relation.referencedTable &&
            foreignKey.targetTable === sourceTable &&
            foreignKey.columns.join() === relation.references.join() &&
            foreignKey.targetColumns.join() === relation.fields.join()),
      );

      expect(matches).toBeTruthy();
    }
  }
});

test("relation field names are unique per table", () => {
  for (const [sourceTable, definition] of relationsBySourceTable) {
    expect(new Set(definition.keys()).size).toBe(definition.size);
  }
});
