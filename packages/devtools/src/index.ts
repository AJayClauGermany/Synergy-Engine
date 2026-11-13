// Synergy devtools: the counterpart of Unity's UnityEditor namespace. Only development
// builds load it (game/src/main.tsx imports it behind a check that a release build
// removes, along with this whole package). Nothing here is needed to run the game.
export { attachEditor, startLogCapture, type AttachEditorOptions, type EditorHandle } from './attach';
export { EditorApplication, PauseState } from './EditorApplication';
export { EditorPrefs } from './EditorPrefs';
export { Selection } from './Selection';
export {
  LogCapture,
  formatEntry,
  formatArguments,
  formatValue,
  type LogEntry,
  type LogLevel,
  type LogCaptureOptions,
} from './logs';
export { buildReport, type Report } from './report';
