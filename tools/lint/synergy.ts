/**
 * Lint rules for the mistakes a Unity port makes: code that is valid TypeScript, passes
 * the type-checker, and then does something other than the C# it came from.
 *
 * Loaded by oxlint (`jsPlugins` in `.oxlintrc.json`) and written against ESLint's rule
 * API, so each rule sees one file's syntax tree and nothing else: no types, no other
 * files. Every rule is therefore narrow on purpose. It reports what it can be sure of
 * from the text alone and stays silent otherwise, because a false alarm costs more here
 * than a miss (the tests and the engine's own run-time checks are the second net).
 *
 * `docs/checks.md` lists the rules with examples. `synergy.test.ts` runs each one.
 * This file must stay free of imports that run code: the linter loads it for every run.
 */
import type { RuleTester } from 'oxlint/plugins-dev';

type AnyRule = Parameters<RuleTester['run']>[1];
/** A rule, as oxlint and ESLint define one. */
export type Rule = Extract<AnyRule, { create: (context: never) => unknown }>;
type Visitor = ReturnType<Rule['create']>;
type NodeOf<Kind extends string> = Parameters<NonNullable<Visitor[Kind]>>[0];
type Node = NodeOf<string>;
type ClassNode = NodeOf<'ClassDeclaration'>;
type MethodNode = NodeOf<'MethodDefinition'>;

/** Engine types that are structs in Unity and immutable objects here. */
const VALUE_TYPES = new Set(['Vector2', 'Vector3', 'Vector2Int', 'Vector3Int', 'Quaternion', 'Color']);
/** The same, plus the shapes the engine accepts in their place. */
const VALUE_KEY_TYPES = new Set([...VALUE_TYPES, 'CellLike', 'Cell', 'Vector3Like', 'QuaternionLike', 'ColorLike']);
/** Base classes of scripts: the classes the engine sends messages to. */
const BEHAVIOUR_BASES = new Set(['MonoBehaviour', 'NetworkBehaviour']);

/**
 * The messages the engine sends (`MonoBehaviour._messageNames` plus the ones
 * `NetworkBehaviour` adds). `synergy.test.ts` fails if this list and the engine's differ.
 */
export const MESSAGES = [
  'awake',
  'onEnable',
  'start',
  'update',
  'lateUpdate',
  'fixedUpdate',
  'onDisable',
  'onDestroy',
  'onMouseDown',
  'onMouseUp',
  'onMouseEnter',
  'onMouseOver',
  'onMouseExit',
  'onNetworkSpawn',
  'onNetworkDespawn',
  'onGainedOwnership',
  'onLostOwnership',
] as const;

/**
 * Unity messages nothing here sends, in lower case, with what to do instead. The engine
 * keeps the same table (`NOT_SENT` in `core/messageNames.ts`) for its run-time warning;
 * `synergy.test.ts` fails if the two differ.
 */
export const NOT_SENT: Readonly<Record<string, string>> = {
  oncollisionenter: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  oncollisionstay: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  oncollisionexit: 'there is no rigidbody physics yet; test for contact with Physics.overlapSphere or a raycast',
  ontriggerenter: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  ontriggerstay: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  ontriggerexit: 'there are no trigger events yet; test for overlap with Physics.overlapSphere in update()',
  oncollisionenter2d: 'there is no 2D physics; test for contact with Physics.overlapSphere or a raycast',
  ontriggerenter2d: 'there is no 2D physics; test for overlap with Physics.overlapSphere in update()',
  ontriggerexit2d: 'there is no 2D physics; test for overlap with Physics.overlapSphere in update()',
  oncollisionstay2d: 'there is no 2D physics; test for contact with Physics.overlapSphere or a raycast',
  oncollisionexit2d: 'there is no 2D physics; test for contact with Physics.overlapSphere or a raycast',
  ontriggerstay2d: 'there is no 2D physics; test for overlap with Physics.overlapSphere in update()',
  oncontrollercolliderhit: 'there is no CharacterController; move the transform and test ahead with Physics.raycast',
  onparticlecollision: 'there are no particle systems yet',
  onpointerclick: 'uGUI pointer events are not sent; use onMouseDown() with a Collider, or a button in the Preact HUD',
  onpointerdown: 'uGUI pointer events are not sent; use onMouseDown() with a Collider, or a button in the Preact HUD',
  onpointerup: 'uGUI pointer events are not sent; use onMouseUp() with a Collider, or a button in the Preact HUD',
  onpointerenter:
    'uGUI pointer events are not sent; use onMouseEnter() with a Collider, or CSS :hover in the Preact HUD',
  onpointerexit: 'uGUI pointer events are not sent; use onMouseExit() with a Collider, or CSS :hover in the Preact HUD',
  onvalidate: 'there is no editor, so editor messages are never sent; check the values in awake()',
  ondrawgizmos: 'there is no editor, so editor messages are never sent; draw with Debug.drawLine() in update()',
  ondrawgizmosselected: 'there is no editor, so editor messages are never sent; draw with Debug.drawLine() in update()',
  onownershipchanged: 'use onGainedOwnership() and onLostOwnership(), or networkObject.onOwnershipChanged',
  onnetworkprespawn: 'use onNetworkSpawn()',
  onnetworkpostspawn: 'use onNetworkSpawn()',
  onnetworkpredespawn: 'use onNetworkDespawn()',
  onnetworksessionsynchronized: 'use onNetworkSpawn(); for "everyone has loaded", sceneManager.onLoadEventCompleted',
  onmousedrag: 'track the drag yourself between onMouseDown() and onMouseUp() with Input.mousePosition',
  onmouseupasbutton: 'use onMouseUp()',
  ongui: 'draw UI with a Canvas and Image, or with the Preact HUD',
  onbecamevisible: 'visibility messages are not sent',
  onbecameinvisible: 'visibility messages are not sent',
  onapplicationquit: 'listen for the page closing instead (the "pagehide" event)',
  onapplicationpause: 'listen for the page being hidden instead (the "visibilitychange" event)',
  onapplicationfocus: 'listen for the window\'s "focus" and "blur" events instead',
};

