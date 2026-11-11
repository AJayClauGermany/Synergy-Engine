import { currentEngine } from './runtime';

/**
 * The type given to Unity's spelling of a message (`Update`, `OnEnable`, ...), so that
 * writing one is a type error. The compiler's message ends with this type's name, which
 * says what to write instead:
 *
 *   Type '() => void' is not assignable to type 'UseCamelCase<"update">'.
 */
export type UseCamelCase<Name extends string> = { readonly renameThisMethodTo: Name };

/**
 * Unity messages nothing here sends. Listed so that a ported script which relies on one
 * says so when it runs, instead of doing nothing.
 */
const NOT_SENT: Record<string, string> = {
  oncollisionenter: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  oncollisionstay: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  oncollisionexit: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  ontriggerenter: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  ontriggerstay: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  ontriggerexit: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  oncollisionenter2d: 'there is no 2D physics; test for contact with Physics.overlapSphere or a raycast',
  ontriggerenter2d: 'there is no 2D physics; test for overlap with Physics.overlapSphere in update()',
  ontriggerexit2d: 'there is no 2D physics; test for overlap with Physics.overlapSphere in update()',
  onmousedrag: 'track the drag yourself between onMouseDown() and onMouseUp() with Input.mousePosition',
  onmouseupasbutton: 'use onMouseUp()',
  ongui: 'draw UI with a Canvas and Image, or with the React HUD',
  onbecamevisible: 'visibility messages are not sent',
  onbecameinvisible: 'visibility messages are not sent',
  onapplicationquit: 'listen for the page closing instead (the "pagehide" event)',
  onapplicationpause: 'listen for the page being hidden instead (the "visibilitychange" event)',
  onapplicationfocus: 'listen for the window\'s "focus" and "blur" events instead',
};

interface Verdict {
  /** A method that can only be a mistake: a message in the wrong letter case. */
  error: string | null;
  /** The error has been logged by an engine that logs instead of throwing. */
  logged: boolean;
  /** Methods that are probably a mistake. Logged once. */
  warnings: string[];
}

const verdicts = new WeakMap<object, Verdict>();

function inspect(type: MessageHost): Verdict {
  const valid = type._messageNames ?? [];
  const byLowerCase = new Map(valid.map((name) => [name.toLowerCase(), name]));
  const verdict: Verdict = { error: null, logged: false, warnings: [] };

  // Every class from the script up to the engine base class that declares the messages
  // (MonoBehaviour, or netcode's NetworkBehaviour), whose own methods are not suspects.
  for (let proto: object | null = type.prototype; proto; proto = Object.getPrototypeOf(proto) as object | null) {
    const owner = (proto as { constructor?: MessageHost }).constructor;
    if (!owner || Object.hasOwn(owner, '_messageNames')) break;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function') continue;
      if (valid.includes(name)) continue;
      const lower = name.toLowerCase();
      const intended = byLowerCase.get(lower);
      if (intended) {
        verdict.error ??=
          `${type.name}.${name}() will never be called: message names are camelCase here. Rename it to ${intended}().`;
        continue;
      }
      // "onStart", "onUpdate": a message with an "on" it does not have.
      const withoutOn = lower.startsWith('on') ? byLowerCase.get(lower.slice(2)) : undefined;
      if (withoutOn) {
        verdict.warnings.push(
          `${type.name}.${name}() looks like a Unity message, but the engine never calls it. Did you mean ${withoutOn}()?`,
        );
        continue;
      }
      const reason = NOT_SENT[lower];
      if (reason) {
        verdict.warnings.push(`${type.name}.${name}() is a Unity message this engine does not send, so it will never be called: ${reason}.`);
      }
    }
  }
  return verdict;
}

interface MessageHost {
  readonly name: string;
  readonly prototype: object;
  readonly _messageNames?: readonly string[];
}

/**
 * @internal Looks at a script class the first time one is created and reports methods
 * that look like messages but will never be called: `Update()`, `onStart()`,
 * `onTriggerEnter()`. A wrong-case message is an error (a headless engine throws, so a
 * test fails; a browser logs it, which also fails `bun run screenshot`); the rest are
 * warnings, logged once per class.
 */
export function checkMessageNames(type: MessageHost): void {
  let verdict = verdicts.get(type);
  if (!verdict) {
    verdict = inspect(type);
    verdicts.set(type, verdict);
    for (const warning of verdict.warnings) console.warn(warning);
  }
  if (verdict.error && !verdict.logged) {
    // A headless engine throws here, every time, so each test that uses the class fails.
    currentEngine().reportError(new Error(verdict.error), `adding ${type.name}`);
    // A browser engine logged it and carried on; once per class is enough.
    verdict.logged = true;
  }
}
