import { expectTypeOf, it } from 'vitest';
import { atoms, space } from './atoms.ts';
import { codeOss, previewThemeStyles } from './codeOssTheme.ts';
import { tokens } from './tokens.ts';

it('keeps semantic roles, atomic sizes, and host names closed', () => {
  expectTypeOf(tokens.text).not.toHaveProperty('missing');
  expectTypeOf(atoms.space).not.toHaveProperty(8);
  expectTypeOf(atoms.fontSize).not.toHaveProperty(13);
  expectTypeOf(atoms.radius).not.toHaveProperty(4);
  expectTypeOf(codeOss.button).not.toHaveProperty('missing');
  expectTypeOf(tokens).toHaveProperty('dropdown');
  expectTypeOf(tokens).not.toHaveProperty('color');
});

it('accepts one to four named spacing tokens', () => {
  expectTypeOf(space).toBeCallableWith('none');
  expectTypeOf(space).toBeCallableWith('md', 'lg');
  expectTypeOf(space).toBeCallableWith('none', 'lg', 'lg');
  expectTypeOf(space).toBeCallableWith('hairline', 'xxs', 'xs', 'md');

  expectTypeOf<[8]>().not.toExtend<Parameters<typeof space>>();
  expectTypeOf<['huge']>().not.toExtend<Parameters<typeof space>>();
  expectTypeOf<['8px']>().not.toExtend<Parameters<typeof space>>();
  expectTypeOf<[]>().not.toExtend<Parameters<typeof space>>();
  expectTypeOf<['none', 'xxs', 'xs', 'md', 'lg']>().not.toExtend<Parameters<typeof space>>();
});

it('accepts only available preview themes', () => {
  expectTypeOf(previewThemeStyles).parameter(0).toEqualTypeOf<'dark' | 'light'>();
});
