import { type ExtensionAPI } from '@mariozechner/pi-coding-agent'

type AuthEntry = Record<string, unknown> & {
  type?: 'api_key' | 'oauth'
  key?: string
  access?: string
  refresh?: string
  expires?: number
}

const relatedAuthProviders: Partial<Record<string, readonly string[]>> = {
  'openai': ['openai-codex'],
  'openai-codex': ['openai'],
}

const getAuthType = (entry: AuthEntry | undefined) =>
  typeof entry?.type === 'string' ? entry.type : 'none'

const getOAuthExpiry = (entry: AuthEntry | undefined) =>
  entry?.type === 'oauth' && typeof entry.expires === 'number'
    ? new Date(entry.expires).toLocaleString()
    : null

const formatStoredAuth = (provider: string, entry: AuthEntry | undefined) => {
  const authType = getAuthType(entry)
  const oauthExpiry = getOAuthExpiry(entry)

  return oauthExpiry
    ? `- ${provider}: ${authType} (expires ${oauthExpiry})`
    : `- ${provider}: ${authType}`
}

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
      const authStorage = ctx.modelRegistry.authStorage
      const authEntry = authStorage.get(provider) as AuthEntry | undefined
      const authType = getAuthType(authEntry)
      const oauthExpiry = getOAuthExpiry(authEntry)
      const hasConfiguredAuth = authStorage.hasAuth(provider)
      const relatedEntries = (relatedAuthProviders[provider] ?? [])
        .map(relatedProvider => ({
          provider: relatedProvider,
          entry: authStorage.get(relatedProvider) as AuthEntry | undefined,
        }))
        .filter(({ entry }) => Boolean(entry))

      const lines = [
        `provider: ${provider}`,
        `model: ${model}`,
        `resolved credentials: ${resolved ? 'yes' : 'no'}`,
        `configured auth for current provider: ${hasConfiguredAuth ? 'yes' : 'no'}`,
        `stored auth entry: ${authEntry ? 'yes' : 'no'}`,
        `stored auth type: ${authType}`,
      ]

      if (!resolvedAuth.ok) {
        lines.push(`resolution error: ${resolvedAuth.error}`)
      }

      if (oauthExpiry) {
        lines.push(`oauth expires: ${oauthExpiry}`)
      }

      if (relatedEntries.length > 0) {
        lines.push('related stored auth:')
        lines.push(...relatedEntries.map(({ provider, entry }) => formatStoredAuth(provider, entry)))
      }

      const codexOAuth = relatedEntries.find(({ provider }) => provider === 'openai-codex')?.entry
      if (provider === 'openai' && !authEntry && codexOAuth?.type === 'oauth') {
        lines.push(
          'hint: /login stores ChatGPT subscription auth under openai-codex. The openai provider is separate and expects OPENAI_API_KEY or an auth.json openai api_key entry.',
        )
      }

      const openAIKey = relatedEntries.find(({ provider }) => provider === 'openai')?.entry
      if (provider === 'openai-codex' && !authEntry && openAIKey) {
        lines.push(
          'hint: OPENAI_API_KEY/auth.json openai only applies to the openai API provider. Run /login to authenticate openai-codex.',
        )
      }

      if (resolved && !authEntry) {
        lines.push('source hint: likely env var, CLI --api-key, or provider config')
      }

      ctx.ui.notify(lines.join('\n'), resolved ? 'info' : 'warning')
    },
  })
}
