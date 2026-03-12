import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { resolveStaticFilePath } from "./static-file"

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("resolveStaticFilePath", () => {
  it("returns a resolved path for files under dist", () => {
    const distRoot = path.join("/tmp", "omo-dashboard-dist")
    expect(resolveStaticFilePath(distRoot, "/assets/app.js")).toBe(path.join(distRoot, "assets", "app.js"))
  })

  it("rejects parent-directory traversal", () => {
    const distRoot = path.join("/tmp", "omo-dashboard-dist")
    expect(resolveStaticFilePath(distRoot, "/../package.json")).toBeNull()
  })

  it("rejects encoded parent-directory traversal", () => {
    const distRoot = path.join("/tmp", "omo-dashboard-dist")
    expect(resolveStaticFilePath(distRoot, "/..%2F..%2Fpackage.json")).toBeNull()
  })

  it("rejects encoded backslash traversal", () => {
    const distRoot = path.join("/tmp", "omo-dashboard-dist")
    expect(resolveStaticFilePath(distRoot, "/..%5Csecret.txt")).toBeNull()
  })

  it("rejects invalid URL encoding", () => {
    const distRoot = path.join("/tmp", "omo-dashboard-dist")
    expect(resolveStaticFilePath(distRoot, "/bad%E0%A4%A.txt")).toBeNull()
  })

  it("rejects symlink escapes from dist", () => {
    const root = mkTempDir("omo-static-file-")
    const distRoot = path.join(root, "dist")
    const outsideRoot = path.join(root, "outside")
    fs.mkdirSync(distRoot, { recursive: true })
    fs.mkdirSync(outsideRoot, { recursive: true })

    const outsideFile = path.join(outsideRoot, "secret.txt")
    fs.writeFileSync(outsideFile, "shh", "utf8")
    fs.symlinkSync(outsideFile, path.join(distRoot, "secret.txt"))

    expect(resolveStaticFilePath(distRoot, "/secret.txt")).toBeNull()
  })
})
