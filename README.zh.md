# dsh-plugin-sops-vault

[English](README.md) | 中文

把本地 **sops + age + git** 加密凭据库接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web GUI 的侧边栏面板插件——并且在**人和模型之间划出一条硬安全边界**。

```
┌───────────────────────────── DSH Web 界面 ─────────────────────────────┐
│  侧边栏 🔒 Vault 面板                                                   │
│    · 按前缀分组的条目行、搜索、git 未提交橙点                            │
│    · 详情抽屉：单字段 👁 显示 / 复制 / 编辑 / 删除                        │
│    · TOTP 环形倒计时 · 新建条目 · 安全审计 · 访问日志 · 中英双语          │
│    · 一键导入浏览器 Authenticator 扩展里的动态码种子                      │
│    · 按种类筛选：只看动态码的实时验证码视图（像验证器 App）                │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ 同源 fetch（Origin 校验）
┌──────────────▼───────────────┐        ┌──────────────────────────────┐
│ Host 端：/vault-api 路由       │ shell  │ <vaultDir>（sops + age + git） │
│ 内联 sops/git 驱动             ├───────►│ secrets.yaml · .sops.yaml      │
└───────────────────────────────┘        └──────────────────────────────┘

模型从本插件拿不到任何工具。Agent 侧最多看到结构（直接解析加密文件，不解密）；
明文值只在人明确点击时经 Host→浏览器流动。
```

## 截图

列表视图（分组条目、加密字段数徽章、悬停快捷操作）：

![面板列表视图](docs/panel-list.png)

详情抽屉（TOTP 环形倒计时）与单字段点击展开：

| 抽屉 + TOTP | 点击展开单个字段 |
|---|---|
| ![面板抽屉](docs/panel-drawer.png) | ![单字段展开](docs/panel-reveal.png) |

（截图数据全部为演示用假值，取自隔离实例）

## 为什么做这个

密码管理器 GUI（KeePassXC / Bitwarden）是"二进制存储 + 纯人类工具"：不能 diff、没有审计轨迹，
想让 AI 接入就得交出主密码。而 sops+age 的 YAML 库正相反：白名单加密让结构保持可读、git 保留
全部历史、一切可脚本化——唯独缺一个好用的 GUI。本插件补上这块，且**不给模型开明文通道**。

## 前置条件

兼容两代 DSH shell 接口：0.1.x 的 `shell.run` 与 0.2.x 的 `shell.execute`+`execution.result`，调用时自动探测。


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
pnpm test           # 95 个单元测试
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

挂载说明：`--patch` 是 dsh 的**全局**选项——用 `dsh web --patch <文件>`；
不要在其前面夹其他 web 选项（如 `dsh web --no-open --patch …` 会解析失败）。
启动会自动打开浏览器，多开的标签页关掉即可。

## API

