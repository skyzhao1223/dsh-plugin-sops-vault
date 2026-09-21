/**
 * Bilingual copy dictionary. Language is picked once from `navigator.language`
 * (zh* → Chinese, everything else → English). Deliberately dependency-free:
 * wiring into the DSH locale service is a roadmap item, this covers the two
 * languages the panel ships with.
 *
 * @module dsh-plugin-sops-vault/client/i18n
 */

export type Lang = 'zh' | 'en'

const ZH = {
  sidebarLabel: 'Vault 密码库',
  searchPlaceholder: '搜索系统 / 字段 / 值…（按 / 聚焦）',
  refresh: '刷新',
  reload: '重新读取',
  audit: '审计',
  create: '新建',
  commit: '提交',
  uncommitted: '有未提交改动',
  entriesSuffix: '条',
  encFieldsSuffix: '个加密字段',
  subline: '加密值只在你点击时才从 Host 取回；模型侧只能读到结构，拿不到明文。数据源 ~/Vault（sops+age+git）。快捷键：/ 搜索 · Esc 返回',
  loadFail: '加载失败：',
  retry: '重试',
  loading: '正在读取…',
  noMatch: '没有匹配“{q}”的记录',
  emptyVault: '库是空的，点右上“新建”添加第一条',
  groupFallback: '未分组',
  entriesSuffixGroup: '条',
  openLink: '打开链接',
  copyPassword: '复制密码',
  copyUsername: '复制账号',
  totpSection: '动态验证码',
  totpRefreshIn: '{n}s 后刷新',
  totpRefreshing: '刷新中…',
  totpCopyLabel: '动态码',
  fieldsSection: '字段',
  addField: '添加字段',
  fieldNamePh: '字段名',
  fieldValuePh: '值',
  add: '添加',
  cancel: '取消',
  encHint: '字段名不在白名单内会自动加密（unencrypted_regex 规则）',
  commitHint: '改动后记得在顶栏点“提交”（git）',
  deleteEntry: '删除条目',
  confirmDeleteEntry: '确认删除整条？',
  clickToShow: '点击显示',
  clickToCopy: '点击复制',
  show: '显示',
  hide: '隐藏',
  edit: '编辑',
  save: '保存',
  deleteField: '删除字段',
  confirmDeleteField: '再点一次确认删除',
  quickCopyTitle: '复制密码（不显示）',
  encFieldsTitle: '{n} 个加密字段',
  closeTitle: '关闭 (Esc)',
  copied: '✓ 已复制 {label}',
  copiedHidden: '✓ 已复制 {name} 的 {field}（未显示）',
  copyFailed: '复制失败',
  saved: '✓ 已保存 {name} · {field}',
  fieldDeleted: '已删除字段 {field}',
  entryDeleted: '已删除 {name}',
  created: '✓ 已创建 {name}（密码已随机生成）',
  committed: '✓ 已提交到 git',
  newTitle: '新建条目',
  nameLabel: '名称 *（用 / 分组，如 服务/微信支付）',
  namePh: '服务/新服务',
  urlLabel: 'URL',
  usernameLabel: '用户名',
  noteLabel: '备注',
  notePh: '用途 / 申请流程 / 注意事项',
  newHint: '密码会自动生成 24 位随机值（不显示）；建好后在详情里点复制。服务凭证类（AppID/AppKey）建好后用“添加字段”补充。',
  creating: '创建中…',
  createBtn: '创建',
  auditTitle: '安全审计',
  auditRunning: '审计运行中…',
  auditLogTitle: '访问日志（最近 200 条，不含明文值）',
  auditLogEmpty: '暂无访问记录',
  auditLogNone: '（无日志文件）',
  ownerPrefix: '负责: ',
  keyIconTitle: '密钥字段',
} as const

const EN: Record<keyof typeof ZH, string> = {
  sidebarLabel: 'Vault',
  searchPlaceholder: 'Search entries / fields / values… (press /)',
  refresh: 'Refresh',
  reload: 'Reload',
  audit: 'Audit',
  create: 'New',
  commit: 'Commit',
  uncommitted: 'Uncommitted changes',
  entriesSuffix: 'entries',
  encFieldsSuffix: 'encrypted fields',
  subline: 'Encrypted values are fetched from the Host only when you click; the model side sees structure only, never plaintext. Source: ~/Vault (sops+age+git). Keys: / search · Esc back',
  loadFail: 'Load failed: ',
  retry: 'Retry',
  loading: 'Loading…',
  noMatch: 'No entries matching “{q}”',
  emptyVault: 'Vault is empty — click “New” to add the first entry',
  groupFallback: 'Ungrouped',
  entriesSuffixGroup: '',
  openLink: 'Open link',
  copyPassword: 'Copy password',
  copyUsername: 'Copy username',
  totpSection: 'One-time code',
  totpRefreshIn: 'refresh in {n}s',
  totpRefreshing: 'refreshing…',
  totpCopyLabel: 'TOTP code',
  fieldsSection: 'Fields',
  addField: 'Add field',
  fieldNamePh: 'field',
  fieldValuePh: 'value',
  add: 'Add',
  cancel: 'Cancel',
  encHint: 'Field names outside the allowlist are encrypted automatically (unencrypted_regex)',
  commitHint: 'Remember to hit “Commit” in the toolbar after changes (git)',
  deleteEntry: 'Delete entry',
  confirmDeleteEntry: 'Delete whole entry?',
  clickToShow: 'Click to reveal',
  clickToCopy: 'Click to copy',
  show: 'Reveal',
  hide: 'Hide',
  edit: 'Edit',
  save: 'Save',
  deleteField: 'Delete field',
  confirmDeleteField: 'Click again to confirm',
  quickCopyTitle: 'Copy password (stays hidden)',
  encFieldsTitle: '{n} encrypted fields',
  closeTitle: 'Close (Esc)',
  copied: '✓ Copied {label}',
  copiedHidden: '✓ Copied {field} of {name} (not shown)',
  copyFailed: 'Copy failed',
  saved: '✓ Saved {name} · {field}',
  fieldDeleted: 'Deleted field {field}',
  entryDeleted: 'Deleted {name}',
  created: '✓ Created {name} (password generated)',
  committed: '✓ Committed to git',
  newTitle: 'New entry',
  nameLabel: 'Name * (group with /, e.g. services/stripe)',
  namePh: 'services/new-service',
  urlLabel: 'URL',
  usernameLabel: 'Username',
  noteLabel: 'Note',
  notePh: 'purpose / access process / caveats',
  newHint: 'A 24-char random password is generated (never shown); copy it from the detail drawer. For service credentials (AppID/AppKey), add fields after creating.',
  creating: 'Creating…',
  createBtn: 'Create',
  auditTitle: 'Security audit',
  auditRunning: 'Running audit…',
  auditLogTitle: 'Access log (last 200, values never logged)',
  auditLogEmpty: 'No access recorded yet',
  auditLogNone: '(no log file)',
  ownerPrefix: 'owner: ',
  keyIconTitle: 'encrypted field',
}

export type CopyKey = keyof typeof ZH

/** Detect the UI language from the browser (defaults to zh). */
export function detectLang(): Lang {
  try {
    const l = typeof navigator !== 'undefined' ? navigator.language : 'zh'
    return typeof l === 'string' && l.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

/** Build the translate function for one language. */
export function makeT(lang: Lang): (key: CopyKey, vars?: Record<string, string | number>) => string {
  const dict: Record<string, string> = lang === 'zh' ? ZH : EN
  return (key, vars) => {
    let s = dict[key] ?? ZH[key] ?? String(key)
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
    return s
  }
}
