import { z } from 'zod'

export const llmsItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  description: z.string(),
  updateTime: z.string(),
})

export const globalSettingsSchema = z
  .object({
    refreshTtlMs: z.number().int().positive().optional(),
  })
  .optional()

export const llmsConfigSchema = z.object({
  llms: z.array(llmsItemSchema),
  globalSettings: globalSettingsSchema,
})

export type LlmsItem = z.infer<typeof llmsItemSchema>
export type LlmsConfig = z.infer<typeof llmsConfigSchema>
