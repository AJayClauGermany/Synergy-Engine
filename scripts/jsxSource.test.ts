import { describe, expect, test } from 'bun:test';
import { SOURCE_ATTRIBUTE, stampJsxSource } from './jsxSource';

/** The transform that tells the feedback tool where each JSX element was written. */
describe('stampJsxSource', () => {
  test('writes file:line:column on elements and components, after their other attributes', () => {
    const code = [
      'export const Menu = () => (',
      '  <div class="menu">',
      '    <Title text="Hi" />',
      '  </div>',
      ');',
    ].join('\n');
    expect(stampJsxSource(code, 'game/src/ui/Menu.tsx')).toBe(
      [
        'export const Menu = () => (',
        '  <div class="menu" data-source="game/src/ui/Menu.tsx:2:3">',
        '    <Title text="Hi" data-source="game/src/ui/Menu.tsx:3:5" />',
        '  </div>',
        ');',
      ].join('\n'),
    );
  });

  test('a spread cannot replace it, and the result is still valid JSX', () => {
    const out = stampJsxSource('const a = <button {...rest}>x</button>;', 'a.tsx');
    expect(out).toBe('const a = <button {...rest} data-source="a.tsx:1:11">x</button>;');
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(out)).not.toThrow();
  });

  test('fragments are left alone, and so is an element that already says where it is from', () => {
    const code = 'const a = <><Fragment key="k"><p data-source="x">y</p></Fragment></>;';
    expect(stampJsxSource(code, 'a.tsx')).toBe(code);
  });

  test('generics and comparisons are not mistaken for elements; characters outside ASCII keep the count right', () => {
    const code = "const tick = '✓😀'; const f = <T,>(v: T) => (1 < 2 ? <b>{tick}</b> : null);";
    const out = stampJsxSource(code, 'a.tsx');
    expect(out).toContain(`<b ${SOURCE_ATTRIBUTE}="a.tsx:1:${code.indexOf('<b>') + 1}">`);
    expect(out.match(/data-source/g)?.length).toBe(1);
  });

  test('code that does not parse comes back unchanged, for the bundler to report', () => {
    const broken = 'const a = <div>;';
    expect(stampJsxSource(broken, 'a.tsx')).toBe(broken);
  });
});
