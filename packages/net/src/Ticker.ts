import type { Session } from './Session';

/**
 * A shared world clock for games where everyone acts at once (real-time strategy,
 * simultaneous turns, cooldown-based actions).
 *
 * The host submits a "tick" command at a fixed interval. Because ticks travel through
 * the same ordered stream as every other command, all players see each action land
 * between the same two ticks, and a deterministic `apply` stays in sync:
 *
 *   const stop = startTicker(session, 2000, { type: 'tick' });
 *
 *   function apply(state, command) {
 *     if (command.type === 'tick') return advanceWorld(state);   // cooldowns, income, ...
 *     ...
 *   }
 *
 * Measure game time in ticks held in the state (`state.tick`), never with a local
 * clock: a cooldown is "ready at tick 12", not "ready in 4 seconds".
 *
 * Only the host's machine actually sends ticks; calling this on every player is fine.
 * If the host leaves, the clock stops with the session. Returns a function that stops it.
 */
export function startTicker<C>(
  session: Session<C>,
  intervalMs: number,
  // NoInfer: the command type comes from the session, so a literal like { type: 'tick' } is checked against it.
  tick: NoInfer<C>,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !session.isHost) return;
    try {
      session.submit(tick);
    } catch {
      // The session has closed.
      stop();
    }
  }, intervalMs);
  const off = session.onClosed.add(() => stop());
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    off();
  }
  return stop;
}
