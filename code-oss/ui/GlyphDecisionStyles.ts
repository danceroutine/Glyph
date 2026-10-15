import { css } from './emotion.ts';

export const decisionStyles = {
  card: css({
    border: '1px solid var(--vscode-panel-border, #555)',
    borderRadius: 12,
    background: 'var(--vscode-sideBar-background)',
    color: 'var(--vscode-foreground)',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    minWidth: 0,
    '& button, & input, & textarea': { font: 'inherit' },
    '& button:focus-visible, & input:focus-visible, & textarea:focus-visible': {
      outline: '1px solid var(--vscode-focusBorder)',
      outlineOffset: 2,
    },
    '& button:disabled': { opacity: 0.5, cursor: 'default' },
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    '& h3': { margin: 0, fontSize: 13, fontWeight: 600, flex: 1 },
  }),
  actions: css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, padding: '12px 14px' }),
  button: css({
    border: 0,
    borderRadius: 5,
    padding: '6px 10px',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--vscode-descriptionForeground)',
    ':hover': { background: 'var(--vscode-toolbar-hoverBackground)' },
  }),
  primary: css({
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    ':hover': { background: 'var(--vscode-button-hoverBackground)' },
  }),
  secondary: css({
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    ':hover': { background: 'var(--vscode-button-secondaryHoverBackground)' },
  }),
  detail: css({ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }),
  error: css({ padding: '0 14px 12px', color: 'var(--vscode-errorForeground)' }),
};