const MESSAGE_BY_LOWER_CASE = new Map<string, string>(MESSAGES.map((name) => [name.toLowerCase(), name]));

// ---- Reading the tree ---------------------------------------------------------------

/** The name of a plain identifier, or null for anything else. */
function identifierName(node: Node | null | undefined): string | null {
  return node?.type === 'Identifier' ? node.name : null;
}

/** `Vector3.zero` gives ['Vector3', 'zero']; anything but `Name.member` gives null. */
function staticMember(node: Node): [object: string, property: string] | null {
  if (node.type !== 'MemberExpression' || node.computed) return null;
  const object = identifierName(node.object);
  const property = identifierName(node.property);
  return object && property ? [object, property] : null;
}

/** The expression inside any number of `(...)`, `x!`, `x as T` and `x satisfies T`. */
function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/** The node that uses `node`: its parent, looking past the wrappers `unwrap` removes. */
function siteOf(node: Node): { parent: Node | null; child: Node } {
  let child = node;
  let parent = node.parent;
  while (
    parent &&
    (parent.type === 'ParenthesizedExpression' ||
      parent.type === 'TSNonNullExpression' ||
      parent.type === 'TSAsExpression' ||
      parent.type === 'TSSatisfiesExpression')
  ) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
}

/** The value of `1`, `-1` or `+1` written as a literal; null for anything else. */
function numericLiteral(node: Node | undefined): number | null {
  if (!node) return null;
  if (node.type === 'Literal') return typeof node.value === 'number' ? node.value : null;
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const value = numericLiteral(node.argument);
    if (value === null) return null;
    return node.operator === '-' ? -value : value;
  }
  return null;
}

/** The class a node sits in, or null at module level. */
function enclosingClass(node: Node): ClassNode | null {
  for (let current: Node | null = node.parent; current; current = current.parent) {
    if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') return current;
    if (current.type === 'Program') return null;
  }
  return null;
}

/** An ordinary method of `owner` called `name`: not static, not a getter, not a field. */
function findMethod(owner: ClassNode, name: string): MethodNode | null {
  for (const member of owner.body.body) {
    if (member.type !== 'MethodDefinition' || member.kind !== 'method') continue;
    if (member.static || member.computed) continue;
    if (identifierName(member.key) === name) return member;
  }
  return null;
}

/** Whether `this` or `super` appears anywhere inside `node`. */
function mentionsThis(node: Node): boolean {
  if (node.type === 'ThisExpression' || node.type === 'Super') return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child) && mentionsThis(child)) return true;
    }
  }
  return false;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Whether `owner` is a script: it extends a behaviour base, or a script from this file. */
function isBehaviour(owner: ClassNode, scriptsInFile: ReadonlySet<string>): boolean {
  const base = identifierName(owner.superClass);
  return base !== null && (BEHAVIOUR_BASES.has(base) || scriptsInFile.has(base));
}

/** Members only a script has. A class that uses one through `this` is a script, whatever it extends. */
const SCRIPT_MEMBERS = new Set([
  'transform',
  'gameObject',
  'startCoroutine',
  'stopCoroutine',
  'stopAllCoroutines',
  'getComponent',
  'getComponents',
  'getComponentInChildren',
  'getComponentsInChildren',
  'getComponentInParent',
  'invoke',
  'invokeRepeating',
  'cancelInvoke',
  'networkObject',
  'networkManager',
  'isOwner',
  'isServer',
  'isHost',
]);

/** Whether `node` reads `this.transform`, `this.startCoroutine` or another member only a script has. */
function usesScriptMembers(node: Node): boolean {
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'ThisExpression' &&
    SCRIPT_MEMBERS.has(identifierName(node.property) ?? '')
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child) && usesScriptMembers(child)) return true;
    }
  }
  return false;
}

/**
 * Whether `owner` is a script as far as this file shows: it is one by `isBehaviour`, or its
 * base class comes from another file and it uses a script's own members
 * (`class Archer extends UnitView { update() { this.transform... } }`). A class that merely
 * has an `update()` is not taken for one: state machines and emitters have those too.
 * `plainInFile` collects the classes of this file found not to be scripts.
 */
