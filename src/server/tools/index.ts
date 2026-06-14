import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { llmsStore } from './llms-store.js'

const jsonTextResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
})

export const registerTools = (server: McpServer) => {
  server.registerTool(
    'add',
    {
      description:
        'Add a new llms.txt (https://llmstxt.org) by URL. Fetches and caches the document locally. Use when the user wants to save, import, or subscribe to an llms.txt.',
      inputSchema: {
        name: z.string().min(1).describe('unique llms name'),
        url: z.url().describe('llms.txt url'),
        description: z.string().describe('brief introduction for this llms.txt'),
      },
    },
    async ({ name, url, description }) => {
      const item = await llmsStore.add({ name, url, description })
      return jsonTextResult(item)
    },
  )

  server.registerTool(
    'edit',
    {
      description:
        "Update name, url, or description of an llms.txt entry by id. Re-fetches if url changes. Call `list` first if you don't have the id.",
      inputSchema: {
        id: z.uuid().describe('llms id'),
        name: z.string().min(1).optional().describe('new unique llms name'),
        url: z.url().optional().describe('new unique llms.txt url'),
        description: z.string().optional().describe('new llms description'),
      },
    },
    async ({ id, name, url, description }) => {
      if (name === undefined && url === undefined && description === undefined) {
        throw new Error('at least one field should be provided to edit')
      }

      const item = await llmsStore.edit({ id, name, url, description })
      return jsonTextResult(item)
    },
  )

  server.registerTool(
    'del',
    {
      description:
        "Delete an llms.txt entry and its cached content by id. Call `list` first if you don't have the id.",
      inputSchema: {
        id: z.uuid().describe('llms id'),
      },
    },
    async ({ id }) => {
      const item = await llmsStore.remove(id)
      return jsonTextResult(item)
    },
  )

  server.registerTool(
    'list',
    {
      description:
        "List all saved llms.txt entries (id, name, url, description). Use when the user asks what's available, or to look up an id for other tools.",
      inputSchema: {},
    },
    async () => {
      const items = await llmsStore.list()
      return jsonTextResult(items)
    },
  )

  server.registerTool(
    'view_content',
    {
      description:
        "Read the content of a stored llms.txt document by id. Call `list` first if you don't have the id.",
      inputSchema: {
        id: z.uuid().describe('llms id'),
      },
    },
    async ({ id }) => {
      const result = await llmsStore.getDoc(id)
      return jsonTextResult(result)
    },
  )
}
