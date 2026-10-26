import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { File, FileCode, FileText, Folder, Info, ScrollText } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { GlyphContextCandidateKind, type GlyphContextCandidate } from '#src/desktop/workbench/GlyphContextActions.js';

const styles = {
  name: css({ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0 }),
  filename: css({ flexShrink: 0, maxWidth: 'calc(100% - 54px)' }),
  path: css({
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: '1 2 auto',
    color: tokens.text.muted,
    direction: 'rtl',
    textAlign: 'left',
  }),
  tree: css({ padding: '8px 10px', maxHeight: 220, overflowY: 'auto' }),
  branch: css({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 26,
    color: tokens.text.muted,
    '& > svg': { flexShrink: 0 },
    '&:last-child': { color: tokens.dropdown.foreground },
  }),
  detail: css({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 10px',
    borderTop: tokens.dropdown.border,
    color: tokens.text.muted,
    '& > svg': { flexShrink: 0 },
  }),
};

function FileIcon({ path }: { readonly path: string }) {
  const Icon = /\.(?:[cm]?[jt]sx?|py|rs|go|swift|css|html|json|ya?ml|sh)$/iu.test(path)
    ? FileCode
    : /\.(?:md|txt|log)$/iu.test(path)
      ? FileText
      : File;
  return <Icon size={16} aria-hidden="true" />;
}

export interface GlyphContextPickerProps {
  readonly id: string;
  readonly mode: 'context' | 'rules';
  readonly candidates: readonly GlyphContextCandidate[];
  readonly selected: number;
  readonly searching: boolean;
  readonly disabled: boolean;
  readonly highlight: (index: number) => void;
  readonly choose: (candidate: GlyphContextCandidate) => void;
}

/** Context and rule suggestions retain editor focus; the adjacent preview is informational. */
export function GlyphContextPicker({
  id,
  mode,
  candidates,
  selected,
  searching,
  disabled,
  highlight,
  choose,
}: GlyphContextPickerProps) {
  const candidate = !searching ? candidates[selected] : undefined;
  const folder = candidate?.kind === GlyphContextCandidateKind.FOLDER;
  const rule = candidate?.kind === GlyphContextCandidateKind.RULE;
  const parts = candidate?.ancestry ?? candidate?.path.split('/').filter(Boolean) ?? [];
  return (
    <Dropdown
      id={id}
      label={mode === 'rules' ? 'Rules to invoke' : 'Files and folders to attach'}
      heading={mode === 'rules' ? 'Rules' : 'Files & Folders'}
      items={candidates}
      itemKey={item => item.uri}
      itemLabel={item => item.path}
      activeIndex={selected}
      selectedIndex={selected}
      highlight={highlight}
      choose={choose}
      disabled={disabled}
      busy={searching}
      busyMessage={mode === 'rules' ? 'Searching rules…' : 'Searching files…'}
      emptyMessage={mode === 'rules' ? 'No matching rules' : 'No matching files'}
      width={320}
      inset={12}
      offset={-8}
      constrainToAnchor
      renderItem={file => {
        const isFolder = file.kind === GlyphContextCandidateKind.FOLDER;
        const path = file.path.replace(/\/$/u, '');
        const slash = path.lastIndexOf('/');
        const name = file.name ?? path.slice(slash + 1);
        const directory = isFolder ? file.path : path.slice(0, slash + 1);
        return (
          <>
            {file.kind === GlyphContextCandidateKind.RULE ? (
              <ScrollText size={16} aria-hidden="true" />
            ) : isFolder ? (
              <Folder size={16} aria-hidden="true" />
            ) : (
              <FileIcon path={file.path} />
            )}
            <span class={`${styles.name} ${styles.filename}`}>{name}</span>
            {(file.detail || directory) && (
              <span class={styles.path}>
                <bdi dir="ltr">{file.detail ?? directory}</bdi>
              </span>
            )}
          </>
        );
      }}
      preview={
        candidate && (
          <>
            <div class={styles.tree}>
              {parts.map((part, index) => (
                <div key={index} class={styles.branch} style={{ paddingLeft: Math.min(index, 6) * 16 }}>
                  {rule ? (
                    <ScrollText size={16} aria-hidden="true" />
                  ) : index === parts.length - 1 && !folder ? (
                    <FileIcon path={candidate.path} />
                  ) : (
                    <Folder size={16} aria-hidden="true" />
                  )}
                  <span class={styles.name}>{part}</span>
                </div>
              ))}
            </div>
            {folder && (
              <div class={styles.detail}>
                <Info size={14} aria-hidden="true" />
                <span>Tree outline</span>
              </div>
            )}
          </>
        )
      }
    />
  );
}