function looksLikeScript(owner: ClassNode, scriptsInFile: ReadonlySet<string>, plainInFile: Set<string>): boolean {
  if (isBehaviour(owner, scriptsInFile)) return true;
  const base = identifierName(owner.superClass);
  const script = base !== null && !plainInFile.has(base) && usesScriptMembers(owner.body);
  if (!script && owner.id) plainInFile.add(owner.id.name);
  return script;
}

/** A file name without its folders and extension: `game/src/Unit.test.ts` gives `Unit.test`. */
function fileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[cm]?[jt]sx?$/, '');
}

// ---- Rules --------------------------------------------------------------------------

/**
 * `this.onHit` handed over as a value. C# binds a method group to its object; JavaScript
 * does not, so the method later runs with `this` undefined.
 *
 * Only methods declared in the same class are judged (the rule cannot see base classes),
 * and only ones that use `this`. Two calls bind the method themselves and are left alone:
 * the engine's `invoke` family, and any call that also receives `this` as an argument
 * (PlayCanvas's `on(name, callback, scope)`).
 *
 * `startCoroutine(this.run)` is the same slip with another cure (call the method), so it
 * has its own message.
 */
const noDetachedMethod: Rule = {
  meta: {
    type: 'problem',
    messages: {
      detached:
        '`this.{{name}}` is handed over without its `this`, so `this` is undefined when it runs ' +
        '(C# binds a method to its object; JavaScript does not). ' +
        'Pass `() => this.{{name}}()` or `(...args) => this.{{name}}(...args)`, ' +
        'or declare the method as a field: `{{name}} = () => { ... }`.',
      coroutine:
        'startCoroutine takes a running coroutine, not the method that makes one. Call it: ' +
        '`this.startCoroutine(this.{{name}}())`.',
    },
  },
  create(context) {
    const BINDING_CALLS = new Set(['invoke', 'invokeRepeating', 'cancelInvoke', 'isInvoking']);

    function escapes(node: Node): boolean {
      const { parent, child } = siteOf(node);
      switch (parent?.type) {
        case 'CallExpression':
        case 'NewExpression': {
          if (parent.callee === child) return false; // this.method(): an ordinary call
          const callee = unwrap(parent.callee);
          const calleeName =
            callee.type === 'MemberExpression' && !callee.computed ? identifierName(callee.property) : null;
          if (calleeName && BINDING_CALLS.has(calleeName)) return false;
          return !parent.arguments.some((argument) => unwrap(argument).type === 'ThisExpression');
        }
        case 'VariableDeclarator':
          return parent.init === child;
        case 'AssignmentExpression':
          return parent.right === child;
        case 'Property':
          return parent.value === child;
        case 'ConditionalExpression':
          return parent.test !== child;
        case 'LogicalExpression':
          return parent.right === child;
        case 'ArrowFunctionExpression':
          return parent.body === child;
        case 'ArrayExpression':
        case 'ReturnStatement':
        case 'JSXExpressionContainer':
          return true;
        default:
          return false; // this.method.bind(this), typeof, comparisons, truthiness tests
      }
    }

    /** `startCoroutine(this.run)`: Unity's `StartCoroutine(Run())` with the call left off. */
    function startsCoroutine(node: Node): boolean {
      const { parent, child } = siteOf(node);
      if (parent?.type !== 'CallExpression' || parent.callee === child) return false;
      const callee = unwrap(parent.callee);
      return (
        callee.type === 'MemberExpression' && !callee.computed && identifierName(callee.property) === 'startCoroutine'
      );
    }

    return {
      MemberExpression(node) {
        if (node.computed || node.object.type !== 'ThisExpression') return;
        const name = identifierName(node.property);
        const owner = enclosingClass(node);
        if (!name || !owner) return;
        const method = findMethod(owner, name);
        if (!method) return;
        if (startsCoroutine(node)) {
          context.report({ node, messageId: 'coroutine', data: { name } });
          return;
        }
        if (!mentionsThis(method.value) || !escapes(node)) return;
        context.report({ node, messageId: 'detached', data: { name } });
      },
    };
  },
};

/**
 * `position == Vector3.zero`. Unity's structs compare by value; these are objects, and
 * `==`/`===` compare objects by identity, so the result does not depend on the numbers.
 */
const noIdentityCompare: Rule = {
  meta: {
    type: 'problem',
    messages: {
      identity:
        '`{{operator}}` compares two {{type}} objects by identity, not by their numbers, so this is ' +
        '{{result}} for two equal values made separately (C# compares structs by value). ' +
        'Use `a.equals(b)`, or `!a.equals(b)`.',
    },
  },
  create(context) {
    function valueType(node: Node): string | null {
      const inner = unwrap(node);
      if (inner.type === 'NewExpression') {
        const name = identifierName(inner.callee);
        return name && VALUE_TYPES.has(name) ? name : null;
      }
      const member = staticMember(inner);
      return member && VALUE_TYPES.has(member[0]) ? member[0] : null;
    }

    return {
      BinaryExpression(node) {
        const { operator } = node;
        if (operator !== '==' && operator !== '===' && operator !== '!=' && operator !== '!==') return;
        const type = valueType(node.left) ?? valueType(node.right);
        if (!type) return;
        const result = operator.startsWith('!') ? 'true' : 'false';
        context.report({ node, messageId: 'identity', data: { operator, type, result } });
      },
    };
  },
};

