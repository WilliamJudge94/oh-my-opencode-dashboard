import { assertAllowedPath } from "../ingest/paths"

function decodeRequestPath(requestPath: string): string | null {
  try {
    return decodeURIComponent(requestPath)
  } catch {
    return null
  }
}

export function resolveStaticFilePath(distRoot: string, requestPath: string): string | null {
  const decodedPath = decodeRequestPath(requestPath)
  if (!decodedPath) return null

  const relativePath = decodedPath.startsWith("/") ? decodedPath.slice(1) : decodedPath
  const normalizedSegments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")

  if (normalizedSegments.length === 0 || normalizedSegments.some((segment) => segment === "..")) {
    return null
  }

  try {
    return assertAllowedPath({
      candidatePath: normalizedSegments.join("/"),
      allowedRoots: [distRoot],
      baseDir: distRoot,
    })
  } catch (error) {
    if (error instanceof Error && error.message === "Access denied") {
      return null
    }

    throw error
  }
}
