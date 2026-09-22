# dsh-plugin-sops-vault

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that turns a local
[sops](https://github.com/getsops/sops) + [age](https://age-encryption.org) + git credential vault into a
first-class sidebar panel of the DSH Web GUI — with a hard security boundary between the human and the model.

```
┌───────────────────────────── DSH Web GUI ─────────────────────────────┐
│  Sidebar: 🔒 Vault panel                                              │
│    · entry rows grouped by prefix, search, git-dirty badge            │
│    · detail drawer: per-field 👁 reveal / copy / edit / delete         │
│    · live TOTP with countdown ring · entry creation · security audit   │
│    · access log (values never logged) · zh/en UI                       │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ same-origin fetch (Origin-checked)
┌──────────────▼───────────────┐        ┌──────────────────────────────┐
│ Host half: /vault-api route   │ shell  │ <vaultDir> (sops + age + git) │
│ inline sops/git driver        ├───────►│ secrets.yaml · .sops.yaml     │
└───────────────────────────────┘        └──────────────────────────────┘

The MODEL gets no tool from this plugin. Structure (parsed from the encrypted
file, no decryption) is the most an agent-side integration should see;
plaintext values only ever flow Host→browser on an explicit human click.
```

## Screenshots

List view (grouped entries, encrypted-field badges, quick actions on hover):

![panel list view](docs/panel-list.png)

Detail drawer with live TOTP ring, plus one-click single-field reveal:

| Drawer + TOTP | Field revealed on click |
|---|---|
| ![panel drawer](docs/panel-drawer.png) | ![panel reveal](docs/panel-reveal.png) |

## Why

Password-manager GUIs (KeePassXC, Bitwarden) are binary-store, human-only tools: no diff, no audit trail,
and wiring an AI agent to them means handing over the master password. A sops+age YAML vault is the
opposite: allowlist-encrypted fields keep structure readable, git keeps history, and everything stays
scriptable. This plugin gives that stack the GUI it was missing — without opening a plaintext channel to
the model.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`, pnpm
- `sops`, `age`, `git` on the host PATH (`brew install sops age`)
- A vault repository at `~/Vault` (or `config.vaultDir`) — easiest created by **[sops-vault-kit](https://github.com/skyzhao1223/sops-vault-kit)** (`./install.sh`), containing:
  - `secrets.yaml` — sops-encrypted YAML; entries live under a top-level `systems:` map
  - `.sops.yaml` — creation rules using the **allowlist** mode (`unencrypted_regex`: everything
    encrypted except explicitly public field names like `url`/`appid`/`env`/`owner`/`note`)
  - an age key reachable by sops (default: `~/Library/Application Support/sops/age/keys.txt` on macOS,
    `~/.config/sops/age/keys.txt` on Linux, or `SOPS_AGE_KEY_FILE`)
- `dsh web` (the host half needs the `webServer` and `shell` services)

No other CLI or daemon is required — the plugin drives `sops` and `git` directly.

## Install & mount

```sh
git clone https://github.com/skyzhao1223/dsh-plugin-sops-vault && cd dsh-plugin-sops-vault
pnpm install
pnpm build          # tsc (node half + types) + tsdown (browser bundle)
pnpm test           # 47 unit tests
pnpm verify         # load-path check against the built artifact

dsh web --patch "$PWD/cordis.yml"
```

The overlay inserts one row:

```yaml
- insert:
    - id: vault-panel
      name: './lib/index.js'
      # config:
      #   vaultDir: ~/Vault     # leading ~ is expanded
      #   sopsBin: sops         # resolved via PATH
      #   gitBin: git
      #   timeoutMs: 15000
```

For a published install, replace `name` with the bare package name after installing it into the dsh tree.
Refresh the browser after (re)building the client bundle.

Mounting note: `--patch` is a **global** dsh option — `dsh web --patch <file>` works;
do not sandwich other web options before it (e.g. `dsh web --no-open --patch …` fails
to parse). The browser opens automatically; close the extra tab if unwanted.

## API

One prefix route on the DSH web server; every response is `{ok, data|error}` JSON.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/vault-api/meta` | GET | whole-vault structure, parsed from the encrypted file **without decrypting** |
| `/vault-api/reveal` | POST | one field's plaintext (`{name, field}`) — human-click only |
| `/vault-api/totp` | POST | current 6-digit code, computed host-side from the stored seed |
| `/vault-api/audit` | GET | allowlist/leak audit report |
| `/vault-api/audit-log` | GET | tail of the access log |
| `/vault-api/set` / `rm` / `create` / `save` | POST | field write / delete / new entry / git commit |
| `/vault-api/dirty` | GET | git dirty state |

## Security model

| Surface | What it can reach |
| --- | --- |
| **Model / agent** | Nothing — no tools are registered by this plugin. |
| **Browser panel (human)** | Metadata freely; each plaintext value only on an explicit click; TOTP codes on demand. |
| **Other web origins** | Rejected: any request carrying a cross-origin or `null` `Origin` gets 403. Origin-less callers (your own curl) are allowed — same trust domain as the vault files. |
| **Disk** | The vault stays sops-encrypted (allowlist mode). The plugin writes no plaintext anywhere. |
| **Scraping attempts** | `reveal`/`totp` share a 30/min sliding-window rate limit (in-memory); excess gets 429 with a *treat the GUI as compromised* hint. Blunts bulk-scraping by an XSS'd page. |

**Access log**: every reveal/totp/set/rm/create/save appends one line — ISO time, action, target, source
IP — to `<vaultDir>/.git/dsh-vault-audit.log` (inside `.git/` so git status stays clean; falls back to
`<vaultDir>/.audit.log` for non-git vaults). **Values are never logged.** The audit modal shows the tail.

Note: the DSH page token gates the app shell, **not** plugin-registered `webServer` routes — `/vault-api` is reachable by any local caller without the token (verified). Its guards are the Origin policy plus loopback binding.

Known limits (documented, not solved): the DSH web server binds loopback by default — if you expose it,
put authentication in front. Local processes running as your user can read the vault directly; that is
the pre-existing threat model of any local password store. An XSS inside the DSH GUI could script the
panel's API — same blast radius as any in-page secret manager.

## Development

```
src/index.ts            host plugin: config, /vault-api route, sops/git driver, access log
src/host/vault.ts       pure vault logic (parsing, allowlist audit, TOTP, quoting) — unit-tested
src/host/types.ts       structural types for webServer/shell (no internal deps)
src/client/index.ts     client plugin: slots registration + styles
src/client/VaultPanel.tsx  the panel UI (React from the platform module table)
src/client/logic.ts     pure UI transforms — unit-tested
src/client/i18n.ts      zh/en dictionaries (auto-detect via navigator.language)
scripts/verify.ts       built-artifact load-path verification
cordis.yml              opt-in overlay for `dsh web --patch`
```

The client bundle follows the DSH closure-factory convention (`window.__ModuleLoader__.load`, react and
cordis resolved from the platform module table); see `tsdown.config.ts`.

## Roadmap

- [ ] wire copy into the DSH locale service (currently standalone zh/en dictionaries)
- [ ] screenshots in this README (pending a real mounted run)
- [x] reveal rate-limiting (30/min sliding window, v0.2.0)
- [x] entry rename + one-click sort (v0.3.0)
- [ ] batch edit
- [ ] CSV import bridge, KeePassXC `.kdbx` mirror export for mobile
- [ ] optional model-facing read-only tools (`vault_list`, structure-only by design)

## License

MIT © skyzhao1223
