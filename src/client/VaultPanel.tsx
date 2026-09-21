/**
 * The Vault panel: compact entry rows grouped by prefix, a detail drawer with
 * per-field reveal/copy/edit/delete, live TOTP with a countdown ring, entry
 * creation, security audit, and git dirty-state commit — all driven through
 * the same-origin `/vault-api` route of the node half.
 *
 * Plaintext secret values are fetched per field on explicit click only and
 * kept in component state (memory), never persisted by this bundle.
 *
 * @module dsh-plugin-vault/client/VaultPanel
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { api } from './api.ts'
import type { FieldMeta, TotpResult, VaultMeta } from './api.ts'
import {
  chipsOf, encCount, entrySubline, fieldOrder, groupEntries,
  hueOf, isLinkValue, matchEntry, noteOf, shortName,
} from './logic.ts'

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

/* ---------- icons ---------- */

type IconSpec = Array<[string, Record<string, string | number>]>
const ICONS: Record<string, IconSpec> = {
  copy: [['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  eye: [['path', { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeoff: [['path', { d: 'M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24' }], ['line', { x1: 1, y1: 1, x2: 23, y2: 23 }]],
  ext: [['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }], ['path', { d: 'M15 3h6v6' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
  x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  refresh: [['path', { d: 'M21 2v6h-6' }], ['path', { d: 'M3 12a9 9 0 0 1 15-6.7L21 8' }], ['path', { d: 'M3 22v-6h6' }], ['path', { d: 'M21 12a9 9 0 0 1-15 6.7L3 16' }]],
  shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['line', { x1: 21, y1: 21, x2: 16.5, y2: 16.5 }]],
  pencil: [['path', { d: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }]],
  trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }]],
  chev: [['path', { d: 'M6 9l6 6 6-6' }]],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 4.5 }], ['path', { d: 'M21 2l-9.6 9.6' }], ['path', { d: 'M15.5 7.5l3 3' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
}

function Glyph({ n, s = 14 }: { n: string; s?: number }) {
  return createElement('svg',
    {
      width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    },
    ...(ICONS[n] ?? []).map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })))
}

/* ---------- clipboard + toast helpers ---------- */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/* ---------- TOTP widget ---------- */

function TotpWidget({ name, onCopy }: { name: string; onCopy: (text: string, label: string) => void }) {
  const [code, setCode] = useState('')
  const [left, setLeft] = useState(0)
  const [remain, setRemain] = useState(30)
  const fetching = useRef(false)

  const fetchCode = useCallback(() => {
    if (fetching.current) return
    fetching.current = true
    api<TotpResult>('totp', { name }).then(
      (r) => { setCode(r.code); setRemain(r.remain > 0 ? r.remain : 30); setLeft(r.remain) },
      () => { setCode((c) => c || '\u26a0') },
    ).finally(() => { fetching.current = false })
  }, [name])

  useEffect(() => {
    fetchCode()
    const id = window.setInterval(() => setLeft((x) => x - 1), 1000)
    return () => window.clearInterval(id)
  }, [fetchCode])

  useEffect(() => {
    if (left <= 0 && code !== '' && code !== '\u26a0') fetchCode()
  }, [left, code, fetchCode])

  const frac = remain > 0 ? Math.max(0, Math.min(1, left / remain)) : 0
  return (
    <div className="vp-totp">
      <svg width={42} height={42} viewBox="0 0 32 32">
        <circle cx={16} cy={16} r={13} fill="none" stroke="var(--dsw-alias-border-l1,#2a3040)" strokeWidth={3} />
        <circle cx={16} cy={16} r={13} fill="none"
          stroke={left <= 5 ? 'var(--dsw-alias-state-error-primary,#ff5c5c)' : 'var(--dsw-alias-brand-primary,#4c8dff)'}
          strokeWidth={3} strokeLinecap="round" strokeDasharray={81.7} strokeDashoffset={81.7 * (1 - frac)}
          transform="rotate(-90 16 16)" style={{ transition: 'stroke-dashoffset 1s linear' }} />
      </svg>
      <span className="vp-totp-code" title="点击复制"
        onClick={() => { if (/^\d+$/.test(code)) void onCopy(code, `${name} 动态码`) }}>
        {code || '\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7'}
      </span>
      <span className="vp-totp-left">{left > 0 ? `${String(left)}s 后刷新` : '刷新中…'}</span>
    </div>
  )
}