DSH web server 上的一个前缀路由；所有响应都是 `{ok, data|error}` JSON。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/vault-api/meta` | GET | 全库结构，**不解密**直接解析加密文件 |
| `/vault-api/reveal` | POST | 单字段明文（`{name, field}`）——仅供人点击触发 |
| `/vault-api/totp` | POST | 当前 6 位动态码，Host 端用存储的种子计算 |
| `/vault-api/totp-batch` | POST | **一次解密**算出多条目的实时动态码（`{names?}`）——「动态码」视图的后端 |
| `/vault-api/audit` | GET | 白名单/泄漏审计报告 |
| `/vault-api/audit-log` | GET | 访问日志尾部 |
| `/vault-api/set` / `rm` / `create` / `save` | POST | 字段写入 / 删除 / 新建条目 / git 提交 |
| `/vault-api/rename` / `sort` | POST | 重命名单条 / 全库重排序 |
| `/vault-api/dirty` | GET | git 脏状态 |
| `/vault-api/import-scan` | GET | 扫描浏览器 Authenticator 扩展里的动态码条目（`?lang=zh|en` 决定原因文案语言） |
| `/vault-api/import-apply` | POST | 把勾选的条目写进库（`{items:[{id,name,username,url,note,overwrite}]}`） |

### 从 Chrome 的 Authenticator 扩展导入

顶栏「导入动态码」按钮直接读磁盘上的
[Authenticator](https://github.com/Authenticator-Extension/Authenticator) 扩展数据：内置只读 LevelDB
解析器（`src/host/leveldb.ts`——WAL 日志记录、SSTable 数据块、纯手写 Snappy 解压，无原生依赖），从
`<profile>/{Sync,Local} Extension Settings/<ext-id>/` 里恢复 `OTPStorage` 条目；读哪个区由扩展自己的
`UserSettings.storageLocation` 决定。macOS/Linux/Windows 上自动发现 Chrome、Chromium、Edge、Brave、
Vivaldi、Arc、Opera；非标准安装可用 `config.browserDataDir` 追加一个 user-data 根目录。

扫描只返回元数据（发行方、账号、类型、位数、周期、种子**长度**）。种子本身不过 API：apply 时 Host 重新
读盘并按 `id` 取回，再用 `sops set` 写进加密库。目标名称/URL/备注可逐行修改，还能统一加分组前缀。

不支持的会在对应行明确报出来：被扩展口令加密的条目（需要扩展那套 argon2 派生），以及计数器型/非
RFC6238 类型（HOTP、Steam、Battle.net）。参数非默认值的条目可以导入，但会带一条警告——面板的倒计时环
固定按 SHA-1 / 6 位 / 30 秒计算。

## 安全模型

| 面 | 能摸到什么 |
| --- | --- |
| **模型 / Agent** | 什么都摸不到——本插件不注册任何模型工具。 |
| **浏览器面板（人）** | 元数据随便看；每个明文值都要**明确点击**才经 `reveal` 取回；TOTP 按需生成。 |
| **其他网页源** | 拒绝：任何带跨源或 `null` Origin 头的请求一律 403。无 Origin 的非浏览器本地调用（你自己的 curl）放行——它们和库文件本来就在同一信任域。 |
| **磁盘** | 库保持 sops 白名单加密。本插件不在任何地方写明文。 |
| **批量刮取** | `reveal`/`totp` 共享 30 次/分钟滑动窗口限速（内存态）；超出返回 429 并提示“视 GUI 已失陷”。XSS 页面想扫全库会立刻撞墙。 |
| **实时验证码视图** | `totp-batch` 在 Host 内存里解密一次（暴露面与既有 `roundtrip` 相同），只返回派生出的 30 秒验证码，**绝不返回种子**。独立 10 次/分钟上限；视图每轮转拉一次，标签页隐藏时暂停。 |
| **浏览器导入** | 扩展存储只读打开；种子全程留在 Host 侧（API 只传 `secretLen`，绝不传种子），直接落进 sops 加密库。scan/apply 另有 12 次/分钟上限。 |

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
src/host/leveldb.ts     只读 LevelDB 解析器（WAL + SSTable + Snappy）——有单测
src/host/authenticator.ts  浏览器发现 + Authenticator 条目解析——有单测
src/client/index.ts     Client 插件：slots 注册 + 样式
src/client/VaultPanel.tsx  面板 UI（React 由平台模块表提供）
src/client/logic.ts     纯 UI 变换 —— 有单测
src/client/i18n.ts      中英字典（navigator.language 自动选择）
tests/fixtures/leveldb.ts  合成 LevelDB 编码器（测试不碰真实浏览器配置）
scripts/verify.ts       构建产物加载路径验证
cordis.yml              `dsh web --patch` 用的 opt-in overlay
```

Client bundle 遵循 DSH closure-factory 约定（`window.__ModuleLoader__.load`，react/cordis 从平台
模块表解析），见 `tsdown.config.ts`。

## 路线图

- [ ] 文案接入 DSH locale 服务（目前是独立中英字典）
- [ ] README 截图（等真机挂载后补）
- [x] reveal 限速（30 次/分钟滑动窗口，v0.2.0）
- [x] 条目重命名 + 一键排序（v0.3.0）
- [ ] 批量编辑
- [x] 浏览器 Authenticator 导入（LevelDB 读取器 + scan/apply，v0.4.0）
- [ ] CSV 导入桥、KeePassXC `.kdbx` 镜像导出（手机端）
- [ ] 可选的模型侧只读工具（`vault_list`，设计上仅结构）

## 许可

MIT © skyzhao1223
