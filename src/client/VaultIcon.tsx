/**
 * Sidebar panel icon for the vault entry (`sidebar.panellist` occupant).
 *
 * @module dsh-plugin-sops-vault/client/VaultIcon
 */
import type { PanelIconProps } from './types.ts'

/** Padlock glyph sized by the sidebar row. */
export function VaultIcon(props: PanelIconProps) {
  const s = props.size || 18
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.2" />
    </svg>
  )
}