/**
 * `Map<Vector3Int, Unit>`: the direct translation of `Dictionary<Vector3Int, Unit>`, and
 * wrong, because a Map finds a key by identity. A cell built from the same numbers
 * elsewhere is a different key, so lookups miss.
 */
const noValueKeys: Rule = {
  meta: {
    type: 'problem',
    messages: {
      valueKey:
        'A {{collection}} keyed by {{key}} finds keys by identity, so an equal {{key}} made elsewhere ' +
        'is a different key and lookups miss (a C# Dictionary or HashSet compares structs by value). ' +
        'Key it by a string instead: {{collection}}<string{{rest}}>, with cellKey(cell) for cells.',
    },
  },
  create(context) {
    const COLLECTIONS = new Set(['Map', 'Set', 'ReadonlyMap', 'ReadonlySet']);

    /** What kind of object the key type is, or null if it is not one this rule knows. */
    function describeKey(key: Node | undefined): string | null {
      if (!key) return null;
      if (key.type === 'TSTypeLiteral') return 'an object';
      if (key.type === 'TSTupleType') return 'a tuple';
      if (key.type !== 'TSTypeReference') return null;
      const name = identifierName(key.typeName);
      return name && VALUE_KEY_TYPES.has(name) ? name : null;
    }

    function check(node: Node, collection: string | null, parameters: readonly Node[] | undefined): void {
      if (!collection || !COLLECTIONS.has(collection)) return;
      const key = describeKey(parameters?.[0]);
      if (!key) return;
      const rest = collection.endsWith('Map') ? ', …' : '';
      context.report({ node, messageId: 'valueKey', data: { collection, key, rest } });
    }

    return {
      TSTypeReference(node) {
        check(node, identifierName(node.typeName), node.typeArguments?.params);
      },
      NewExpression(node) {
        check(node, identifierName(node.callee), node.typeArguments?.params);
      },
    };
  },
};

/**
 * `onStart()`, `onTriggerEnter()`: methods that read like messages and are never called.
 * The engine warns about them when the script first runs; this says so before it runs,
 * and for scripts no test or scene creates.
 *
 * `Update()` (a real message in Unity's capitals) is left to the type-checker, which
 * already rejects it.
 */
