import { Component, type GameObject, Transform, typeNameOf, Vector3 } from '@synergy/engine';
import { useState } from 'preact/hooks';
import { canDisable, colorToHex, type Field, fieldsOf, gameObjectOfReference, setField, summaryOf } from '../inspect';
import { Selection } from '../Selection';
import { nicify, NumberField, Row, TextField, tryEdit, VectorField } from './fields';

const typeName = (component: Component) => typeNameOf(component);

function TransformBody({ transform }: { transform: Transform }) {
  const p = transform.localPosition;
  const r = transform.localEulerAngles;
  const s = transform.localScale;
  const set = (what: string, apply: (value: Vector3) => void) => (values: number[]) =>
    tryEdit(what, () => apply(new Vector3(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0)));
  return (
    <>
      <Row label="Position">
        <VectorField
          values={[p.x, p.y, p.z]}
          onCommit={set('Position', (v) => {
            transform.localPosition = v;
          })}
        />
      </Row>
      <Row label="Rotation">
        <VectorField
          values={[r.x, r.y, r.z]}
          onCommit={set('Rotation', (v) => {
            transform.localEulerAngles = v;
          })}
        />
      </Row>
      <Row label="Scale">
        <VectorField
          values={[s.x, s.y, s.z]}
          onCommit={set('Scale', (v) => {
            transform.localScale = v;
          })}
        />
      </Row>
    </>
  );
}

function FieldRow({ component, field }: { component: Component; field: Field }) {
  const label = nicify(field.key);
  const edit = (input: string | boolean | number[]) =>
    tryEdit(`${typeName(component)}.${field.key}`, () => setField(component, field.key, input));
  const { value } = field;
  switch (field.kind) {
    case 'number':
      return (
        <Row label={label}>
          <NumberField value={value as number} onCommit={(next) => edit(String(next))} />
        </Row>
      );
    case 'boolean':
      return (
        <Row label={label}>
          <input type="checkbox" checked={value as boolean} onChange={(event) => edit(event.currentTarget.checked)} />
        </Row>
      );
    case 'string':
      return (
        <Row label={label}>
          <TextField value={value as string} onCommit={edit} />
        </Row>
      );
    case 'vector2':
    case 'vector3': {
      const v = value as { x: number; y: number; z?: number };
      return (
        <Row label={label}>
          <VectorField values={field.kind === 'vector3' ? [v.x, v.y, v.z ?? 0] : [v.x, v.y]} onCommit={edit} />
        </Row>
      );
    }
    case 'color':
      return (
        <Row label={label}>
          <input
            type="color"
            value={colorToHex(value as Parameters<typeof colorToHex>[0])}
            onInput={(event) => edit(event.currentTarget.value)}
          />
        </Row>
      );
    case 'reference': {
      // Unity's object field: clicking it selects what it points at.
      const target = gameObjectOfReference(value);
      return (
        <Row label={label}>
          <button
            type="button"
            className="ed-ref"
            title={target ? 'Select it' : field.text}
            onClick={() => {
              if (target) Selection.activeGameObject = target;
            }}
          >
            {field.text}
          </button>
        </Row>
      );
    }
    default:
      return (
        <Row label={label}>
          <span className="ed-readonly">{field.text}</span>
        </Row>
      );
  }
}

function ComponentView({ component, folded, onFold }: { component: Component; folded: boolean; onFold: () => void }) {
  const name = typeName(component);
  const isTransform = component instanceof Transform;
  const fields = isTransform ? [] : fieldsOf(component);
  const summary = isTransform ? '' : summaryOf(component);
  return (
    <div className="ed-component">
      <div className="ed-component-title" onClick={onFold}>
        <span className="ed-arrow">{folded ? '▶' : '▼'}</span>
        {canDisable(component) && (
          <input
            type="checkbox"
            title="Enabled"
            checked={component.enabled}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              tryEdit(`${name}.enabled`, () => {
                component.enabled = enabled;
              });
            }}
          />
        )}
        <span>{name}</span>
      </div>
      {!folded && (
        <div className="ed-component-body">
          {isTransform && <TransformBody transform={component} />}
          {summary && <div className="ed-summary">{summary}</div>}
          {fields.map((field) => (
            <FieldRow key={field.key} component={component} field={field} />
          ))}
          {!isTransform && !summary && fields.length === 0 && <div className="ed-dim">No public fields.</div>}
        </div>
      )}
    </div>
  );
}

function GameObjectView({ gameObject }: { gameObject: GameObject }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (name: string) => {
    const next = new Set(folded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setFolded(next);
  };
  const components = gameObject.getComponents(Component);
  return (
    <>
      <div className="ed-header">
        <input
          type="checkbox"
          title="Active"
          checked={gameObject.activeSelf}
          onChange={(event) => gameObject.setActive(event.currentTarget.checked)}
        />
        <TextField
          value={gameObject.name}
          onCommit={(name) => {
            gameObject.name = name;
          }}
        />
        <div className="ed-meta">
          <span>Tag {gameObject.tag}</span>
          <span>Layer {gameObject.layer}</span>
          <span>Scene {gameObject.scene.name}</span>
        </div>
      </div>
      {components.map((component) => {
        const name = typeName(component);
        return (
          <ComponentView
            key={component.getInstanceId()}
            component={component}
            folded={folded.has(name)}
            onFold={() => fold(name)}
          />
        );
      })}
    </>
  );
}

/**
 * Unity's Inspector window: the selected GameObject's name, active state, tag and layer,
 * then each component. The Transform shows its local position, rotation and scale; a
 * script shows its public fields (names not starting with `_`), editable while the game
 * runs; a built-in component describes itself. Reference fields select what they point at.
 */
export function InspectorPanel() {
  const selected = Selection.activeGameObject;
  return (
    <section className="ed-panel ed-inspector" data-interactive>
      <div className="ed-tabs">
        <span className="ed-tab">Inspector</span>
      </div>
      <div className="ed-scroll">
        {selected ? (
          <GameObjectView key={selected.getInstanceId()} gameObject={selected} />
        ) : (
          <div className="ed-empty">Select a GameObject in the Hierarchy, or click a log line that names one.</div>
        )}
      </div>
    </section>
  );
}
