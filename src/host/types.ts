/**
 * Structural types for the DSH host services this plugin consumes.
 *
 * Deliberately hand-rolled instead of importing `@deepseek-ai/dsh-shell` /
 * `@deepseek-ai/dsh-host-webserver`: external plugins should not hard-depend
 * on internal packages whose published versions may drift. The shapes below
 * mirror the contracts documented in those packages' public `.d.ts` files
 * (ShellExecRequest/ShellRunResult/CollectedOutput, WebRoute).
 *
 * @module dsh-plugin-vault/host/types
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One named HTTP route registration on the DSH web server. */
export interface WebRoute {
  /** Match mode: exact pathname or pathname prefix. */
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle. */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The slice of the `webServer` service this plugin uses. */
export interface WebServerLike {
  register(route: WebRoute): () => void
}

/** Plugin-facing shell execution request (model-/plugin-facing shape). */
export interface ShellExecRequestLike {
  command: string
  workdir?: string
  timeoutMs?: number
}

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutputLike {
  text?: unknown
  truncated?: unknown
}

/** The outcome of one completed foreground run. */
export interface ShellRunResultLike {
  exitCode: number | null
  stdout?: CollectedOutputLike
  stderr?: CollectedOutputLike
}

/** The slice of the `shell` service this plugin uses. */
export interface ShellLike {
  resolve(request: ShellExecRequestLike): unknown
  run(spec: unknown): Promise<ShellRunResultLike>
}

/** Validated plugin config (see `Config` in the entry module). */
export interface VaultPluginConfig {
  /** Vault directory. Default: `~/Vault`. A leading `~` is expanded. */
  vaultDir?: string
  /** Vault CLI path. Default: `<vaultDir>/bin/vault`. */
  vaultBin?: string
  /** Per-command timeout in ms. Default 15000. */
  timeoutMs?: number
}