const noUnsentMessage: Rule = {
  meta: {
    type: 'problem',
    messages: {
      extraOn:
        '{{owner}}.{{name}}() looks like a Unity message, but the engine never calls it. ' +
        'The message is {{intended}}(): rename the method. (If your own code calls it, give it a name that ' +
        'is not a message with "on" in front, such as tick().)',
      notSent: '{{owner}}.{{name}}() is a Unity message this engine does not send, so it is never called: {{reason}}.',
    },
  },
  create(context) {
    const scriptsInFile = new Set<string>();
    const plainInFile = new Set<string>();

    function check(owner: ClassNode): void {
      if (!looksLikeScript(owner, scriptsInFile, plainInFile)) return;
      const ownerName = identifierName(owner.id) ?? 'This class';
      if (owner.id) scriptsInFile.add(owner.id.name);
      for (const member of owner.body.body) {
        // A method, or a field holding a function (`onStart = () => { ... }`).
        const isMethod = member.type === 'MethodDefinition' && member.kind === 'method';
        const isFunctionField =
          member.type === 'PropertyDefinition' &&
          (member.value?.type === 'ArrowFunctionExpression' || member.value?.type === 'FunctionExpression');
        if ((!isMethod && !isFunctionField) || member.static || member.computed) continue;
        const name = identifierName(member.key);
        if (!name) continue;
        const lower = name.toLowerCase();
        if (MESSAGE_BY_LOWER_CASE.has(lower)) continue; // a message, or its Unity spelling (a type error)
        const intended = lower.startsWith('on') ? MESSAGE_BY_LOWER_CASE.get(lower.slice(2)) : undefined;
        if (intended) {
          context.report({ node: member.key, messageId: 'extraOn', data: { owner: ownerName, name, intended } });
          continue;
        }
        const reason = NOT_SENT[lower];
        if (reason) {
          context.report({ node: member.key, messageId: 'notSent', data: { owner: ownerName, name, reason } });
        }
      }
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
};

/**
 * `new Vector3(0, 0, 1)`. In Unity that is forward. This engine is right-handed, forward
 * is -Z, and the same numbers point backward. Naming the direction removes the question.
 */
const noZAxisLiteral: Rule = {
  meta: {
    type: 'problem',
    messages: {
      axis:
        'new Vector3(0, 0, {{z}}) is Vector3.{{name}} here: the world is right-handed and forward is -Z ' +
        "(in Unity forward is +Z). Write the direction by name, Vector3.forward or Vector3.back, so it cannot be Unity's by accident.",
      vertical:
        "The 'Vertical' axis is +1 for W and the up arrow, and forward is -Z here, so as the z of a Vector3 it moves backward " +
        "(in Unity forward is +Z). Write Vector3.right.mul(horizontal).add(Vector3.forward.mul(vertical)), or negate it: -Input.getAxis('Vertical').",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (identifierName(node.callee) !== 'Vector3' || node.arguments.length !== 3) return;
        const third = unwrap(node.arguments[2] as Node);
        const axisCall = third.type === 'CallExpression' ? unwrap(third.callee) : null;
        if (
          third.type === 'CallExpression' &&
          axisCall?.type === 'MemberExpression' &&
          ['getAxis', 'getAxisRaw'].includes(identifierName(axisCall.property) ?? '') &&
          third.arguments[0]?.type === 'Literal' &&
          third.arguments[0].value === 'Vertical'
        ) {
          context.report({ node: third, messageId: 'vertical' });
          return;
        }
        const [x, y, z] = node.arguments.map((argument) => numericLiteral(argument));
        if (x !== 0 || y !== 0 || (z !== 1 && z !== -1)) return;
        context.report({ node, messageId: 'axis', data: { z, name: z === -1 ? 'forward' : 'back' } });
      },
    };
  },
};

/**
 * One exported script per file, in a file named after it: `Health` lives in `Health.ts`.
 * It is the project's convention (and Unity's requirement), and it is what makes a
 * script findable from its name in a hierarchy dump or an error message.
 */
const behaviourFileName: Rule = {
  meta: {
    type: 'suggestion',
    messages: {
      fileName:
        'The script {{name}} is exported from {{file}}. A script lives in a file named after it: ' +
        'rename the file to {{name}}{{extension}}, or the class to {{stem}}.',
      oneScript:
        '{{name}} is the second script exported from this file ({{first}} is the first). ' +
        'One exported script per file: move {{name}} to {{name}}{{extension}}.',
    },
  },
  create(context) {
    const scriptsInFile = new Set<string>();
    const exported: ClassNode[] = [];

    return {
      ClassDeclaration(node) {
        if (!node.id || !isBehaviour(node, scriptsInFile)) return;
        scriptsInFile.add(node.id.name);
        const holder = node.parent.type;
        if (holder === 'ExportNamedDeclaration' || holder === 'ExportDefaultDeclaration') exported.push(node);
      },
      'Program:exit'() {
        const [first, ...others] = exported;
        if (!first?.id) return;
        const file = context.filename.split(/[\\/]/).pop() ?? context.filename;
        const stem = fileStem(file);
        const extension = file.slice(stem.length);
        for (const other of others) {
          if (!other.id) continue;
          const data = { name: other.id.name, first: first.id.name, extension };
          context.report({ node: other.id, messageId: 'oneScript', data });
        }
        if (others.length === 0 && first.id.name !== stem) {
          context.report({
            node: first.id,
            messageId: 'fileName',
            data: { name: first.id.name, file, stem, extension },
          });
        }
      },
    };
  },
};

/** The callee of a test call: `test`, `it` or `describe`, and the modifiers chained on it. */
function testCall(callee: Node): { base: string; modifiers: string[] } | null {
  const modifiers: string[] = [];
  let current = unwrap(callee);
  // test.skip.each(rows)(name, fn): the call that is given the name wraps another call.
  if (current.type === 'CallExpression') current = unwrap(current.callee);
  while (current.type === 'MemberExpression' && !current.computed) {
    const modifier = identifierName(current.property);
    if (!modifier) return null;
    modifiers.unshift(modifier);
    current = unwrap(current.object);
  }
  const base = identifierName(current);
  return base && TEST_FUNCTIONS.has(base) ? { base, modifiers } : null;
}

const TEST_FUNCTIONS = new Set(['test', 'it', 'describe']);

/** `test.skipIf(true)(...)`, `test.if(false)(...)`: whether the condition is written as a constant. */
function constantCondition(callee: Node): boolean {
  const inner = unwrap(callee);
  if (inner.type !== 'CallExpression') return false;
  const condition = inner.arguments[0];
  return condition?.type === 'Literal' && typeof condition.value === 'boolean';
}

/**
 * `test.skip`, `test.only` and their relatives. Each turns a failing suite green without
 * fixing anything: a skipped test does not run, `.only` stops every other test in its
 * file, `.failing` passes because the test fails, and `.todo` with a body is a skip under
 * another name. `test.todo('name')`, with no body, is a test still to be written, and
 * `test.skipIf(condition)` with a real condition (no browser here) is left alone.
 */
const noSkippedTest: Rule = {
  meta: {
    type: 'problem',
    messages: {
      skip:
        '{{call}} switches this test off, so whatever it checks is no longer checked. ' +
        'Fix what makes it fail and remove .skip, or delete the test if what it covered is gone.',
      only:
        '{{call}} stops every other test in this file from running, so they pass without being run. ' +
        "Remove .only. To run one test while working, use: bun test -t 'part of its name'.",
      conditional:
        '{{call}} with a fixed condition switches this test off for good, and a test that does not run checks nothing ' +
        'while the suite still passes. Remove the condition and fix what makes the test fail.',
      failing: '{{call}} passes while the test fails, so the bug it shows is recorded as fine. Fix what makes it fail.',
      todoBody:
        '{{call}} with a body is a skipped test: the body never runs. Remove .todo and make it pass, ' +
        "or keep only the name, {{call}}('...'), for a test still to be written.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const call = testCall(node.callee);
        if (!call) return;
        // Report the outer call only: in test.skip.each(rows)(name, fn) the inner one is rows.
        if (node.parent?.type === 'CallExpression' && node.parent.callee === node) return;
        const data = { call: `${call.base}.${call.modifiers.join('.')}` };
        const has = (...names: string[]) => call.modifiers.some((name) => names.includes(name));
        const hasBody = node.arguments.some(
          (argument) => argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression',
        );
        let messageId: 'skip' | 'only' | 'conditional' | 'failing' | 'todoBody' | null = null;
        if (has('skip')) messageId = 'skip';
        else if (has('only')) messageId = 'only';
        else if (has('skipIf', 'if', 'todoIf') && constantCondition(node.callee)) messageId = 'conditional';
        else if (has('failing')) messageId = 'failing';
        else if (has('todo') && hasBody) messageId = 'todoBody';
        if (messageId) context.report({ node: node.callee, messageId, data });
      },
    };
  },
};

