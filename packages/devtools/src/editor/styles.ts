/** The editor's stylesheet: Unity's dark theme, scoped under `.synergy-editor`; the feedback picker's under `.synergy-feedback`. */
export const EDITOR_STYLE = `
.synergy-editor {
  --ed-bg: #191919; --ed-panel: #282828; --ed-header: #3c3c3c; --ed-tab: #383838;
  --ed-field: #2a2a2a; --ed-field-edge: #1d1d1d; --ed-row: #303030; --ed-line: #232323;
  --ed-text: #d2d2d2; --ed-dim: #8a8a8a; --ed-select: #2c5d87; --ed-hover: #3a3a3a;
  --ed-warn: #f4bc02; --ed-error: #ff5a52; --ed-accent: #4c7fbf;
  position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
  display: grid; grid-template-columns: 260px minmax(0, 1fr) 330px;
  grid-template-rows: 32px minmax(0, 1fr) 230px;
  grid-template-areas: 'toolbar toolbar toolbar' 'hierarchy game inspector' 'console console inspector';
  font: 12px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ed-text);
}
.synergy-editor * { box-sizing: border-box; }
.synergy-editor .ed-panel, .synergy-editor .ed-toolbar { pointer-events: auto; background: var(--ed-panel); }
.synergy-editor .ed-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; border: 1px solid var(--ed-bg); }
.synergy-editor .ed-tabs { display: flex; align-items: stretch; height: 24px; background: var(--ed-header); border-bottom: 1px solid var(--ed-bg); flex: none; }
.synergy-editor .ed-tab { padding: 3px 10px; background: var(--ed-panel); border-right: 1px solid var(--ed-bg); font-weight: 600; }
.synergy-editor .ed-tabs .ed-spacer { flex: 1; }
.synergy-editor .ed-tabs label, .synergy-editor .ed-tabs .ed-stat { display: flex; align-items: center; gap: 4px; padding: 0 8px; color: var(--ed-dim); }
.synergy-editor .ed-scroll { overflow: auto; flex: 1; min-height: 0; }
.synergy-editor .ed-game { grid-area: game; pointer-events: none; background: transparent; border: 1px solid var(--ed-bg); display: flex; flex-direction: column; }
.synergy-editor .ed-game .ed-tabs { pointer-events: auto; }
.synergy-editor .ed-game-view { flex: 1; }
.synergy-editor button, .synergy-editor input, .synergy-editor select, .synergy-editor textarea {
  font: inherit; color: var(--ed-text); background: var(--ed-field); border: 1px solid var(--ed-field-edge);
  border-radius: 3px; padding: 1px 6px; min-height: 20px; margin: 0;
}
.synergy-editor button { background: #4a4a4a; border-color: #303030; cursor: pointer; padding: 1px 8px; }
.synergy-editor button:hover { background: #575757; }
.synergy-editor button.ed-on { background: #46607c; border-color: #2c5d87; }
.synergy-editor input[type='checkbox'] { width: 13px; height: 13px; min-height: 0; padding: 0; flex: none; accent-color: var(--ed-accent); margin: 0; }
.synergy-editor input[type='color'] { width: 48px; padding: 0 2px; }
.synergy-editor .ed-header input[type='text'] { width: 100%; }
.synergy-editor input:focus, .synergy-editor textarea:focus { outline: 1px solid var(--ed-accent); }

.synergy-editor .ed-toolbar { grid-area: toolbar; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 8px; gap: 8px; background: var(--ed-header); border-bottom: 1px solid var(--ed-bg); }
.synergy-editor .ed-toolbar > div { display: flex; align-items: center; gap: 6px; min-width: 0; }
.synergy-editor .ed-toolbar > div:last-child { justify-content: flex-end; }
.synergy-editor .ed-title { font-weight: 700; white-space: nowrap; }
.synergy-editor .ed-play { display: flex; gap: 1px; }
.synergy-editor .ed-play button { width: 32px; padding: 0; font-size: 13px; border-radius: 0; }
.synergy-editor .ed-play button:first-child { border-radius: 3px 0 0 3px; }
.synergy-editor .ed-play button:last-child { border-radius: 0 3px 3px 0; }
.synergy-editor .ed-note { width: 220px; }
.synergy-editor .ed-dim { color: var(--ed-dim); }

.synergy-editor .ed-hierarchy { grid-area: hierarchy; }
.synergy-editor .ed-search { margin: 4px; width: calc(100% - 8px); }
.synergy-editor .ed-node { display: flex; align-items: center; height: 20px; white-space: nowrap; cursor: default; padding-right: 6px; }
.synergy-editor .ed-node:hover { background: var(--ed-hover); }
.synergy-editor .ed-node.ed-selected { background: var(--ed-select); }
.synergy-editor .ed-node.ed-inactive { color: var(--ed-dim); }
.synergy-editor .ed-node.ed-scene { background: var(--ed-header); font-weight: 600; }
.synergy-editor .ed-arrow { width: 14px; flex: none; text-align: center; color: var(--ed-dim); font-size: 9px; cursor: pointer; }

.synergy-editor .ed-inspector { grid-area: inspector; }
.synergy-editor .ed-header { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid var(--ed-line); }
.synergy-editor .ed-header .ed-meta { grid-column: 1 / -1; display: flex; gap: 10px; color: var(--ed-dim); }
.synergy-editor .ed-component { border-bottom: 1px solid var(--ed-line); }
.synergy-editor .ed-component-title { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; background: var(--ed-row); font-weight: 600; cursor: pointer; }
.synergy-editor .ed-component-body { padding: 4px 8px 8px 22px; }
.synergy-editor .ed-field { display: grid; grid-template-columns: 40% 60%; align-items: center; min-height: 22px; }
.synergy-editor .ed-field > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; }
.synergy-editor .ed-field input:not([type='checkbox']):not([type='color']) { width: 100%; }
.synergy-editor .ed-vector { display: flex; gap: 4px; }
.synergy-editor .ed-vector label { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; }
.synergy-editor .ed-vector input { min-width: 0; padding: 1px 3px; }
.synergy-editor .ed-ref { display: block; width: 100%; text-align: left; background: var(--ed-field); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.synergy-editor .ed-readonly { color: var(--ed-dim); overflow-wrap: anywhere; }
.synergy-editor .ed-summary { color: var(--ed-dim); white-space: pre-wrap; }
.synergy-editor .ed-empty { padding: 12px; color: var(--ed-dim); }
.synergy-editor .ed-error-text { color: var(--ed-error); padding: 2px 0; }

.synergy-editor .ed-console { grid-area: console; }
.synergy-editor .ed-console .ed-tabs button { min-height: 0; height: 18px; margin: 3px 0 0 4px; padding: 0 6px; }
.synergy-editor .ed-console .ed-tabs input { min-height: 0; height: 18px; margin: 3px 4px 0; width: 160px; }
.synergy-editor .ed-console-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.synergy-editor .ed-entries { flex: 1; overflow: auto; min-height: 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.synergy-editor .ed-entry { display: flex; gap: 6px; padding: 2px 6px; border-bottom: 1px solid var(--ed-line); cursor: default; }
.synergy-editor .ed-entry:nth-child(even) { background: #2c2c2c; }
.synergy-editor .ed-entry.ed-selected { background: var(--ed-select); }
.synergy-editor .ed-entry .ed-icon { flex: none; width: 14px; }
.synergy-editor .ed-entry .ed-text { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 3.9em; overflow: hidden; }
.synergy-editor .ed-entry .ed-when { color: var(--ed-dim); flex: none; }
.synergy-editor .ed-entry .ed-count { flex: none; background: #555; border-radius: 8px; padding: 0 6px; }
.synergy-editor .ed-warn .ed-icon { color: var(--ed-warn); }
.synergy-editor .ed-error .ed-icon { color: var(--ed-error); }
.synergy-editor .ed-detail { height: 70px; flex: none; overflow: auto; border-top: 1px solid var(--ed-bg); padding: 4px 6px; white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; user-select: text; }

.synergy-editor-badge {
  position: fixed; left: 8px; bottom: 8px; z-index: 2147483000; display: flex; gap: 8px; align-items: center;
  font: 12px system-ui, sans-serif; color: #fff; background: rgba(140, 30, 30, 0.9); border-radius: 12px;
  padding: 3px 10px; cursor: pointer; border: 0;
}
.synergy-editor-toast {
  position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: 2147483001; pointer-events: none;
  font: 12px system-ui, sans-serif; color: #eee; background: rgba(30, 30, 30, 0.95); border: 1px solid #555;
  border-radius: 4px; padding: 6px 12px; max-width: 80vw;
}

.synergy-feedback { font: 12px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #e6e6e6; }
.synergy-feedback * { box-sizing: border-box; }
.synergy-feedback .fb-shield { position: fixed; inset: 0; z-index: 2147482990; cursor: crosshair; }
.synergy-feedback .fb-shield.fb-pointing { cursor: cell; }
.synergy-feedback .fb-outline, .synergy-feedback .fb-mark, .synergy-feedback .fb-expected, .synergy-feedback .fb-chip { position: fixed; z-index: 2147482995; pointer-events: none; }
.synergy-feedback .fb-outline { outline: 2px solid #ff7a1a; outline-offset: 2px; background: rgba(255, 122, 26, 0.12); }
.synergy-feedback .fb-mark { outline: 2px dashed #ff7a1a; outline-offset: 2px; }
.synergy-feedback .fb-mark.fb-dot { width: 18px; height: 18px; border-radius: 50%; }
.synergy-feedback .fb-mark span { position: absolute; left: -4px; top: -22px; background: #ff7a1a; color: #111; font-weight: 700; padding: 0 6px; border-radius: 3px; }
.synergy-feedback .fb-expected { width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid #2ee6a6; border-radius: 50%; background: radial-gradient(#2ee6a6 2px, transparent 3px); }
.synergy-feedback .fb-chip { background: rgba(20, 20, 20, 0.92); border: 1px solid #ff7a1a; border-radius: 3px; padding: 1px 6px; white-space: nowrap; max-width: 90vw; overflow: hidden; text-overflow: ellipsis; }
.synergy-feedback .fb-chip.fb-hint { left: 50%; top: 44px; transform: translateX(-50%); border-color: #2ee6a6; }
.synergy-feedback .fb-box, .synergy-feedback .fb-bar { position: fixed; z-index: 2147483002; background: #262626; border: 1px solid #555; border-radius: 6px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5); }
.synergy-feedback .fb-box { width: 340px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.synergy-feedback .fb-target { color: #ffb37a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.synergy-feedback .fb-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.synergy-feedback .fb-spacer { flex: 1; }
.synergy-feedback .fb-bar { left: 50%; bottom: 12px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; padding: 6px 10px; white-space: nowrap; }
.synergy-feedback .fb-bar.fb-top { bottom: auto; top: 12px; }
.synergy-feedback .fb-dim { color: #9a9a9a; }
.synergy-feedback textarea { width: 100%; resize: vertical; }
.synergy-feedback button, .synergy-feedback select, .synergy-feedback textarea {
  font: inherit; color: #e6e6e6; background: #1c1c1c; border: 1px solid #555; border-radius: 3px; padding: 2px 8px; margin: 0;
}
.synergy-feedback button { background: #4a4a4a; cursor: pointer; }
.synergy-feedback button:hover:not(:disabled) { background: #5a5a5a; }
.synergy-feedback button:disabled { opacity: 0.45; cursor: default; }
.synergy-feedback button.fb-primary { background: #b9540c; border-color: #ff7a1a; }
.synergy-feedback textarea:focus { outline: 1px solid #ff7a1a; }
`;
