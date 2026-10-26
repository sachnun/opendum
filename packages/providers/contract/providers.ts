import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "./common.js";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const modelInputSchema = z.object({
  modelId: z.string().trim().min(1).max(120),
  upstream: z.string().trim().max(200).optional(),
  aliased: z.boolean().optional(),
  authless: z.boolean().optional(),
  minTier: z.string().trim().max(60).optional(),
  allowedTiers: z.array(z.string().trim().min(1)).optional(),
  customFlags: z
    .object({
      responses_api: z.boolean().optional(),
      top_p_deprecated: z.boolean().optional(),
      convert_external_images: z.boolean().optional(),
    })
    .optional(),
});

const customCreateSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Slug must match [a-z][a-z0-9_-]{0,31}"),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(1).max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});
const modelsPreviewSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  token: z.string().trim().optional(),
});
const customUpdateSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
const customDeleteSchema = z.object({ slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug") });
const customConnectSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  token: z.string().trim().min(1),
  name: z.string().trim().max(120).optional(),
});
const modelsUpsertSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  models: z.array(modelInputSchema).min(1).max(500),
});
const modelDeleteSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  modelId: z.string().trim().min(1).max(120),
});
const modelsSyncSchema = z.object({ slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"), token: z.string().trim().optional() });

export const providersContract = {
  list: oc.input(emptyInputSchema),
  create: oc.input(customCreateSchema),
  update: oc.input(customUpdateSchema),
  delete: oc.input(customDeleteSchema),
  connect: oc.input(customConnectSchema),
  sync: oc.input(modelsSyncSchema),
  preview: oc.input(modelsPreviewSchema),
  models: oc.input(modelsUpsertSchema),
  model: oc.input(modelDeleteSchema),
};

export type CustomCreateInput = z.infer<typeof customCreateSchema>;
export type CustomUpdateInput = z.infer<typeof customUpdateSchema>;
export type CustomDeleteInput = z.infer<typeof customDeleteSchema>;
export type CustomConnectInput = z.infer<typeof customConnectSchema>;
export type ModelsSyncInput = z.infer<typeof modelsSyncSchema>;
export type ModelsPreviewInput = z.infer<typeof modelsPreviewSchema>;
export type ModelsUpsertInput = z.infer<typeof modelsUpsertSchema>;
export type ModelDeleteInput = z.infer<typeof modelDeleteSchema>;
export type CustomModelInput = z.infer<typeof modelInputSchema>;