/* ---------- field row ---------- */

interface FieldRowProps {
  name: string
  field: string
  f: FieldMeta
  revealed: string | undefined
  onReveal: (n: string, f: string) => void
  onHide: (n: string, f: string) => void
  onCopy: (text: string, label: string) => void
  onSave: (n: string, f: string, v: string, done: () => void) => void
  onDeleteField: (n: string, f: string) => void
}

function FieldRow(props: FieldRowProps) {
  const { name: n, field: k, f, revealed } = props
  const shown = revealed !== undefined ? revealed : (f.enc ? null : String(f.value ?? ''))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(() => {
    if (editing && draft === '' && revealed !== undefined) setDraft(revealed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed])

  if (editing) {
    const save = () => props.onSave(n, k, draft, () => setEditing(false))
    return (
      <div className="vp-f">
        <span className="vp-k" title={k}>{k}</span>
        <input className="vp-edit-in" value={draft} autoFocus
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} />
        <div className="vp-facts">
          <button className="vp-icobtn" title="保存" onClick={save}><Glyph n="check" /></button>
          <button className="vp-icobtn" title="取消" onClick={() => setEditing(false)}><Glyph n="x" /></button>
        </div>
      </div>
    )
  }

  let valueNode: ReactNode
  if (shown === null) {
    valueNode = <span className="vp-v vp-mask" title="点击显示" onClick={() => props.onReveal(n, k)}>{MASK}</span>
  } else if (isLinkValue(shown)) {
    valueNode = <a className="vp-v vp-a" href={shown} target="_blank" rel="noreferrer">{shown}</a>
  } else {
    valueNode = <span className="vp-v vp-vclick" title="点击复制" onClick={() => props.onCopy(shown, `${n} · ${k}`)}>{shown}</span>
  }

  return (
    <div className="vp-f">
      <span className="vp-k" title={k}>{f.enc ? <><Glyph n="key" s={10} />{k}</> : k}</span>
      {valueNode}
      <div className="vp-facts">
        {shown !== null ? <button className="vp-icobtn" title="复制" onClick={() => props.onCopy(shown, `${n} · ${k}`)}><Glyph n="copy" s={12} /></button> : null}
        {f.enc ? (
          <button className="vp-icobtn" title={revealed !== undefined ? '隐藏' : '显示'}
            onClick={() => { if (revealed !== undefined) props.onHide(n, k); else props.onReveal(n, k) }}>
            <Glyph n={revealed !== undefined ? 'eyeoff' : 'eye'} s={12} />
          </button>
        ) : null}
        <button className="vp-icobtn" title="编辑"
          onClick={() => { setDraft(shown ?? ''); setEditing(true); if (shown === null) props.onReveal(n, k) }}>
          <Glyph n="pencil" s={12} />
        </button>
        {confirmDel ? (
          <button className="vp-icobtn" title="再点一次确认删除" style={{ color: 'var(--dsw-alias-state-error-primary,#ff5c5c)', opacity: 1 }}
            onClick={() => { setConfirmDel(false); props.onDeleteField(n, k) }}>
            <Glyph n="trash" s={12} />
          </button>
        ) : (
          <button className="vp-icobtn" title="删除字段" onClick={() => setConfirmDel(true)}><Glyph n="trash" s={12} /></button>
        )}
      </div>
    </div>
  )
}

/* ---------- drawer ---------- */

interface DrawerProps {
  name: string
  fields: Record<string, FieldMeta>
  secrets: Record<string, string>
  onReveal: (n: string, f: string) => void
  onHide: (n: string, f: string) => void
  onCopy: (text: string, label: string) => void
  onQuickCopy: (n: string, f: string) => void
  onSave: (n: string, f: string, v: string, done: () => void) => void
  onDeleteField: (n: string, f: string) => void
  onDeleteEntry: (n: string) => void
  onClose: () => void
}

