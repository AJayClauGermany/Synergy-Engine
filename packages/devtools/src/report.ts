import { Debug, type Engine, SceneManager, ScreenCapture } from '@synergy/engine';
import { formatEntry, type LogCapture } from './logs';

/**
 * A report is everything someone needs to look at a problem without the game in front of
 * them: what the screen showed, what was logged, what was in the scene, and a note from
 * the person who saw it. The dev server writes one to `.reports/<time>/` and copies it to
 * `.reports/latest/`, so "look at .reports/latest" is the whole hand-over to an agent.
 */
export interface Report {
  /** The game view as a PNG data URL, or `null` when it could not be read. */
  readonly screenshot: string | null;
  /** Text files by name: `summary.md`, `log.txt`, `hierarchy.txt`, `hud.txt`. */
  readonly files: Readonly<Record<string, string>>;
}

/** The visible text of the HUD overlays, one block per overlay, for `hud.txt`. */
function hudText(): string {
  if (typeof document === 'undefined') return '';
  return [...document.querySelectorAll<HTMLElement>('.synergy-ui')]
    .map((root) => root.innerText.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function deviceType(engine: Engine): string {
  return engine.isHeadless ? 'headless' : String(engine.app.graphicsDevice.deviceType);
}

/** Builds a report from the running game. `note` is what the person saw, in their words. */
export async function buildReport(engine: Engine, logs: LogCapture, note = ''): Promise<Report> {
  const screenshot = await engine.run(() => ScreenCapture.captureScreenshotAsDataUrl());
  const hierarchy = engine.run(() => Debug.hierarchy());
  const hud = hudText();
  const counts = logs.counts;
  const time = engine.time;
  const scenes = engine.run(() => {
    const names: string[] = [];
    for (let i = 0; i < SceneManager.sceneCount; i++) names.push(SceneManager.getSceneAt(i).name);
    return names;
  });
  const problems = logs.entries.filter((entry) => entry.level === 'error' || entry.level === 'warn').slice(-15);
  const { width, height } = engine.canvasSize;

  const summary = [
    '# Synergy report',
    '',
    note.trim() ? `## Note\n\n${note.trim()}\n` : '_No note was written._\n',
    '## State',
    '',
    `- Page: ${typeof location === 'undefined' ? '(none)' : location.href}`,
    `- Scenes: ${scenes.join(', ') || '(none)'} (active: ${engine.run(() => SceneManager.getActiveScene().name)})`,
    `- Frame ${time.frameCount}, game time ${time.time.toFixed(2)} s, time scale ${time.timeScale}` +
      `${engine.isRunning ? '' : ' (paused)'}`,
    `- View ${width}x${height}, renderer ${deviceType(engine)}`,
    `- Log: ${counts.error} errors, ${counts.warn} warnings, ${counts.log + counts.info + counts.debug} other`,
    '',
    '## Files',
    '',
    `- \`screenshot.png\`: the game view${screenshot ? '' : ' (could not be read this time)'}; the HUD is not in it`,
    '- `log.txt`: every console message and uncaught error since the page loaded',
    '- `hierarchy.txt`: every GameObject with its components, position and script fields',
    `- \`hud.txt\`: the text the HUD showed${hud ? '' : ' (empty: no HUD was mounted)'}`,
    '',
    '## Latest errors and warnings',
    '',
    problems.length > 0 ? ['```', ...problems.map(formatEntry), '```'].join('\n') : '_None._',
    '',
  ];
  return {
    screenshot,
    files: {
      'summary.md': summary.join('\n'),
      'log.txt': logs.text(),
      'hierarchy.txt': hierarchy,
      'hud.txt': hud,
    },
  };
}
