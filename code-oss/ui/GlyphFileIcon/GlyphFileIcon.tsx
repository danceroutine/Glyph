import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { FileCode, FileText, FileJson } from 'lucide-preact';
import { css } from '#code-oss/ui/design-system/index.ts';

export const GlyphFileIcons = createContext<((path: string) => readonly string[]) | undefined>(undefined);
const icon = css({
  display: 'inline-block',
  width: 16,
  height: 16,
  flexShrink: 0,
  '&::before': { display: 'inline-block', width: 16, height: 16, fontSize: 16, backgroundSize: '16px' },
});
export function GlyphFileIcon({ path }: { readonly path: string }) {
  const resolve = useContext(GlyphFileIcons);
  if (resolve)
    return (
      <span class="file-icon-themable-tree show-file-icons" aria-hidden="true">
        <span class={`${icon} ${resolve(path).join(' ')}`} />
      </span>
    );
  const Icon = /\.json$/i.test(path) ? FileJson : /\.(md|txt|log)$/i.test(path) ? FileText : FileCode;
  return <Icon size={16} aria-hidden="true" />;
}
