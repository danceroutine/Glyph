import type { ComponentChildren } from 'preact';

export function hasContent(children: ComponentChildren): boolean {
  return children !== undefined && children !== null && children !== false && children !== '';
}
