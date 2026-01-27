type ModelParts = {
  providerID?: string
  modelID?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readModelParts(value: Record<string, unknown>): ModelParts {
  const providerID =
    readString(value.providerID) ??
    readString(value.providerId) ??
    readString(value.provider_id)
  const modelID =
    readString(value.modelID) ??
    readString(value.modelId) ??
    readString(value.model_id)

  return { providerID: providerID ?? undefined, modelID: modelID ?? undefined }
}

export function extractModelString(meta: unknown): string | null {
  if (!isRecord(meta)) return null

  const direct = readModelParts(meta)
  if (direct.providerID && direct.modelID) return `${direct.providerID}/${direct.modelID}`

  const nested = meta.model
  if (isRecord(nested)) {
    const nestedParts = readModelParts(nested)
    if (nestedParts.providerID && nestedParts.modelID) {
      return `${nestedParts.providerID}/${nestedParts.modelID}`
    }
  }

  return null
}

type ModelCandidate = {
  created: number
  id: string
  role: string | null
  model: string
}

export function pickLatestModelString(metas: Array<unknown>): string | null {
  const candidates: ModelCandidate[] = []

  for (const meta of metas) {
    if (!isRecord(meta)) continue
    const model = extractModelString(meta)
    if (!model) continue

    const created = typeof meta.time === "object" && meta.time !== null && typeof (meta.time as { created?: unknown }).created === "number"
      ? (meta.time as { created: number }).created
      : 0
    const id = readString(meta.id) ?? ""
    const role = readString(meta.role)

    candidates.push({ created, id, role, model })
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    if (b.created !== a.created) return b.created - a.created
    return b.id.localeCompare(a.id)
  })

  const assistant = candidates.find((candidate) => candidate.role === "assistant")
  return assistant?.model ?? candidates[0]?.model ?? null
}