/**
 * A test with no `expect`. It passes whatever the code does, which reads as "tested" and
 * is not. (A test that only has to not throw says so: `expect(() => run()).not.toThrow()`.)
 */
const testNeedsExpect: Rule = {
  meta: {
    type: 'problem',
    messages: {
      noExpect:
        'This test has no expect(...), so it passes whatever the code does. Assert what should be true ' +
        'afterwards; if the point is that nothing throws, write expect(() => ...).not.toThrow().',
    },
  },
  create(context) {
    /**
     * Whether anything inside `node` asserts: `expect(x).toBe(y)`, or a helper named like
     * an assertion. `expect(x);` alone does not: with no matcher after it nothing is
     * compared (it is what NUnit's `Assert.IsTrue(x)` turns into when ported word for word).
     */
    function asserts(node: Node): boolean {
      if (node.type === 'CallExpression') {
        let callee = unwrap(node.callee);
        const chained = callee.type === 'MemberExpression';
        while (callee.type === 'MemberExpression') callee = unwrap(callee.object);
        // expect(x).toBe(y): the outer call's callee chain ends in the call expect(x).
        const inner = callee.type === 'CallExpression' ? identifierName(unwrap(callee.callee)) : null;
        if (chained && inner && /^expect/i.test(inner)) return true;
        const name = identifierName(callee);
        if (name && /^assert/i.test(name)) return true;
        if (name && /^expect./i.test(name)) return true; // a helper: expectSameState(a, b)
        if (name === 'expect' && chained) return true; // expect.assertions(n), expect.hasAssertions()
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent') continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          if (isNode(child) && asserts(child)) return true;
        }
      }
      return false;
    }

    return {
      CallExpression(node) {
        const call = testCall(node.callee);
        if (!call || call.base === 'describe' || call.modifiers.includes('todo')) return;
        const body = node.arguments.find(
          (argument) => argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression',
        );
        if (!body || asserts(body)) return;
        context.report({ node: node.callee, messageId: 'noExpect' });
      },
    };
  },
};

/**
 * `event.removeListener(() => this.onAlarm())`. A function written at the call is a new
 * function, never the one that was added, so nothing is removed and the listener stays
 * for the life of the event. C# compares delegates by what they call; JavaScript compares
 * functions by identity.
 */
const noInlineRemove: Rule = {
  meta: {
    type: 'problem',
    messages: {
      inline:
        '{{method}}() is given a function written right here. It is a new function, not the one that was added, ' +
        'so nothing is removed. Keep what adding returned and call that (`this.stop = event.addListener(...)`, later `this.stop()`), ' +
        'or make the handler a field (`onAlarm = () => { ... }`) and pass `this.onAlarm` to both.',
    },
  },
  create(context) {
    const REMOVERS = new Set(['removeListener', 'removeEventListener', 'cancelInvoke', 'isInvoking', 'off']);
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const method = identifierName(callee.property);
        if (!method || !REMOVERS.has(method)) return;
        const written = node.arguments.find(
          (argument) => argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression',
        );
        if (written) context.report({ node: written, messageId: 'inline', data: { method } });
      },
    };
  },
};

/** Methods only the engine's value types have. They return a new value and change nothing. */
const PURE_METHODS = new Set(['neg', 'withX', 'withY', 'withZ', 'withAlpha', 'encapsulate']);
/**
 * Names the value types share with things that do change in place: a `Set` has `add`, a
 * canvas has `scale`, and PlayCanvas's own `Vec3` (reached through `gameObject.entity`)
 * has `add`, `sub`, `mul`, `div` and `cross` that change the vector. These count only when
 * the receiver is plainly one of the engine's values.
 */
