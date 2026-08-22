const STYLE_ID = 'dsh-client-ui-agent-swarm/panel'

const CSS = `
.dsh-swarm{width:100%;min-width:0;color:var(--dsw-alias-label-secondary)}
.dsh-swarm__header{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-swarm__header:focus-visible,.dsh-swarm button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-swarm__title{overflow:hidden;flex:1;min-width:0;font-size:14px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsh-swarm__progress,.dsh-swarm__status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-swarm__status{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary)}
.dsh-swarm__warning{margin:8px 0 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-state-warn-tertiary);font-size:12px}
.dsh-swarm__body{display:grid;grid-template-columns:minmax(180px,42%) minmax(0,1fr);gap:12px;padding:10px 4px 2px}
.dsh-swarm__tree,.dsh-swarm__details{min-width:0}
.dsh-swarm__tree{overflow:auto;max-height:440px;padding-right:4px;border-right:1px solid var(--dsw-alias-border-subtle)}
.dsh-swarm__tree-row{display:flex;align-items:center;gap:4px;min-width:0;min-height:28px;padding-left:calc(var(--dsh-swarm-level) * 14px)}
.dsh-swarm__branch{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-swarm__branch-spacer{flex:none;width:22px}
.dsh-swarm__task{display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;min-width:0;padding:3px 5px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-swarm__task[aria-current=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-state-business-primary)}
.dsh-swarm__task-label{overflow:hidden;flex:1;min-width:0;font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.dsh-swarm__task-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-swarm__group{margin:8px 0 4px;padding:0 5px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;text-transform:uppercase}
.dsh-swarm__details{padding:0 8px;overflow-wrap:anywhere}
.dsh-swarm__details h3{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:15px}
.dsh-swarm__details h4{margin:12px 0 5px;font-size:12px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsh-swarm__meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 8px;margin:0;font-size:12px}
.dsh-swarm__meta dt{color:var(--dsw-alias-label-tertiary)}
.dsh-swarm__meta dd{margin:0}
.dsh-swarm__list{margin:4px 0;padding-left:18px;font-size:12px}
.dsh-swarm__attempt{margin-top:7px;padding:7px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);font-size:12px}
.dsh-swarm__timeline{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;font-size:12px}
.dsh-swarm__timeline time{margin-right:6px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-swarm__open{margin-top:10px;padding:6px 10px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer}
.dsh-swarm__open:disabled{border-color:var(--dsw-alias-border-subtle);color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.dsh-swarm__empty{padding:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
@media(max-width:640px){.dsh-swarm__body{grid-template-columns:1fr}.dsh-swarm__tree{max-height:260px;padding:0 0 8px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-subtle)}.dsh-swarm__details{padding:0}}
`

export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-client-ui-agent-swarm'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
