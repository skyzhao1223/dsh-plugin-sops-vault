# dsh-plugin-sops-vault

[English](README.md) | 中文

把本地 **sops + age + git** 加密凭据库接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web GUI 的侧边栏面板插件——并且在**人和模型之间划出一条硬安全边界**。

```
┌───────────────────────────── DSH Web 界面 ─────────────────────────────┐
│  侧边栏 🔒 Vault 面板                                                   │
│    · 按前缀分组的条目行、搜索、git 未提交橙点                            │
│    · 详情抽屉：单字段 👁 显示 / 复制 / 编辑 / 删除                        │
│    · TOTP 环形倒计时 · 新建条目 · 安全审计 · 访问日志 · 中英双语          │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ 同源 fetch（Origin 校验）
┌──────────────▼───────────────┐        ┌──────────────────────────────┐
│ Host 端：/vault-api 路由       │ shell  │ <vaultDir>（sops + age + git） │
│ 内联 sops/git 驱动             ├───────►│ secrets.yaml · .sops.yaml      │
└───────────────────────────────┘        └──────────────────────────────┘

模型从本插件拿不到任何工具。Agent 侧最多看到结构（直接解析加密文件，不解密）；
明文值只在人明确点击时经 Host→浏览器流动。
```

## 为什么做这个

密码管理器 GUI（KeePassXC / Bitwarden）是"二进制存储 + 纯人类工具"：不能 diff、没有审计轨迹，
想让 AI 接入就得交出主密码。而 sops+age 的 YAML 库正相反：白名单加密让结构保持可读、git 保留
全部历史、一切可脚本化——唯独缺一个好用的 GUI。本插件补上这块，且**不给模型开明文通道**。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0`、pnpm
- Host PATH 上有 `sops`、`age`、`git`（`brew install sops age`）
- 一个位于 `~/Vault`（或 `config.vaultDir`）的库仓库——最省事的方式是用 **[sops-vault-kit](https://github.com/skyzhao1223/sops-vault-kit)** 一键生成（`./install.sh`），包含：
  - `secrets.yaml` —— sops 加密的 YAML，条目在顶层 `systems:` 映射下
  - `.sops.yaml` —— 使用**白名单**模式的规则（`unencrypted_regex`：除显式公开的字段名
    （如 `url`/`appid`/`env`/`owner`/`note`）外全部加密）
  - sops 能找到的 age 密钥（macOS 默认 `~/Library/Application Support/sops/age/keys.txt`，
    Linux `~/.config/sops/age/keys.txt`，或 `SOPS_AGE_KEY_FILE`）
- `dsh web`（Host 端依赖 `webServer` 与 `shell` 两个服务）

**不需要任何其他 CLI 或守护进程**——插件直接驱动 `sops` 和 `git`。

## 安装与挂载

```sh
git clone https://github.com/skyzhao1223/dsh-plugin-sops-vault && cd dsh-plugin-sops-vault
pnpm install
pnpm build          # tsc（node 半 + 类型）+ tsdown（浏览器 bundle）
pnpm test           # 47 个单元测试
pnpm verify         # 对构建产物做加载路径验证

dsh web --patch "$PWD/cordis.yml"
```

overlay 只插入一行：

```yaml
- insert:
    - id: vault-panel
      name: './lib/index.js'
      # config:
      #   vaultDir: ~/Vault     # 支持 ~ 展开
      #   sopsBin: sops         # 走 PATH 解析
      #   gitBin: git
      #   timeoutMs: 15000
```

发布安装时，把包装进 dsh 安装树后可将 `name` 换成裸包名。重新构建 client bundle 后刷新浏览器生效。

## API

DSH web server 上的一个前缀路由；所有响应都是 `{ok, data|error}` JSON。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/vault-api/meta` | GET | 全库结构，**不解密**直接解析加密文件 |
| `/vault-api/reveal` | POST | 单字段明文（`{name, field}`）——仅供人点击触发 |
| `/vault-api/totp` | POST | 当前 6 位动态码，Host 端用存储的种子计算 |
| `/vault-api/audit` | GET | 白名单/泄漏审计报告 |
| `/vault-api/audit-log` | GET | 访问日志尾部 |
| `/vault-api/set` / `rm` / `create` / `save` | POST | 字段写入 / 删除 / 新建条目 / git 提交 |
| `/vault-api/dirty` | GET | git 脏状态 |

## 安全模型

| 面 | 能摸到什么 |
| --- | --- |
| **模型 / Agent** | 什么都摸不到——本插件不注册任何模型工具。 |
| **浏览器面板（人）** | 元数据随便看；每个明文值都要**明确点击**才经 `reveal` 取回；TOTP 按需生成。 |
| **其他网页源** | 拒绝：任何带跨源或 `null` Origin 头的请求一律 403。无 Origin 的非浏览器本地调用（你自己的 curl）放行——它们和库文件本来就在同一信任域。 |
| **磁盘** | 库保持 sops 白名单加密。本插件不在任何地方写明文。 |
| **批量刮取** | `reveal`/`totp` 共享 30 次/分钟滑动窗口限速（内存态）；超出返回 429 并提示“视 GUI 已失陷”。XSS 页面想扫全库会立刻撞墙。 |

**访问日志**：每次 reveal/totp/set/rm/create/save 追加一行——ISO 时间、动作、目标、来源 IP——
写入 `<vaultDir>/.git/dsh-vault-audit.log`（放 `.git/` 里所以不影响 git 状态；非 git 库回退到
`<vaultDir>/.audit.log`）。**日志绝不含值。** 审计弹窗里能看尾部记录。

注意：DSH 的页面 token 只保护应用外壳，**不覆盖**插件注册的 `webServer` 路由——`/vault-api` 对任何本地调用者无需 token 即可达（实测确认）。它的防线是 Origin 策略 + 回环绑定。

已知边界（如实说明，不假装解决）：DSH web server 默认只绑回环地址，若对外暴露请自行加认证；
以你的用户身份运行的本地进程本来就能直接读库——这是所有本地密码存储的共同威胁模型；
DSH GUI 内部若被 XSS，攻击者能以页面身份调 API——爆炸半径与任何页内密码管理器相同。

## 开发

```
src/index.ts            Host 插件：config、/vault-api 路由、sops/git 驱动、访问日志
src/host/vault.ts       纯 vault 逻辑（解析、白名单审计、TOTP、引号转义）——有单测
src/host/types.ts       webServer/shell 的结构化类型（不依赖内部包）
src/client/index.ts     Client 插件：slots 注册 + 样式
src/client/VaultPanel.tsx  面板 UI（React 由平台模块表提供）
src/client/logic.ts     纯 UI 变换 —— 有单测
src/client/i18n.ts      中英字典（navigator.language 自动选择）
scripts/verify.ts       构建产物加载路径验证
cordis.yml              `dsh web --patch` 用的 opt-in overlay
```

Client bundle 遵循 DSH closure-factory 约定（`window.__ModuleLoader__.load`，react/cordis 从平台
模块表解析），见 `tsdown.config.ts`。

## 路线图

- [ ] 文案接入 DSH locale 服务（目前是独立中英字典）
- [ ] README 截图（等真机挂载后补）
- [x] reveal 限速（30 次/分钟滑动窗口，v0.2.0）
- [ ] 条目重命名 / 排序、批量编辑
- [ ] CSV 导入桥、KeePassXC `.kdbx` 镜像导出（手机端）
- [ ] 可选的模型侧只读工具（`vault_list`，设计上仅结构）

## 许可

MIT © skyzhao1223
