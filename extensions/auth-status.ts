import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type ExtensionAPI, getAgentDir } from '@mariozechner/pi-coding-agent'

type AuthEntry = Record<string, unknown> & {
  type?: 'api_key' | 'oauth'
  key?: string
  access?: string
  refresh?: string
  expires?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Show auth status for the current provider.
 * @param {ExtensionAPI} pi Extension API used to register the command.
 */
export default function authStatusExtension(pi: ExtensionAPI) {
  pi.registerCommand('auth-status', {
    description: 'Show auth status for the current provider',
    handler: async (_args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify('No current model selected', 'warning')
        return
      }

      const provider = ctx.model.provider
      const model = ctx.model.id
      const selectedModel = ctx.modelRegistry.find(provider, model)

      if (!selectedModel) {
        ctx.ui.notify(`Model not found in registry: ${provider}/${model}`, 'warning')
        return
      }

      const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel)
      const resolved = resolvedAuth.ok && Boolean(resolvedAuth.apiKey)

      const authPath = join(getAgentDir(), 'auth.json')

      let authEntry: AuthEntry | undefined
      try {
        const raw = await readFile(authPath, 'utf8')
        const parsed: unknown = JSON.parse(raw)

        if (isRecord(parsed)) {
          const candidate = parsed[provider]
          if (isRecord(candidate)) {
            authEntry = candidate
          }
        }
      }
      catch {
        // ignore missing/unreadable auth.json
      }

      const authType = typeof authEntry?.type === 'string' ? authEntry.type : 'none'

      const oauthExpiry
        = authType === 'oauth' && typeof authEntry?.expires === 'number'
          ? new Date(authEntry.expires).toLocaleString()
          : null

      const lines = [
        `provider: ${provider}`,
        `model: ${model}`,
        `resolved credentials: ${resolved ? 'yes' : 'no'}`,
        `auth.json entry: ${authEntry ? 'yes' : 'no'}`,
        `auth.json type: ${authType}`,
      ]

      if (!resolvedAuth.ok) {
        lines.push(`resolution error: ${resolvedAuth.error}`)
      }

      if (oauthExpiry) {
        lines.push(`oauth expires: ${oauthExpiry}`)
      }

      if (resolved && !authEntry) {
        lines.push('source hint: likely env var, CLI --api-key, or provider config')
      }

      ctx.ui.notify(lines.join('\n'), resolved ? 'info' : 'warning')
    },
  })
}
