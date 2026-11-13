import type { Engine, GameObject } from '@synergy/engine';
import type { JSX } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { allGameObjects, childrenOf, sceneRoots } from '../inspect';
import { Selection } from '../Selection';

/** Most rows a search lists; a map of a thousand tiles named "Tile" should not freeze the page. */
const MAX_RESULTS = 300;

/**
 * Unity's Hierarchy window: the loaded scenes and their GameObjects as a tree. Click to
 * select (the Inspector shows it), click the arrow to open a parent. Inactive objects are
 * grey. Typing in the search box lists every object whose name contains the text.
 */
export function HierarchyPanel({ engine }: { engine: Engine }) {
  const [search, setSearch] = useState('');
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const open = useRef(new WeakSet<GameObject>()).current;
  const selected = Selection.activeGameObject;

  // Selecting from elsewhere (the Console, a reference field, code) opens its parents.
  useEffect(
    () =>
      Selection.selectionChanged.addListener(() => {
        for (let t = Selection.activeTransform?.parent; t; t = t.parent) open.add(t.gameObject);
        redraw(undefined);
      }),
    [open],
  );

  const toggle = (gameObject: GameObject) => {
    if (open.has(gameObject)) open.delete(gameObject);
    else open.add(gameObject);
    redraw(undefined);
  };

  const node = (gameObject: GameObject, depth: number, list: JSX.Element[]) => {
    const children = gameObject.transform.childCount;
    const expanded = open.has(gameObject);
    const classes = ['ed-node'];
    if (gameObject === selected) classes.push('ed-selected');
    if (!gameObject.activeInHierarchy) classes.push('ed-inactive');
    list.push(
      <div
        key={gameObject.getInstanceId()}
        className={classes.join(' ')}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => {
          Selection.activeGameObject = gameObject;
        }}
      >
        <span
          className="ed-arrow"
          onClick={(event) => {
            event.stopPropagation();
            if (children > 0) toggle(gameObject);
          }}
        >
          {children > 0 ? (expanded ? '▼' : '▶') : ''}
        </span>
        {gameObject.name}
      </div>,
    );
    if (expanded) for (const child of childrenOf(gameObject)) node(child, depth + 1, list);
  };

  const rows: JSX.Element[] = [];
  const query = search.trim().toLowerCase();
  if (query) {
    const matches = allGameObjects(engine).filter((gameObject) => gameObject.name.toLowerCase().includes(query));
    for (const match of matches.slice(0, MAX_RESULTS)) {
      rows.push(
        <div
          key={match.getInstanceId()}
          className={`ed-node${match === selected ? ' ed-selected' : ''}${match.activeInHierarchy ? '' : ' ed-inactive'}`}
          style={{ paddingLeft: '8px' }}
          onClick={() => {
            Selection.activeGameObject = match;
          }}
        >
          {match.name}
        </div>,
      );
    }
    if (matches.length > MAX_RESULTS) {
      rows.push(
        <div key="more" className="ed-empty">
          … and {matches.length - MAX_RESULTS} more. Type more of the name.
        </div>,
      );
    }
    if (matches.length === 0) {
      rows.push(
        <div key="none" className="ed-empty">
          Nothing is named like "{search}".
        </div>,
      );
    }
  } else {
    for (const { scene, active, roots } of engine.run(() => sceneRoots(engine))) {
      rows.push(
        <div key={`scene:${scene.name}`} className="ed-node ed-scene">
          <span className="ed-arrow">▼</span>
          {scene.name}
          {active ? '' : <span className="ed-dim">&nbsp;(not active)</span>}
        </div>,
      );
      for (const root of roots) node(root, 1, rows);
    }
  }

  return (
    <section className="ed-panel ed-hierarchy" data-interactive>
      <div className="ed-tabs">
        <span className="ed-tab">Hierarchy</span>
      </div>
      <input
        className="ed-search"
        type="search"
        placeholder="Search"
        value={search}
        onInput={(event) => setSearch(event.currentTarget.value)}
      />
      <div className="ed-scroll">{rows}</div>
    </section>
  );
}
