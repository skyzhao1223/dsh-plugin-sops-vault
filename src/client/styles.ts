/**
 * Package-owned stylesheet. Injected once on client apply as
 * `<style data-plugin="dsh-plugin-sops-vault">` and removed with the plugin fiber.
 * Colors ride DSH theme tokens with dark fallbacks so the panel follows the
 * host theme in light and dark mode.
 *
 * @module dsh-plugin-sops-vault/client/styles
 */

export const CSS = [
  '.vp-root{position:relative;height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#0f1115);color:var(--dsw-alias-label-primary,#e8eaf0);overflow:hidden}',
  '.vp-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#262c3a)}',
  '.vp-title{font-size:15px;font-weight:700;display:flex;align-items:center;gap:7px;white-space:nowrap}',
  '.vp-count{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0);font-weight:400}',
  '.vp-search{flex:1;min-width:170px;max-width:400px;position:relative}',
  '.vp-search>svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--dsw-alias-label-secondary,#98a0b0);pointer-events:none}',
  '.vp-input{width:100%;background:var(--dsw-alias-bg-layer-1,#181c26);border:1px solid var(--dsw-alias-border-l1,#262c3a);color:inherit;border-radius:9px;padding:7px 10px 7px 30px;font-size:13px;outline:none;transition:border-color .15s}',
  '.vp-input:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-btn{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-1,#181c26);border:1px solid var(--dsw-alias-border-l1,#262c3a);color:inherit;border-radius:9px;padding:6px 11px;font-size:12.5px;cursor:pointer;transition:border-color .15s,transform .1s;white-space:nowrap}',
  '.vp-btn:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-btn:active{transform:scale(.97)}',
  '.vp-btn:disabled{opacity:.45;cursor:default;transform:none}',
  '.vp-btn-pri{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}',
  '.vp-btn-pri:hover{filter:brightness(1.1);border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-btn-danger{color:var(--dsw-alias-state-error-primary,#ff5c5c)}',
  '.vp-btn-danger:hover{border-color:var(--dsw-alias-state-error-primary,#ff5c5c)}',
  '.vp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f5a623);display:inline-block;flex-shrink:0}',
  '.vp-body{flex:1;overflow:auto;padding:4px 20px 70px}',
  '.vp-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0);padding:9px 2px 2px;line-height:1.5;max-width:920px}',
  '.vp-gh{display:flex;align-items:center;gap:6px;margin:17px 2px 9px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#98a0b0);cursor:pointer;user-select:none;background:none;border:none;padding:0}',
  '.vp-gh:hover{color:var(--dsw-alias-label-primary,#e8eaf0)}',
  '.vp-chev{transition:transform .18s;display:inline-flex}',
  '.vp-chev-c{transform:rotate(-90deg)}',
  '.vp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:9px}',
  '.vp-row{display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-layer-1,#181c26);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:11px;padding:9px 12px;cursor:pointer;transition:border-color .15s,transform .12s;text-align:left}',
  '.vp-row:hover{border-color:var(--dsw-alias-border-l2,#394152);transform:translateY(-1px)}',
  '.vp-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
  '.vp-sel{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-av{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;flex-shrink:0}',
  '.vp-row-main{flex:1;min-width:0}',
  '.vp-row-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vp-row-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#98a0b0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vp-row-right{display:flex;align-items:center;gap:5px;flex-shrink:0}',
  '.vp-chip{font-size:10px;color:var(--dsw-alias-label-secondary,#98a0b0);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:20px;padding:1px 7px;white-space:nowrap}',
  '.vp-lock{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#98a0b0)}',
  '.vp-icobtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#98a0b0);cursor:pointer;opacity:0;transition:opacity .12s,color .12s,border-color .12s;padding:0;flex-shrink:0}',
  '.vp-row:hover .vp-icobtn,.vp-icobtn:focus-visible{opacity:1}',
  '.vp-icobtn:hover{color:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-border-l1,#262c3a)}',
  'a.vp-icobtn{text-decoration:none}',
  '.vp-backdrop{position:absolute;inset:0;background:rgba(5,8,14,.45);z-index:20;animation:vp-fade .16s ease}',
  '.vp-drawer{position:absolute;top:0;right:0;bottom:0;width:430px;max-width:94%;background:var(--dsw-alias-bg-layer-1,#181c26);border-left:1px solid var(--dsw-alias-border-l1,#262c3a);z-index:21;display:flex;flex-direction:column;animation:vp-slide .22s cubic-bezier(.2,.7,.3,1);box-shadow:-12px 0 32px rgba(0,0,0,.28)}',
  '@keyframes vp-slide{from{transform:translateX(26px);opacity:.4}to{transform:none;opacity:1}}',
  '@keyframes vp-fade{from{opacity:0}to{opacity:1}}',
  '.vp-dh{display:flex;align-items:flex-start;gap:10px;padding:15px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#262c3a)}',
  '.vp-dtitle{flex:1;min-width:0}',
  '.vp-dname{font-size:15px;font-weight:700;word-break:break-all;line-height:1.35}',
  '.vp-dchips{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}',
  '.vp-x{width:28px;height:28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#262c3a);background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0}',
  '.vp-x:hover{border-color:var(--dsw-alias-state-error-primary,#ff5c5c);color:var(--dsw-alias-state-error-primary,#ff5c5c)}',
  '.vp-db{flex:1;overflow:auto;padding:13px 16px 22px}',
  '.vp-acts{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:6px}',
  '.vp-sec{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0);margin:15px 0 6px;font-weight:600;letter-spacing:.4px}',
  '.vp-f{display:flex;align-items:center;gap:7px;min-height:31px;padding:2px 0}',
  '.vp-k{font-size:11.5px;color:var(--dsw-alias-label-secondary,#98a0b0);width:92px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}',
  '.vp-v{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2,#11141c);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:7px;padding:4px 9px;word-break:break-all;flex:1;min-width:0;line-height:1.5}',
  '.vp-vclick{cursor:pointer;transition:border-color .12s}',
  '.vp-vclick:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-mask{color:var(--dsw-alias-label-secondary,#98a0b0);letter-spacing:2px;cursor:pointer}',
  '.vp-a{color:var(--dsw-alias-brand-primary,#4c8dff);text-decoration:none}',
  '.vp-a:hover{text-decoration:underline}',
  '.vp-facts{display:flex;gap:2px;flex-shrink:0}',
  '.vp-facts .vp-icobtn{opacity:.55}',
  '.vp-facts .vp-icobtn:hover{opacity:1}',
  '.vp-edit-in{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2,#11141c);border:1px solid var(--dsw-alias-brand-primary,#4c8dff);border-radius:7px;padding:4px 9px;color:inherit;font-family:ui-monospace,Menlo,monospace;font-size:12px;outline:none}',
  '.vp-totp{display:flex;align-items:center;gap:13px;background:var(--dsw-alias-bg-layer-2,#11141c);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:12px;padding:11px 14px;margin:4px 0 2px}',
  '.vp-totp-code{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:23px;letter-spacing:4px;color:var(--dsw-alias-brand-primary,#4c8dff);cursor:pointer}',
  '.vp-totp-left{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0);margin-left:auto}',
  '.vp-note{margin-top:13px;font-size:12px;color:var(--dsw-alias-label-secondary,#98a0b0);background:var(--dsw-alias-bg-layer-2,#11141c);border-radius:9px;padding:9px 11px;line-height:1.55;white-space:pre-wrap}',
  '.vp-addf{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;align-items:center}',
  '.vp-addf input{background:var(--dsw-alias-bg-layer-2,#11141c);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:7px;padding:5px 8px;color:inherit;font-size:12px;outline:none;width:110px}',
  '.vp-addf input:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-addf input.vp-wide{width:140px}',
  '.vp-danger{margin-top:20px;padding-top:13px;border-top:1px dashed var(--dsw-alias-border-l1,#262c3a);display:flex;align-items:center;justify-content:space-between;gap:8px}',
  '.vp-dhint{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0)}',
  '.vp-modal{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:24px}',
  '.vp-mbox{background:var(--dsw-alias-bg-layer-1,#181c26);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:14px;max-width:640px;width:100%;max-height:84%;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.4);animation:vp-fade .15s ease;position:relative;z-index:31}',
  '.vp-mh{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#262c3a);font-weight:700;font-size:14px}',
  '.vp-mb{overflow:auto;padding:15px 16px}',
  '.vp-pre{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.65;margin:0}',
  '.vp-form{display:flex;flex-direction:column;gap:11px}',
  '.vp-form label{font-size:12px;color:var(--dsw-alias-label-secondary,#98a0b0);display:flex;flex-direction:column;gap:5px}',
  '.vp-form input{background:var(--dsw-alias-bg-layer-2,#11141c);border:1px solid var(--dsw-alias-border-l1,#262c3a);border-radius:8px;padding:8px 10px;color:inherit;font-size:13px;outline:none}',
  '.vp-form input:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.vp-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0b0);line-height:1.5}',
  '.vp-mf{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,#262c3a)}',
  '.vp-toast{position:absolute;bottom:18px;right:18px;z-index:40;background:var(--dsw-alias-bg-overlay,#232838);border:1px solid var(--dsw-alias-border-l2,#394152);color:var(--dsw-alias-label-primary,#e8eaf0);padding:9px 15px;border-radius:11px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.35);animation:vp-fade .15s ease;max-width:72%}',
  '.vp-skel{height:52px;border-radius:11px;background:linear-gradient(100deg,var(--dsw-alias-bg-layer-1,#181c26) 40%,var(--dsw-alias-bg-layer-2,#232838) 50%,var(--dsw-alias-bg-layer-1,#181c26) 60%);background-size:200% 100%;animation:vp-shim 1.3s infinite}',
  '@keyframes vp-shim{from{background-position:200% 0}to{background-position:-200% 0}}',
  '.vp-empty{padding:52px 20px;text-align:center;color:var(--dsw-alias-label-secondary,#98a0b0);font-size:13px}',
  '.vp-err{color:var(--dsw-alias-state-error-primary,#ff5c5c);font-size:13px;margin:14px 2px;line-height:1.6}',
].join('\n')

/**
 * Insert the package stylesheet once; idempotent under re-evaluation.
 * @returns disposer removing the style tag.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const id = 'dsh-plugin-sops-vault'
  if (document.querySelector(`style[data-plugin="${id}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset['plugin'] = id
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
