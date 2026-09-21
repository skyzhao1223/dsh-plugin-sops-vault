/**
 * Minimal structural types for the DSH client runtime surface this plugin
 * uses. Hand-rolled (like the host half) so the package does not hard-depend
 * on internal `@deepseek-ai/dsh-client-*` published versions; the shapes
 * mirror `ClientContext` from `@deepseek-ai/dsh-client-runtime/client` and the
 * slots service contract from `@deepseek-ai/dsh-client-ui-slots`.
 *
 * @module dsh-plugin-sops-vault/client/types
 */
import type { ComponentType } from 'react'

/** One slot registration descriptor (list/keyed variants). */
export interface SlotRegistration {
  name: string
  id?: string
  key?: string
  label?: string
  order?: number
}

/** The slice of the client `slots` service this plugin uses. */
export interface SlotsLike {
  inject(name: string, cb: () => unknown): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(registration: SlotRegistration, component: ComponentType<any>): () => void
}

/** The slice of the client Cordis context this plugin uses. */
export interface ClientContextLike {
  effect(cb: () => void | (() => void), label?: string): () => void
  slots: SlotsLike
}

/** Sidebar panel-icon owner props (from the `sidebar.panellist` contract). */
export interface PanelIconProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is selected in the main column. */
  active: boolean
}
