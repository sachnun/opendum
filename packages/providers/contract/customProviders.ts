import { oc } from "@orpc/contract";
import { z } from "zod";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const emptyInputSchema = z.object({});

const customModelInputSchema = z.object({
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

const createCustomProviderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Slug must match [a-z][a-z0-9_-]{0,31}"),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(1).max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});
const previewCustomModelsSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  token: z.string().trim().optional(),
});
const updateCustomProviderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
const deleteCustomProviderSchema = z.object({ slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug") });
const connectCustomProviderAccountSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  token: z.string().trim().min(1),
  name: z.string().trim().max(120).optional(),
});
const upsertCustomModelsSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  models: z.array(customModelInputSchema).min(1).max(500),
});
const deleteCustomModelSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  modelId: z.string().trim().min(1).max(120),
});
const syncCustomModelsSchema = z.object({ slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"), token: z.string().trim().optional() });

export const customProvidersContract = {
  list: oc.input(emptyInputSchema),
  create: oc.input(createCustomProviderSchema),
  update: oc.input(updateCustomProviderSchema),
  remove: oc.input(deleteCustomProviderSchema),
  connect: oc.input(connectCustomProviderAccountSchema),
  syncModels: oc.input(syncCustomModelsSchema),
  previewModels: oc.input(previewCustomModelsSchema),
  upsertModels: oc.input(upsertCustomModelsSchema),
  deleteModel: oc.input(deleteCustomModelSchema),
};

export type CreateCustomProviderInput = z.infer<typeof createCustomProviderSchema>;
export type UpdateCustomProviderInput = z.infer<typeof updateCustomProviderSchema>;
export type DeleteCustomProviderInput = z.infer<typeof deleteCustomProviderSchema>;
export type ConnectCustomProviderInput = z.infer<typeof connectCustomProviderAccountSchema>;
export type SyncCustomModelsInput = z.infer<typeof syncCustomModelsSchema>;
export type PreviewCustomModelsInput = z.infer<typeof previewCustomModelsSchema>;
export type UpsertCustomModelsInput = z.infer<typeof upsertCustomModelsSchema>;
export type DeleteCustomModelInput = z.infer<typeof deleteCustomModelSchema>;
export type CustomModelInput = z.infer<typeof customModelInputSchema>;
