import { stripParamInfoKey } from "#models/model/clean-key.ts";

export const MODELS_WITH_1M_VARIANT = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
]);

export function stripHtml(html) {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function parseModelsFromHtml(html) {
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    tables.push(tableMatch[1]);
  }

  if (tables.length === 0) {
    throw new Error(
      "No tables found on Kiro docs page. The page structure may have changed."
    );
  }

  let comparisonTable = null;
  for (const table of tables) {
    const candidateRows = parseTableRows(table);
    if (candidateRows.length === 0) continue;

    const candidateHeader = candidateRows[0].map((h) => h.toLowerCase());
    const hasModel = candidateHeader.some(
      (h) => h === "model" || h.includes("model")
    );
    const hasContext = candidateHeader.some((h) => h.includes("context"));

    if (hasModel && hasContext) {
      comparisonTable = table;
      break;
    }
  }

  if (!comparisonTable) {
    throw new Error(
      'Could not find "Quick comparison" table on Kiro docs page. ' +
        "The page structure may have changed."
    );
  }

  const rows = parseTableRows(comparisonTable);
  if (rows.length < 2) {
    throw new Error("Models table has fewer than 2 rows (header + data).");
  }

  const header = rows[0].map((h) => h.toLowerCase());
  const nameIdx = header.findIndex(
    (h) => h === "model" || h.includes("model")
  );
  const ctxIdx = header.findIndex((h) => h.includes("context"));
  const regionIdx = header.findIndex((h) => h.includes("region"));
  const freeIdx = header.findIndex((h) => h === "free");
  const proIdx = header.findIndex((h) => h === "pro");
  const proPlusIdx = header.findIndex((h) => h === "pro+" || h === "pro plus" || (h.startsWith("pro") && h.includes("+")));
  const powerIdx = header.findIndex((h) => h === "power");

  if (nameIdx < 0) {
    throw new Error("Could not find 'Model' column in comparison table.");
  }

  const models = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[nameIdx]?.trim();
    if (!name) continue;

    const freeCell = freeIdx >= 0 ? (row[freeIdx]?.trim() || "") : "";
    const proCell = proIdx >= 0 ? (row[proIdx]?.trim() || "") : "";
    const proPlusCell = proPlusIdx >= 0 ? (row[proPlusIdx]?.trim() || "") : "";
    const powerCell = powerIdx >= 0 ? (row[powerIdx]?.trim() || "") : "";

    const freeAvailable = freeCell.length > 0;
    const paidAvailable = proCell.length > 0 || proPlusCell.length > 0 || powerCell.length > 0;

    models.push({
      name,
      contextWindow: ctxIdx >= 0 ? (row[ctxIdx]?.trim() || "") : "",
      region: regionIdx >= 0 ? (row[regionIdx]?.trim() || "") : "",
      freeAvailable,
      paidAvailable,
    });
  }

  if (models.length === 0) {
    throw new Error("No models found in comparison table.");
  }

  return models;
}

export function parseTableRows(tableInnerHtml) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tableInnerHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

export function displayNameToKiroId(displayName, catalog) {
  const published = catalog?.get(displayName);
  if (published) return published;

  let id = displayName.toLowerCase().replace(/\s+/g, "-");

  id = id.replace(/\.0(?=-|$)/g, "");

  id = id.replace(/^minimax-(\d)/, "minimax-m$1");

  return id;
}

export function expandVariants(kiroId) {
  const ids = [kiroId];

  if (MODELS_WITH_1M_VARIANT.has(kiroId)) {
    ids.push(`${kiroId}-1m`);
  }

  return ids;
}

export function toCanonical(kiroModelId) {
  let key = kiroModelId;

  if (key.startsWith("claude-")) {
    key = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  }

  if (key.startsWith("deepseek-") && /^deepseek-\d/.test(key)) {
    key = key.replace(/^deepseek-/, "deepseek-v");
  }

  key = stripParamInfoKey(key).replace(/[^a-z0-9.-]/g, "");

  return { key, upstream: kiroModelId };
}
