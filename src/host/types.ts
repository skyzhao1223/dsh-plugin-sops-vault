/**
 * Structural types for the DSH host services this plugin consumes.
 *
 * Deliberately hand-rolled instead of importing `@deepseek-ai/dsh-shell` /
 * `@deepseek-ai/dsh-host-webserver`: external plugins should not hard-depend
 * on internal packages whose published versions may drift. The shapes below
 * mirror the contracts documented in those packages' public `.d.ts` files
 * (ShellExecRequest/ShellRunResult/CollectedOutput, WebRoute).
 *
 * @module dsh-plugin-sops-vault/host/types
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
  /** Terminating signal, when the process was killed by one. */
  signal?: string | null
  /** True when the executor's own deadline cut the run short. */
  timedOut?: boolean
  /** True when the caller's AbortSignal cut the run short. */
  aborted?: boolean
}

/**
 * A spawned execution handle (DSH 0.2.x). `result` is a METHOD in the shipped
 * 0.2 contract (`result(): Promise<ShellRunResult>`); some pre-releases exposed
 * it as a promise property. Callers must handle both shapes.
 */
export interface ShellExecutionLike {
  result: Promise<ShellRunResultLike> | (() => Promise<ShellRunResultLike>)
}

/** The slice of the `shell` service this plugin uses. */
export interface ShellLike {
  resolve(request: ShellExecRequestLike): unknown
  /** DSH 0.1.x foreground seam. */
  run?(spec: unknown): Promise<ShellRunResultLike>
  /** DSH 0.2.x seam: spawn a handle, then await its `result()` projection. */
  execute?(spec: unknown): Promise<ShellExecutionLike>
}

/** Validated plugin config (see `Config` in the entry module). */
export interface VaultPluginConfig {
  /** Vault directory. Default: `~/Vault`. A leading `~` is expanded. */
  vaultDir?: string
  /** sops binary. Default: `sops` (resolved via PATH). */
  sopsBin?: string
  /** git binary. Default: `git` (resolved via PATH). */
  gitBin?: string
  /** Per-command timeout in ms. Default 15000. */
  timeoutMs?: number
  /**
   * Extra Chromium user-data root to probe for the Authenticator extension
   * (import feature). Platform auto-discovery always runs; this only adds one.
   */
  browserDataDir?: string
}