function Drawer(props: DrawerProps) {
  const { name: n, fields: fs } = props
  const [addOpen, setAddOpen] = useState(false)
  const [fk, setFk] = useState('')
  const [fv, setFv] = useState('')
  const [confirmEntry, setConfirmEntry] = useState(false)

  const hasTotp = !!(fs.totp && fs.totp.enc)
  const keys = fieldOrder(fs)
  const url = fs.url && !fs.url.enc ? String(fs.url.value ?? '') : ''
  const chips = chipsOf(fs)
  const note = noteOf(fs)
  const short = shortName(n)

  return (
    <div className="vp-drawer" role="dialog" aria-label={n}>
      <div className="vp-dh">
        <div className="vp-av" style={{ background: `hsl(${String(hueOf(n))},52%,42%)` }}>{short.slice(0, 1).toUpperCase()}</div>
        <div className="vp-dtitle">
          <div className="vp-dname">{n}</div>
          {chips.length > 0 ? <div className="vp-dchips">{chips.map((c) => <span className="vp-chip" key={c}>{c}</span>)}</div> : null}
        </div>
        <button className="vp-x" title="关闭 (Esc)" onClick={props.onClose}><Glyph n="x" /></button>
      </div>
      <div className="vp-db">
        <div className="vp-acts">
          {url ? <a className="vp-btn vp-btn-pri" href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Glyph n="ext" s={12} />打开链接</a> : null}
          {fs.password && fs.password.enc ? <button className="vp-btn" onClick={() => props.onQuickCopy(n, 'password')}><Glyph n="copy" s={12} />复制密码</button> : null}
          {fs.username && !fs.username.enc && fs.username.value ? <button className="vp-btn" onClick={() => props.onCopy(String(fs.username?.value ?? ''), `${n} · username`)}><Glyph n="copy" s={12} />复制账号</button> : null}
        </div>
        {hasTotp ? <div><div className="vp-sec">动态验证码</div><TotpWidget name={n} onCopy={props.onCopy} /></div> : null}
        <div className="vp-sec">字段 ({keys.length})</div>
        {keys.map((k) => (
          <FieldRow key={k} name={n} field={k} f={fs[k]!} revealed={props.secrets[`${n}\u0000${k}`]}
            onReveal={props.onReveal} onHide={props.onHide} onCopy={props.onCopy}
            onSave={props.onSave} onDeleteField={props.onDeleteField} />
        ))}
        {addOpen ? (
          <div className="vp-addf">
            <input placeholder="字段名" value={fk} onChange={(e: ChangeEvent<HTMLInputElement>) => setFk(e.target.value)} />
            <input className="vp-wide" placeholder="值" value={fv}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFv(e.target.value)}
              onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter' && fk) props.onSave(n, fk, fv, () => { setAddOpen(false); setFk(''); setFv('') }) }} />
            <button className="vp-btn" disabled={!fk}
              onClick={() => props.onSave(n, fk, fv, () => { setAddOpen(false); setFk(''); setFv('') })}>添加</button>
            <button className="vp-btn" onClick={() => setAddOpen(false)}>取消</button>
          </div>
        ) : (
          <button className="vp-btn" style={{ marginTop: 9 }} onClick={() => setAddOpen(true)}><Glyph n="plus" s={12} />添加字段</button>
        )}
        <div className="vp-hint" style={{ marginTop: 7 }}>字段名含 key / secret / token / cert 等会自动加密（白名单规则）</div>
        {note ? <div className="vp-note">{note}</div> : null}
        <div className="vp-danger">
          <span className="vp-dhint">改动后记得在顶栏点“提交”（git）</span>
          {confirmEntry ? (
            <button className="vp-btn vp-btn-danger" onClick={() => { setConfirmEntry(false); props.onDeleteEntry(n) }}>确认删除整条？</button>
          ) : (
            <button className="vp-btn vp-btn-danger" onClick={() => setConfirmEntry(true)}><Glyph n="trash" s={12} />删除条目</button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- modals ---------- */

function NewModal({ onClose, onCreated, onSay }: { onClose: () => void; onCreated: (name: string) => void; onSay: (m: string) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = () => {
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    api<{ created: string }>('create', { name: nm, url: url.trim(), username: username.trim(), note: note.trim() }).then(
      () => { setBusy(false); onCreated(nm) },
      (e: unknown) => { setBusy(false); onSay(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 80)}`) },
    )
  }
  const field = (label: string, val: string, set: (v: string) => void, ph: string) => (
    <label>{label}
      <input value={val} placeholder={ph}
        onChange={(e: ChangeEvent<HTMLInputElement>) => set(e.target.value)}
        onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter') submit() }} />
    </label>
  )
  return (
    <div className="vp-modal">
      <div className="vp-backdrop" onClick={onClose} />
      <div className="vp-mbox" style={{ maxWidth: 480 }}>
        <div className="vp-mh">新建条目<button className="vp-x" onClick={onClose}><Glyph n="x" s={13} /></button></div>
        <div className="vp-mb">
          <div className="vp-form">
            {field('名称 *（用 / 分组，如 服务/微信支付）', name, setName, '服务/新服务')}
            {field('URL', url, setUrl, 'https://…')}
            {field('用户名', username, setUsername, 'zhangsan')}
            {field('备注', note, setNote, '用途 / 申请流程 / 注意事项')}
            <div className="vp-hint">密码会自动生成 24 位随机值（不显示）；建好后在详情里点复制。服务凭证类（AppID/AppKey）建好后用“添加字段”补充。</div>
          </div>
        </div>
        <div className="vp-mf">
          <button className="vp-btn" onClick={onClose}>取消</button>
          <button className="vp-btn vp-btn-pri" disabled={!name.trim() || busy} onClick={submit}>{busy ? '创建中…' : '创建'}</button>
        </div>
      </div>
    </div>
  )
}

function AuditModal({ onClose }: { onClose: () => void }) {
  const [txt, setTxt] = useState('审计运行中…')
  useEffect(() => {
    api<{ report: string }>('audit').then(
      (r) => setTxt(r.report),
      (e: unknown) => setTxt(`⚠ ${String((e as Error | undefined)?.message ?? e)}`),
    )
  }, [])
  return (
    <div className="vp-modal">
      <div className="vp-backdrop" onClick={onClose} />
      <div className="vp-mbox">
        <div className="vp-mh"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Glyph n="shield" />安全审计</span>
          <button className="vp-x" onClick={onClose}><Glyph n="x" s={13} /></button></div>
        <div className="vp-mb"><pre className="vp-pre">{txt}</pre></div>
      </div>
    </div>
  )
}

/* ---------- panel ---------- */

export function VaultPanel() {
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState('')
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [stamp, setStamp] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const toastTimer = useRef(0)

  const say = useCallback((m: string) => {
    setToast(m)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2200)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const refreshDirty = useCallback(() => {
    api<{ dirty: boolean }>('dirty').then((r) => setDirty(r.dirty), () => {})
  }, [])

  const load = useCallback(() => {
    setErr('')
    api<VaultMeta>('meta').then(
      (d) => {
        setMeta(d && typeof d === 'object' ? d : {})
        try { setStamp(new Date().toLocaleTimeString('zh-CN', { hour12: false })) } catch { /* ignore */ }
        refreshDirty()
      },
      (e: unknown) => setErr(String((e as Error | undefined)?.message ?? e)),
    )
  }, [refreshDirty])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (sel !== '' && meta !== null && meta[sel] === undefined) setSel('')
  }, [meta, sel])

  const onCopy = useCallback((text: string, label: string) => {
    void copyText(text).then((ok) => say(ok ? `✓ 已复制 ${label}` : '复制失败'))
  }, [say])

  const onReveal = useCallback((n: string, f: string) => {
    const k = `${n}\u0000${f}`
    api<{ value: string }>('reveal', { name: n, field: f }).then(
      (r) => setSecrets((p) => ({ ...p, [k]: r.value })),
      (e: unknown) => setSecrets((p) => ({ ...p, [k]: `⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 50)}` })),
    )
  }, [])

  const onHide = useCallback((n: string, f: string) => {
    setSecrets((p) => { const x = { ...p }; delete x[`${n}\u0000${f}`]; return x })
  }, [])

  const onQuickCopy = useCallback((n: string, f: string) => {
    api<{ value: string }>('reveal', { name: n, field: f }).then(
      (r) => { void copyText(r.value).then((ok) => say(ok ? `✓ 已复制 ${n} 的 ${f}（未显示）` : '复制失败')) },
      (e: unknown) => say(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 60)}`),
    )
  }, [say])

  const onSave = useCallback((n: string, f: string, v: string, done: () => void) => {
    api<{ saved: string }>('set', { name: n, field: f, value: v }).then(
      () => { onHide(n, f); done(); say(`✓ 已保存 ${n} · ${f}`); load() },
      (e: unknown) => say(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 70)}`),
    )
  }, [onHide, say, load])

  const onDeleteField = useCallback((n: string, f: string) => {
    api<{ removed: string }>('rm', { name: n, field: f }).then(
      () => { onHide(n, f); say(`已删除字段 ${f}`); load() },
      (e: unknown) => say(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 70)}`),
    )
  }, [onHide, say, load])

  const onDeleteEntry = useCallback((n: string) => {
    api<{ removed: string }>('rm', { name: n }).then(
      () => { setSel(''); say(`已删除 ${n}`); load() },
      (e: unknown) => say(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 70)}`),
    )
  }, [say, load])

  const commit = useCallback(() => {
    api<{ msg: string }>('save', { msg: `面板改动 ${stamp}` }).then(
      () => { setDirty(false); say('✓ 已提交到 git') },
      (e: unknown) => say(`⚠ ${String((e as Error | undefined)?.message ?? e).slice(0, 70)}`),
    )
  }, [say, stamp])

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (auditOpen) { setAuditOpen(false); return }
      if (newOpen) { setNewOpen(false); return }
      if (sel !== '') { setSel(''); return }
      if (q !== '') { setQ(''); return }
    }
    const t = (e.target as HTMLElement | null)?.tagName ?? ''
    if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'k')) && t !== 'INPUT' && t !== 'TEXTAREA') {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }

  let body: ReactNode
  if (err !== '') {
    body = (
      <div className="vp-body">
        <div className="vp-err">加载失败：{err}</div>
        <button className="vp-btn" onClick={load}><Glyph n="refresh" s={12} />重试</button>
      </div>
    )
  } else if (meta === null) {
    body = (
      <div className="vp-body">
        <div className="vp-grid">{[0, 1, 2, 3, 4, 5].map((i) => <div className="vp-skel" key={i} style={{ animationDelay: `${String(i * 0.08)}s` }} />)}</div>
      </div>
    )
  } else {
    const ql = q.trim().toLowerCase()
    const visible = Object.keys(meta).filter((n) => matchEntry(meta[n]!, n, ql))
    const row = (n: string) => {
      const fs = meta[n]!
      const short = shortName(n)
      const urlv = fs.url && !fs.url.enc ? String(fs.url.value ?? '') : ''
      const envv = fs.env && !fs.env.enc ? String(fs.env.value ?? '') : ''
      const enc = encCount(fs)
      return (
        <div key={n} className={`vp-row${sel === n ? ' vp-sel' : ''}`} role="button" tabIndex={0}
          onClick={() => setSel(n)}
          onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(n) } }}>
          <div className="vp-av" style={{ background: `hsl(${String(hueOf(n))},52%,42%)` }}>{short.slice(0, 1).toUpperCase()}</div>
          <div className="vp-row-main">
            <div className="vp-row-name" title={n}>{short}</div>
            {entrySubline(fs) ? <div className="vp-row-sub">{entrySubline(fs)}</div> : null}
          </div>
          <div className="vp-row-right">
            {envv ? <span className="vp-chip">{envv}</span> : null}
            {enc > 0 ? <span className="vp-lock" title={`${String(enc)} 个加密字段`}><Glyph n="key" s={10} />{enc}</span> : null}
            {fs.password && fs.password.enc ? (
              <button className="vp-icobtn" title="复制密码（不显示）"
                onClick={(e) => { e.stopPropagation(); onQuickCopy(n, 'password') }}><Glyph n="copy" s={12} /></button>
            ) : null}
            {urlv ? (
              <a className="vp-icobtn" title="打开链接" href={urlv} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}><Glyph n="ext" s={12} /></a>
            ) : null}
          </div>
        </div>
      )
    }
    body = (
      <div className="vp-body">
        <div className="vp-sub">加密值只在你点击时才从 Host 取回；模型侧只能读到结构，拿不到明文。数据源 ~/Vault（sops+age+git）。快捷键：/ 搜索 · Esc 返回</div>
        {groupEntries(meta, visible).map(([g, names]) => (
          <div key={g}>
            <button className="vp-gh" onClick={() => setCollapsed((p) => ({ ...p, [g]: !p[g] }))}>
              <span className={`vp-chev${collapsed[g] === true ? ' vp-chev-c' : ''}`}><Glyph n="chev" s={13} /></span>
              {g} · {names.length} 条
            </button>
            {collapsed[g] === true ? null : <div className="vp-grid">{names.map(row)}</div>}
          </div>
        ))}
        {visible.length === 0 ? (
          <div className="vp-empty">{ql !== '' ? `没有匹配“${q}”的记录` : '库是空的，点右上“新建”添加第一条'}</div>
        ) : null}
      </div>
    )
  }

  const totalEnc = meta === null ? 0 : Object.values(meta).reduce((acc, fs) => acc + encCount(fs), 0)
  const total = meta === null ? 0 : Object.keys(meta).length

  return (
    <div className="vp-root" onKeyDown={onKey} tabIndex={-1}>
      <div className="vp-top">
        <span className="vp-title"><Glyph n="shield" s={15} />Vault
          {meta !== null ? <span className="vp-count">{total} 条 · {totalEnc} 个加密字段{stamp !== '' ? ` · ${stamp}` : ''}</span> : null}
        </span>
        <div className="vp-search">
          <Glyph n="search" s={13} />
          <input ref={searchRef} className="vp-input" type="search" placeholder="搜索系统 / 字段 / 值…（按 / 聚焦）"
            value={q} onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)} />
        </div>
        {dirty ? <span className="vp-dot" title="有未提交改动" /> : null}
        {dirty ? <button className="vp-btn vp-btn-pri" onClick={commit}><Glyph n="check" s={12} />提交</button> : null}
        <button className="vp-btn" title="重新读取" onClick={load}><Glyph n="refresh" s={12} /></button>
        <button className="vp-btn" onClick={() => setAuditOpen(true)}><Glyph n="shield" s={12} />审计</button>
        <button className="vp-btn vp-btn-pri" onClick={() => setNewOpen(true)}><Glyph n="plus" s={12} />新建</button>
      </div>
      {body}
      {sel !== '' && meta !== null && meta[sel] !== undefined ? <div className="vp-backdrop" onClick={() => setSel('')} /> : null}
      {sel !== '' && meta !== null && meta[sel] !== undefined ? (
        <Drawer name={sel} fields={meta[sel]!} secrets={secrets}
          onReveal={onReveal} onHide={onHide} onCopy={onCopy} onQuickCopy={onQuickCopy}
          onSave={onSave} onDeleteField={onDeleteField} onDeleteEntry={onDeleteEntry}
          onClose={() => setSel('')} />
      ) : null}
      {auditOpen ? <AuditModal onClose={() => setAuditOpen(false)} /> : null}
      {newOpen ? (
        <NewModal onClose={() => setNewOpen(false)} onSay={say}
          onCreated={(nm) => { setNewOpen(false); say(`✓ 已创建 ${nm}（密码已随机生成）`); load(); setSel(nm) }} />
      ) : null}
      {toast !== '' ? <div className="vp-toast">{toast}</div> : null}
    </div>
  )
}
