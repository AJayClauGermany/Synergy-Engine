import { Debug } from '@synergy/engine';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

/** Unity's `ObjectNames.NicifyVariableName`: `moveRange` → "Move Range", `m_Speed` → "Speed". */
export function nicify(name: string): string {
  const bare = name.replace(/^(m_|_)/, '');
  const spaced = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Runs an edit; a value that does not convert is reported in the Console instead of thrown. */
export function tryEdit(what: string, edit: () => void): void {
  try {
    edit();
  } catch (error) {
    Debug.logWarning(`Inspector: could not set ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const round = (value: number) => String(Math.round(value * 1000) / 1000);

interface TextFieldProps {
  value: string;
  onCommit: (text: string) => void;
  title?: string;
}

/**
 * A text box that shows the live value until it is clicked, then keeps what is being typed
 * until Enter or leaving the field commits it (Escape gives up). The game keeps running
 * underneath, so a box that followed the value while typing would fight the typist.
 */
export function TextField({ value, onCommit, title }: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="text"
      title={title}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function NumberField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  return (
    <TextField
      value={round(value)}
      onCommit={(text) => {
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onCommit(parsed);
        else Debug.logWarning(`Inspector: "${text}" is not a number.`);
      }}
    />
  );
}

/** X, Y (and Z) boxes side by side, as Unity draws a Vector3. */
export function VectorField({ values, onCommit }: { values: number[]; onCommit: (values: number[]) => void }) {
  return (
    <div className="ed-vector">
      {values.map((value, index) => (
        <label key={index}>
          <span className="ed-dim">{'XYZW'[index]}</span>
          <NumberField
            value={value}
            onCommit={(next) => onCommit(values.map((old, i) => (i === index ? next : old)))}
          />
        </label>
      ))}
    </div>
  );
}

/** A labelled Inspector row. */
export function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div className="ed-field">
      <span title={label}>{label}</span>
      <div>{children}</div>
    </div>
  );
}
