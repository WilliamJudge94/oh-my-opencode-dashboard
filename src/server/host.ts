const DEFAULT_HOST = "127.0.0.1"

function normalizeHost(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveServerHost(opts: { cliHost?: string; envHost?: string }): string {
  return normalizeHost(opts.cliHost) ?? normalizeHost(opts.envHost) ?? DEFAULT_HOST
}

export function getPublicHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host
}

export { DEFAULT_HOST }
