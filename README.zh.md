# dsh-plugin-vault

[English](README.md) | 中文

把本地 **sops + age + git** 加密凭据库接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web GUI 的侧边栏面板插件——并且在**人和模型之间划出一条硬安全边界**。

```
┌───────────────────────────── DSH Web 界面 ─────────────────────────────┐
│  侧边栏 🔒 Vault 面板                                                   │
│    · 按 工作/服务/生活 分组的条目行、搜索、git 未提交橙点                 │
│    · 详情抽屉：单字段 👁 显示 / 复制 / 编辑 / 删除                        │
│    · TOTP 环形倒计时 · 新建条目 · 安全审计                               │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ 同源 fetch（Origin 校验）
┌──────────────▼───────────────┐        ┌──────────────────────────────┐
│ Host 端：/vault-api 路由       │ shell  │ ~/Vault（sops + age + git）   │
│ 挂在 DSH web server 上         ├───────►│ vault CLI: meta/get/totp/…    │
└───────────────────────────────┘        └──────────────────────────────┘

模型从本插件拿不到任何工具。Agent 侧集成最多只应看到结构（vault meta）；
明文值只在人明确点击时经 Host→浏览器流动。
```

## 为什么做这个

密码管理器 GUI（KeePassXC / Bitwarden）是"二进制存储 + 纯人类工具"：不能 diff、没有审计轨迹，
想让 AI 接入就得交出主密码。而 sops+age 的 YAML 库正相反：白名单加密让结构保持可读、git 保留
全部历史、CLI 天然可脚本化——唯独缺一个好用的 GUI。本插件补上这块，且**不给模型开明文通道**。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0`、pnpm
- 一个由 `vault` CLI 驱动的凭据库（sops + age + git），面板需要这些子命令：
  - `vault meta` —— JSON 结构（明文元数据 + `enc` 标记，**不含任何密钥**）
  - `vault get <条目> [字段]`、`vault totp <条目>`、`vault audit`
  - 写操作：`vault set / rm / new / save`
- `dsh web`（Host 端依赖 `webServer` 与 `shell` 两个服务）

## 安装与挂载

```sh
git clone <本仓库> && cd dsh-plugin-vault
pnpm install
pnpm build          # tsc（node 半 + 类型）+ tsdown（浏览器 bundle）
pnpm test           # 29 个单元测试
pnpm verify         # 对构建产物做加载路径验证

dsh web --patch "$PWD/cordis.yml"
```

overlay 只插入一行：

```yaml
- insert:
    - id: vault-panel
      name: './lib/index.js'
      # config:
      #   vaultDir: ~/Vault          # 默认值
      #   vaultBin: <vaultDir>/bin/vault
      #   timeoutMs: 15000
```

发布安装时，把包装进 dsh 安装树后可将 `name` 换成裸包名。重新构建 client bundle 后刷新浏览器生效。

## 安全模型

| 面 | 能摸到什么 |
| --- | --- |
| **模型 / Agent** | 本插件零工具注册，什么都摸不到。Agent 侧如需结构，请走 shell 里的 `vault meta` / `vault ls`。 |
| **浏览器面板（人）** | 元数据随便看；每个明文值都要**明确点击**才经 `reveal` 取回；TOTP 按需生成。 |
| **其他网页源** | 拒绝：任何带跨源或 `null` Origin 头的 `/vault-api` 请求一律 403。无 Origin 的非浏览器本地调用（你自己的 curl）放行——它们和库文件本来就在同一信任域。 |
| **磁盘** | 库保持 sops 白名单加密（除显式公开字段外全部加密）。本插件不在任何地方写明文。 |

已知边界（如实说明，不假装解决）：DSH web server 默认只绑回环地址，若你要对外暴露请自行加认证；
以你的用户身份运行的本地进程本来就能直接读库——这是所有本地密码存储的共同威胁模型。

## 开发

```
src/index.ts            Host 插件：config、/vault-api 前缀路由
src/host/vault.ts       纯函数（引号转义、Origin 策略、输出解析）——有单测
src/host/types.ts       webServer/shell 的结构化类型（不依赖内部包）
src/client/index.ts     Client 插件：slots 注册 + 样式
src/client/VaultPanel.tsx  面板 UI（React 由平台模块表提供）
src/client/logic.ts     纯 UI 变换 —— 有单测
scripts/verify.ts       构建产物加载路径验证
cordis.yml              `dsh web --patch` 用的 opt-in overlay
```

Client bundle 遵循 DSH closure-factory 约定（`window.__ModuleLoader__.load`，react/cordis 从平台
模块表解析），见 `tsdown.config.ts`。

## 路线图

- [ ] i18n（当前文案为简体中文）
- [ ] 条目重命名 / 排序、批量编辑
- [ ] CSV 导入桥（对接 `vault export`）
- [ ] 可选的模型侧只读工具（`vault_list`/`vault_search`，设计上仅结构）
- [ ] KeePassXC `.kdbx` 镜像导出（手机端）

## 许可

MIT © skyzhao1223
