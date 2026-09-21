# dsh-plugin-vault

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that turns a local
[sops](https://github.com/getsops/sops) + [age](https://age-encryption.org) + git credential vault into a
first-class sidebar panel of the DSH Web GUI — with a hard security boundary between the human and the model.

```
┌───────────────────────────── DSH Web GUI ─────────────────────────────┐
│  Sidebar: 🔒 Vault panel                                              │
│    · entry rows grouped by 工作/服务/生活, search, git-dirty badge     │
│    · detail drawer: per-field 👁 reveal / copy / edit / delete         │
│    · live TOTP with countdown ring · entry creation · security audit   │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ same-origin fetch (Origin-checked)
┌──────────────▼───────────────┐        ┌──────────────────────────────┐
│ Host half: /vault-api route   │ shell  │ ~/Vault (sops + age + git)    │
│ on the DSH web server         ├───────►│ vault CLI: meta/get/totp/…    │
└───────────────────────────────┘        └──────────────────────────────┘

The MODEL gets no tool from this plugin. Structure (vault meta) is the most an
agent-side integration should see; plaintext values only ever flow Host→browser
on an explicit human click.
```

## Why

Password-manager GUIs (KeePassXC, Bitwarden) are binary-store, human-only tools: no diff, no audit trail,
and wiring an AI agent to them means handing over the master password. A sops+age YAML vault is the
opposite: allowlist-encrypted fields keep structure readable, git keeps history, and a CLI keeps it
scriptable. This plugin gives that stack the GUI it was missing — without opening a plaintext channel to
the model.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`, pnpm
- A vault repository driven by a `vault` CLI (sops + age + git). The panel expects:
  - `vault meta` — JSON structure (plaintext metadata, `{enc:true}` markers, **no secrets**)
  - `vault get <entry> [field]`, `vault totp <entry>`, `vault audit`
  - `vault set/rm/new/save` for the write actions
- `dsh web` (the panel mounts into the Web composition; the host half needs the `webServer` and `shell` services)

## Install & mount

```sh
git clone <this repo> && cd dsh-plugin-vault
pnpm install
pnpm build          # tsc (node half + types) + tsdown (browser bundle)
pnpm test           # 29 unit tests
pnpm verify         # load-path check against the built artifact

dsh web --patch "$PWD/cordis.yml"
```

The overlay inserts one row:

```yaml
- insert:
    - id: vault-panel
      name: './lib/index.js'
      # config:
      #   vaultDir: ~/Vault          # default
      #   vaultBin: <vaultDir>/bin/vault
      #   timeoutMs: 15000
```

For a published install, replace `name` with the bare package name after installing it into the dsh tree.
Refresh the browser after (re)building the client bundle.

## Security model

| Surface | What it can reach |
| --- | --- |
| **Model / agent** | Nothing from this plugin — no tools are registered. Use `vault meta`/`vault ls` from a shell integration if an agent needs structure. |
| **Browser panel (human)** | Metadata freely; each plaintext value only on an explicit click (`reveal`), TOTP codes on demand. |
| **Other web origins** | Rejected: every `/vault-api` request with a cross-origin or `null` `Origin` header returns 403. Non-browser local callers (your own curl) carry no Origin and are allowed — they are in the same trust domain as the vault files themselves. |
| **Disk** | The vault stays sops-encrypted (allowlist mode: everything encrypted except explicitly public fields). This plugin never writes plaintext anywhere. |

Known limits (documented, not solved): the DSH web server binds loopback by default; if you expose it,
put authentication in front. Local processes running as your user can read the vault directly — that is
the pre-existing threat model of any local password store.

## Development

```
src/index.ts            host plugin: config, /vault-api prefix route
src/host/vault.ts       pure helpers (quoting, origin policy, parsing) — unit-tested
src/host/types.ts       structural types for webServer/shell (no internal deps)
src/client/index.ts     client plugin: slots registration + styles
src/client/VaultPanel.tsx  the panel UI (React, platform-provided)
src/client/logic.ts     pure UI transforms — unit-tested
scripts/verify.ts       built-artifact load-path verification
cordis.yml              opt-in overlay for `dsh web --patch`
```

The client bundle follows the DSH closure-factory convention (`window.__ModuleLoader__.load`, react and
cordis resolved from the platform module table); see `tsdown.config.ts`.

## Roadmap

- [ ] i18n (copy is zh-CN for now)
- [ ] entry rename / reorder, batch edit
- [ ] CSV import bridge (`vault export` output)
- [ ] optional model-facing read-only tools (`vault_list`/`vault_search`, structure-only by design)
- [ ] KeePassXC `.kdbx` mirror export for mobile

## License

MIT © skyzhao1223