const SHARED_METHODS = new Set(['add', 'sub', 'mul', 'div', 'cross', 'scale', 'rotate', 'lerp']);
/** Properties that hold a value type. `x.position.add(v)` cannot be a Set's or a list's `add`. */
const VALUE_PROPERTIES = new Set([
  'position',
  'localPosition',
  'localScale',
  'eulerAngles',
  'localEulerAngles',
  'forward',
  'right',
  'up',
  'velocity',
  'direction',
  'normalized',
]);

/**
 * `this.transform.position.add(step);` as a statement. Vectors are immutable: `add`
 * returns the sum and leaves the position where it was, so the line does nothing. In
 * Unity `position += step` moved the object, and in PlayCanvas or three.js `add` changes
 * the vector in place; here the result has to be assigned.
 */
const noDiscardedResult: Rule = {
  meta: {
    type: 'problem',
    messages: {
      discarded:
        '.{{method}}() returns a new value and changes nothing, and this line throws the result away, so it does nothing. ' +
        'Vectors, colours and bounds are immutable here: assign the result, as in ' +
        '`transform.position = transform.position.add(step)` or `bounds = bounds.encapsulate(point)`.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const call = unwrap(node.expression);
        if (call.type !== 'CallExpression') return;
        const callee = unwrap(call.callee);
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const method = identifierName(callee.property);
        if (!method) return;
        const receiver = unwrap(callee.object);
        const onValue =
          (receiver.type === 'MemberExpression' && VALUE_PROPERTIES.has(identifierName(receiver.property) ?? '')) ||
          (receiver.type === 'NewExpression' && VALUE_TYPES.has(identifierName(receiver.callee) ?? '')) ||
          VALUE_TYPES.has(staticMember(receiver)?.[0] ?? '');
        if (PURE_METHODS.has(method) || (onValue && SHARED_METHODS.has(method))) {
          context.report({ node: call, messageId: 'discarded', data: { method } });
        }
      },
    };
  },
};

/**
 * Members the engine keeps on every script for its own bookkeeping. `synergy.test.ts`
 * fails if this list and the engine's differ.
 */
export const ENGINE_MEMBERS = [
  '_attach',
  '_awake',
  '_awoken',
  '_copyFrom',
  '_deferred',
  '_destroy',
  '_destroyed',
  '_disable',
  '_enable',
  '_enabled',
  '_enabledChanged',
  '_gameObjectDeactivated',
  '_has',
  '_instanceId',
  '_invokes',
  '_live',
  '_lookup',
  '_returned',
  '_send',
  '_startQueued',
  '_started',
  '_wantsLive',
] as const;

/**
 * `_started = false` or `_destroy() { ... }` in a script. The engine has members of those
 * names on every script, and a script that declares its own replaces them: `update` stops
 * being called, or `onDestroy` never runs, with no error. (`private _started` is a type
 * error already; without `private` it compiles.)
 */
