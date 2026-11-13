---
name: save-load
description: >
  Saves and restores a game on this engine: what to put in a save, a version number and
  migrations so old saves still load, where the file lives in a browser and in the
  desktop app, autosave, and replays from the command log. Use when asked for save and
  load, a continue button, save slots, autosave, settings that persist, or a save that
  breaks after an update. Not for the content files a game ships with (use `tile-maps`
  and `docs/content.md`), or for state shared between players during a match (use
  `multiplayer` or `netcode`).
---

# Save and load

A save is the game's state written down as plain data, in a form that survives a reload,
a crash halfway through writing, and the next version of the game. The engine has no
save API on purpose: with the state kept the way this template keeps it, a save is a few
lines, and what matters is the discipline around them.

## Workflow

1. **Find the state.** In a command game it is one object (`GameController.state`, of
   the type in `game/src/rules/`), already plain data: that object is the save. With
   netcode the host gathers it from its `NetworkVariable`s. If the state is spread over
   fields of behaviours, gather it into one plain object first; that is most of the work.
2. **Save data, never objects.** Ids, numbers, strings, flags, the random seed. No
   GameObjects, components, `Vector3`s, Maps or class instances: they do not survive
   `JSON.stringify` (see Gotchas). A unit's type is saved as its id and looked up in the
   `Catalog` again on load.
3. **Stamp a version from the first save you ever write**, and bump it whenever the
   shape of the state changes.
4. **Load defensively**: parse, read the version, refuse a newer one, migrate an older
   one step by step, check it, and only then use it. A save is a file a player can edit.
5. **Rebuild the scene from the loaded state** the same way it is built for a new game:
   one path, so a loaded game cannot differ from a played one.
6. **Autosave at a boundary** (end of turn, scene change), into its own slot, never over
   a slot the player chose.
7. **Verify** with a round-trip test (below).

## Patterns

Pure functions, beside the rules, so a test needs no browser:

```ts
import type { GameState } from './skirmish';

/** Bump when the shape of GameState changes, and add a migration from the old number. */
export const SAVE_VERSION = 2;

type Saved = Record<string, unknown>;

/** One entry per old version: turns that version's file into the next one's. Keep them all. */
const MIGRATIONS: Record<number, (saved: Saved) => Saved> = {
  // Version 1 had no turn counter.
  1: (saved) => ({ ...saved, state: { turnNumber: 1, ...(saved.state as object) } }),
};

export function toSave(state: GameState): string {
  return JSON.stringify({ version: SAVE_VERSION, state });
}

/** The state in a save. Throws, with a sentence for the player, when it cannot be used. */
export function fromSave(text: string): GameState {
  let saved = JSON.parse(text) as Saved;
  let version = typeof saved.version === 'number' ? saved.version : 1;
  if (version > SAVE_VERSION) throw new Error('This save is from a newer version of the game.');
  for (; version < SAVE_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`This save is too old to load (version ${version}).`);
    saved = { ...migrate(saved), version: version + 1 };
  }
  return checked(saved.state);
}
```

`checked` is yours: it confirms the parts the game relies on (the units are an array,
every unit's type id is in the `Catalog`, a cell is inside the map) and throws a sentence
otherwise. Without it a hand-edited save fails later, somewhere unrelated.

Where the text goes. Browser storage is per site, so prefix the key with the game's name:

```ts
const KEY = 'my-game.save.';

export function writeSlot(slot: string, text: string): boolean {
  try {
    localStorage.setItem(KEY + slot, text);
    return true;
  } catch {
    return false;   // storage is full or switched off: tell the player, do not pretend
  }
}

export function readSlot(slot: string): string | null {
  try {
    return localStorage.getItem(KEY + slot);
  } catch {
    return null;
  }
}
```

`localStorage` holds a few megabytes and is cleared with the browser's site data. For a
save that must not be lost, also offer a file: download the same text, and load it back
through a file input. The desktop build keeps `localStorage` between runs; a real file in
the user's folder is a job for the desktop shell (`docs/desktop.md`).

**Replays and "undo".** A command game has a second, exact form of save: the list of
commands (`session.log`) plus the seed. Applying the log to a fresh state rebuilds the
game move by move, which gives replays, undo (apply all but the last) and a bug report
that reproduces. Keep the plain state save as well: a log is only valid for the rules
that wrote it, and rules change.

## Gotchas

- **A `Vector3`, a `Map`, a `Set` or any class instance in the state** comes back from
  JSON as a plain object without its methods, an empty `{}`, or not at all, and nothing
  complains until `position.add` is not a function. State holds `{ x, y }`, arrays and
  records; build a `Vector3` where it is used.
- **`undefined`, `NaN` and `Infinity` do not survive JSON**: a key set to `undefined`
  disappears, `NaN` and `Infinity` become `null`. Use `null` for "nothing", and a named
  constant for "cannot enter" costs rather than `Infinity` in the state.
- **No version number**, and the first update turns every existing save into guesswork.
  Version 1 is the file with no version in it; say so in the loader, as above.
- **A migration was deleted** "because nobody has saves that old". Someone does. Each one
  is a few lines; keep them.
- **Saving a reference to content** (a whole unit type copied into the state). The save
  now disagrees with the game's data after a balance patch. Save the id.
- **Saving inside `apply()` or in a `NetworkVariable` callback.** Rules must not touch
  storage, and a callback fires many times per change. Save from the view, at a boundary.
- **`localStorage` throws** in a private window, when the quota is full, or when the
  site's storage is blocked, and it does not exist in a headless test. Wrap every call,
  and keep the pure part (`toSave`, `fromSave`) free of it.
- **A save from one player loaded into an online match.** A local file is under the
  player's control; the host's state is the authority. Never let a client's save decide
  shared state.
- **Loading builds the scene a second way**, and loaded games have bugs new games do not.
  Reset to the loaded state and run the same build-from-state code.
- **Autosave over the manual slot**, or in the middle of an animation sequence that has
  not been applied yet. Its own slot, and only between commands.

## Verify

```ts
test('a save survives the round trip', () => {
  const state = apply(createGame(), { type: 'endTurn' });
  expect(fromSave(toSave(state))).toStrictEqual(state);
});

test('an old save is migrated, a newer one is refused', () => {
  const old = JSON.stringify({ version: 1, state: { units: [], turn: 0, winner: null } });
  expect(fromSave(old).turnNumber).toBe(1);
  expect(() => fromSave(JSON.stringify({ version: SAVE_VERSION + 1, state: {} }))).toThrow('newer version');
});
```

`toStrictEqual` after the round trip (not `toEqual`, which lets a class instance and an
`undefined` through) is the test that catches a `Map`, a class instance or an
`undefined` in the state. Keep one real save file per released version under
`game/test/` and load each in a test after every change to the state's shape.

A pass is those tests and `bun run check` ending in `PASSED`. What a test cannot do is
close the game: ask the user to save in the middle of a game, close the tab, open it
again, load, and report anything that differs.
