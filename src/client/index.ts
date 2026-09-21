/**
 * dsh-plugin-vault — browser half.
 *
 * Contributes the sidebar panel icon (`sidebar.panellist`, id `vault`) and the
 * matching main-column panel (`main`, key `vault`), plus the package-owned
 * stylesheet. All data flows through the same-origin `/vault-api` route of the
 * node half; no model-facing surface is registered here or there.
 *
 * @module dsh-plugin-vault/client
 */
import { injectStyles } from './styles.ts'
import { VaultIcon } from './VaultIcon.tsx'
import { VaultPanel } from './VaultPanel.tsx'
import type { ClientContextLike } from './types.ts'

/** Required client services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: styles + the two slot registrations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => injectStyles(), 'vault: styles')
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'vault', label: 'Vault 密码库', order: 50 },
    VaultIcon,
  ))
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'vault' },
    VaultPanel,
  ))
}
