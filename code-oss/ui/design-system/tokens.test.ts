import { expect, it } from 'vitest';
import { atoms, space } from './atoms.ts';
import { codeOss, previewThemeStyles } from './codeOssTheme.ts';
import { tokens } from './tokens.ts';

it('serializes each CSS shorthand arity with explicit length units', () => {
  expect(space('none')).toBe('0px');
  expect(space('md', 'lg')).toBe('8px 12px');
  expect(space('none', 'lg', 'lg')).toBe('0px 12px 12px');
  expect(space('hairline', 'xxs', 'xs', 'md')).toBe('1px 2px 4px 8px');
});

it('serializes nested host groups to native property names and preserves fallback references', () => {
  expect(codeOss.button.foreground).toBe('var(--vscode-button-foreground)');
  expect(codeOss.editor.font.family).toBe('var(--vscode-editor-font-family, monospace)');
  expect(codeOss.input.strongBorder).toBe('var(--vscode-input-border, var(--vscode-panel-border))');
  expect(previewThemeStyles('dark')['--vscode-button-background']).toBe(atoms.color.blue[400]);
  expect(previewThemeStyles('light')['--vscode-button-background']).toBe(atoms.color.blue[650]);
});

it('provides every referenced host variable in both preview themes', () => {
  const references = [...JSON.stringify(tokens).matchAll(/var\((--vscode-[\w-]+)/g)].map(match => match[1]);
  expect(references.length).toBeGreaterThan(0);
  for (const theme of ['dark', 'light'] as const) {
    const declarations = previewThemeStyles(theme);
    for (const name of references) {
      expect(declarations, `${theme}: ${name}`).toHaveProperty(name!);
    }
    expect(Object.values(declarations).every(value => value.length > 0)).toBe(true);
  }
});

// Compiled by code-oss:check:ui as well as exercised by Vitest. These assertions
// fail the type check if the API ever widens to arbitrary strings or numbers.
it('keeps token names and shorthand arguments closed at compile time', () => {
  const typeChecks = () => {
    // @ts-expect-error Unknown semantic role.
    void tokens.text.missing;
    // @ts-expect-error Unknown atomic step.
    void atoms.space[8];
    // @ts-expect-error Font sizes have T-shirt names, not pixel labels.
    void atoms.fontSize[13];
    // @ts-expect-error Radius sizes have T-shirt names, not pixel labels.
    void atoms.radius[4];
    // @ts-expect-error Host names remain closed after mapping the nested tree.
    void codeOss.button.missing;
    // @ts-expect-error Component tokens are grouped by component, not by color.
    void tokens.color.dropdown;
    // @ts-expect-error Spacing only accepts scale entries.
    space(8);
    // @ts-expect-error Unknown named size.
    space('huge');
    // @ts-expect-error Raw CSS is not a spacing token.
    space('8px');
    // @ts-expect-error CSS shorthands require at least one value.
    space();
    // @ts-expect-error CSS shorthands accept at most four values.
    space('none', 'xxs', 'xs', 'md', 'lg');
    // @ts-expect-error A preview theme must exist in the adapter.
    previewThemeStyles('unknown');
  };
  expect(typeChecks).toBeTypeOf('function');
});