const noEngineMember: Rule = {
  meta: {
    type: 'problem',
    messages: {
      taken:
        '{{owner}}.{{name}} has the name of a member the engine keeps on every script for its own use, and replaces it: ' +
        'messages can stop arriving with no error. Choose another name ({{suggestion}}).',
    },
  },
  create(context) {
    const scriptsInFile = new Set<string>();
    const plainInFile = new Set<string>();
    const taken = new Set<string>(ENGINE_MEMBERS);

    function check(owner: ClassNode): void {
      if (!looksLikeScript(owner, scriptsInFile, plainInFile)) return;
      if (owner.id) scriptsInFile.add(owner.id.name);
      for (const member of owner.body.body) {
        if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue;
        if (member.static || member.computed || member.override) continue;
        const name = identifierName(member.key);
        if (!name || !taken.has(name)) continue;
        const data = {
          owner: identifierName(owner.id) ?? 'This class',
          name,
          suggestion: `_${name.slice(1)}Now, _my${name[1]?.toUpperCase() ?? ''}${name.slice(2)}`,
        };
        context.report({ node: member.key, messageId: 'taken', data });
      }
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
};

const NETWORK_FACTORIES = new Set(['serverRpc', 'clientRpc', 'rpc']);
const NETWORK_TYPES = new Set(['NetworkVariable', 'NetworkList']);

/** Whether `value` is `new NetworkVariable(...)`, `new NetworkList(...)` or `this.serverRpc(...)` and the like. */
function networkMemberKind(value: Node | null | undefined): 'variable' | 'rpc' | null {
  if (!value) return null;
  const node = unwrap(value);
  if (node.type === 'NewExpression' && NETWORK_TYPES.has(identifierName(node.callee) ?? '')) return 'variable';
  if (node.type === 'CallExpression') {
    const callee = unwrap(node.callee);
    if (
      callee.type === 'MemberExpression' &&
      unwrap(callee.object).type === 'ThisExpression' &&
      NETWORK_FACTORIES.has(identifierName(callee.property) ?? '')
    ) {
      return 'rpc';
    }
  }
  return null;
}

/**
 * Netcode members written the way that compiles and does not replicate:
 *
 * - `healServerRpc() { ... }`: NGO's `[ServerRpc] void HealServerRpc()` as a method. It is
 *   an ordinary method and runs only on the machine that calls it.
 * - `#hp = new NetworkVariable(10)`: a `#private` field cannot be seen by the code that
 *   binds variables to the object, so it never leaves the machine.
 * - `new NetworkVariable(...)` on a class that extends `MonoBehaviour`: nothing binds it.
 * - a variable or RPC tucked into an array or object field: the field name is its
 *   identity on the wire, and it has none.
 */
const networkMembers: Rule = {
  meta: {
    type: 'problem',
    messages: {
      rpcMethod:
        '{{name}}() is a method, so it runs only on the machine that calls it: nothing is sent. An RPC is a field: ' +
        '`readonly {{name}} = this.serverRpc((...) => { ... })` (or this.clientRpc, or this.rpc(SendTo.Everyone, ...)).',
      privateField:
        '#{{name}} is a #private field, which the netcode cannot see: it is never bound to the object, so it is not ' +
        'replicated and anyone may write it. Declare it `readonly {{name}} = ...` (TypeScript `private readonly` is fine).',
      wrongBase:
        '{{name}} is a network member on a class that does not extend NetworkBehaviour, so nothing replicates it. ' +
        'Extend NetworkBehaviour (and put the object under a NetworkObject, as NetworkPrefab does).',
      nested:
        'A NetworkVariable or RPC inside an array or object is not replicated: its field name is its identity on the wire. ' +
        'Declare each as its own field (`readonly wood = new NetworkVariable(0)`), or hold the whole collection in one NetworkVariable or NetworkList.',
    },
  },
  create(context) {
    const networkedInFile = new Set<string>();

    function check(owner: ClassNode): void {
      const base = identifierName(owner.superClass);
      const networked = base === 'NetworkBehaviour' || (base !== null && networkedInFile.has(base));
      if (networked && owner.id) networkedInFile.add(owner.id.name);
      for (const member of owner.body.body) {
        if (member.type === 'StaticBlock' || member.static) continue;
        // A private method is not something another machine could have been meant to call:
        // it is the body of a handler, moved out of its field (`private onMoveRpc(...)`).
        const hidden =
          member.type === 'MethodDefinition' &&
          (member.accessibility === 'private' || member.accessibility === 'protected');
        if (
          networked &&
          member.type === 'MethodDefinition' &&
          member.kind === 'method' &&
          !member.computed &&
          !hidden
        ) {
          const name = identifierName(member.key);
          if (name?.endsWith('Rpc')) context.report({ node: member.key, messageId: 'rpcMethod', data: { name } });
        }
        if (member.type !== 'PropertyDefinition') continue;
        const kind = networkMemberKind(member.value);
        if (kind && member.key.type === 'PrivateIdentifier') {
          context.report({ node: member.key, messageId: 'privateField', data: { name: member.key.name } });
        } else if (kind === 'variable' && base === 'MonoBehaviour') {
          context.report({
            node: member.key,
            messageId: 'wrongBase',
            data: { name: identifierName(member.key) ?? 'This' },
          });
        } else if (!kind && networked && member.value) {
          const value = unwrap(member.value);
          const parts =
            value.type === 'ArrayExpression'
              ? value.elements
              : value.type === 'ObjectExpression'
                ? value.properties.map((property: Node) => (property.type === 'Property' ? property.value : null))
                : [];
          const inside = parts.find((part: Node | null) => networkMemberKind(part) !== null);
          if (inside) context.report({ node: inside, messageId: 'nested' });
        }
      }
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
};

/**
 * `let nextId = 0;` at the top of a rules file. Rules are run by every machine, and a
 * machine that joins late, reloads, or played another game first has a different value in
 * that variable: the same commands then give different states. Whatever the rules need to
 * remember is part of the state they are given.
 */
const noModuleState: Rule = {
  meta: {
    type: 'problem',
    messages: {
      state:
        '`{{kind}} {{name}}` at the top of a rules file is state the rules keep outside the game state. Every machine has its own copy, ' +
        'and one that joined late or played before has a different value, so the same commands give different results. ' +
        'Put it in the state (`{ ...state, {{name}}: ... }`), or make it a `const` if it never changes.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind === 'const' || node.parent?.type !== 'Program') return;
        for (const declaration of node.declarations) {
          const name = identifierName(declaration.id) ?? 'value';
          context.report({ node: declaration, messageId: 'state', data: { kind: node.kind, name } });
        }
      },
    };
  },
};

export const rules = {
  'behaviour-file-name': behaviourFileName,
  'network-members': networkMembers,
  'no-discarded-result': noDiscardedResult,
  'no-engine-member': noEngineMember,
  'no-inline-remove': noInlineRemove,
  'no-module-state': noModuleState,
  'no-detached-method': noDetachedMethod,
  'no-identity-compare': noIdentityCompare,
  'no-skipped-test': noSkippedTest,
  'no-unsent-message': noUnsentMessage,
  'no-value-keys': noValueKeys,
  'no-z-axis-literal': noZAxisLiteral,
  'test-needs-expect': testNeedsExpect,
} satisfies Record<string, Rule>;

export default { meta: { name: 'synergy' }, rules };
