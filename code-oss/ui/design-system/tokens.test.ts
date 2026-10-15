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
