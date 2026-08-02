// Ports Nitro route files (server/api/**) to Hono route modules (apps/api/src/routes/**).
// Usage: node scripts/port-api-routes.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const srcDir = join(root, "apps/dashboard/server/api");
const outDir = join(root, "apps/api/src/routes");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (entry.name.endsWith(".ts")) return [full];
    return [];
  });
}

function methodFor(file) {
  const name = basename(file, ".ts");
  const parts = name.split(".");
  const method = parts[parts.length - 1];
  const known = { get: "get", post: "post", put: "put", delete: "delete", patch: "patch" };
  return known[method] ?? "all";
}

function stripMethodSuffix(name) {
  return name.replace(/\.(get|post|put|delete|patch)$/, "");
}

function errorsImportFor(outFile) {
  const depth = relative(outDir, dirname(outFile)).split(/[\\/]/).filter(Boolean).length;
  return "../".repeat(depth + 1) + "utils/errors.js";
}

const mounted = [];

for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const outFile = join(outDir, rel.replace(/\.ts$/, ".ts"));
  mkdirSync(dirname(outFile), { recursive: true });

  let src = readFileSync(file, "utf8");
  const errorsImport = errorsImportFor(outFile);

  // Rewrite h3 imports
  src = src.replace(/import \{ createError \} from "h3";?\s*/, (m) => `import { createError } from "${errorsImport}";\n`);
  src = src.replace(/import \{ setHeader \} from "h3";?\s*/, "");

  // h3 helpers → hono
  src = src.replaceAll("setHeader(event, ", "c.header(");

  // Extract the defineEventHandler body
  const match = src.match(/export default defineEventHandler\(async \(event\) => (\{[\s\S]*\}|[^;]+?)\);?\s*$/);
  if (!match) {
    console.error("SKIP (no handler match):", rel);
    continue;
  }
  let body = match[1];
  const isBlock = body.startsWith("{");

  if (isBlock) {
    // strip outer braces
    body = body.slice(1, -1);
    body = body.replace(/\bevent\b/g, "c");
    body = `import type { Context } from "hono";\nexport async function handler(c: Context) {\n${body}\n}`;
  } else {
    body = body.replace(/\bevent\b/g, "c");
    body = `import type { Context } from "hono";\nexport const handler = async (c: Context) => ${body};`;
  }

  // Remove the original defineEventHandler line (already captured; the match may
  // include trailing content). Rebuild file: everything before the match stays.
  const head = src.slice(0, match.index);
  src = head + body + "\n";

  // Ensure createError import if referenced
  if (/\bcreateError\b/.test(src) && !src.includes(errorsImport)) {
    src = src.replace(/^import /, `import { createError } from "${errorsImport}";\nimport `);
  }

  const method = methodFor(file);
  const isAuthAll = rel.endsWith("auth/[...all].ts");
  if (isAuthAll) {
    // Custom: better-auth handler returns a raw Response.
    const custom = `import { Hono } from "hono";
import { createAuth } from "../../../lib/auth.js";
import { createRequestDb } from "../../../lib/db/index.js";

const app = new Hono();
app.all("*", async (c) => {
  const { db, close } = await createRequestDb();
  try {
    return await createAuth(db).handler(c.req.raw);
  } finally {
    await close();
  }
});
export default app;
`;
    writeFileSync(outFile, custom);
    mounted.push({ rel: rel.replace(/\.ts$/, ""), outFile });
    continue;
  }

  const router = `\nimport { Hono } from "hono";\n\nconst app = new Hono();\napp.${method}("/", async (c) => c.json(await handler(c)));\nexport default app;\n`;

  writeFileSync(outFile, src + router);
  mounted.push({ rel: rel.replace(/\.ts$/, ""), outFile });
}

// Generate index.ts mounting all routers
const imports = [];
const routes = [];
for (const { rel, outFile } of mounted) {
  const relPath = "./" + relative(outDir, outFile).replace(/\.ts$/, "").replace(/\\/g, "/");
  const id = "route" + routes.length;
  imports.push(`import ${id} from "${relPath}";`);
  const path = "/dashboard/" + rel.replace(/^dashboard\//, "").replace(/\.(get|post|put|delete|patch)$/, "");
  routes.push(`app.route("${path}", ${id});`);
}

const index = `import { Hono } from "hono";
${imports.join("\n")}

const app = new Hono();
${routes.join("\n")}

export default app;
`;

writeFileSync(join(outDir, "index.ts"), index);
console.log(`Ported ${mounted.length} routes`);
