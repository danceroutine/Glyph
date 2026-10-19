import { atoms } from './atoms.ts';

export type PreviewTheme = 'dark' | 'light';

interface ThemeToken {
  readonly kind: 'token';
  readonly property: `--vscode-${string}`;
  readonly reference: string;
  readonly values: Readonly<Record<PreviewTheme, string>>;
}

interface ThemeGroup {
  readonly [name: string]: ThemeToken | ThemeGroup;
}

type References<T> = { readonly [K in keyof T]: T[K] extends ThemeToken ? string : References<T[K]> };

/** Native dotted IDs are serialized only at this boundary. */
function hostToken(id: string, dark: string, light: string, fallback?: ThemeToken | string): ThemeToken {
  const property = `--vscode-${id.replaceAll('.', '-')}` as const;
  const fallbackValue = typeof fallback === 'string' ? fallback : fallback?.reference;
  return {
    kind: 'token',
    property,
    reference: `var(${property}${fallbackValue === undefined ? '' : `, ${fallbackValue}`})`,
    values: { dark, light },
  };
}

const palette = atoms.color;
const foreground = hostToken('foreground', palette.neutral[250], palette.neutral[650]);
const panelBorder = hostToken('panel.border', palette.neutral[750], palette.neutral[150]);
const inputBorder = hostToken('input.border', palette.neutral[600], palette.neutral[200], palette.transparent);

/** Atomic colors acquire their native theme roles here, organized by component. */
const definitions = {
  foreground,
  descriptionForeground: hostToken('descriptionForeground', palette.neutral[400], palette.neutral[650]),
  errorForeground: hostToken('errorForeground', palette.red[350], palette.red[350]),
  editorWarning: {
    foreground: hostToken('editorWarning.foreground', palette.yellow[500], palette.yellow[600], palette.yellow[600]),
  },
  sideBar: { background: hostToken('sideBar.background', palette.neutral[900], palette.neutral[50]) },
  editor: {
    background: hostToken('editor.background', palette.neutral[800], palette.neutral[0]),
    font: {
      family: hostToken('editor.font.family', atoms.fontFamily.mono, atoms.fontFamily.mono, atoms.fontFamily.mono),
    },
  },
  panel: { border: panelBorder },
  focusBorder: hostToken('focusBorder', palette.blue[400], palette.blue[650]),
  input: {
    foreground: hostToken('input.foreground', palette.neutral[250], palette.neutral[650]),
    background: hostToken('input.background', palette.neutral[700], palette.neutral[0]),
    border: inputBorder,
    strongBorder: hostToken('input.border', inputBorder.values.dark, inputBorder.values.light, panelBorder),
  },
  dropdown: {
    foreground: hostToken('dropdown.foreground', palette.neutral[250], palette.neutral[650], foreground),
    background: hostToken('dropdown.background', palette.neutral[700], palette.neutral[0]),
    border: hostToken('dropdown.border', palette.neutral[600], palette.neutral[200], palette.transparent),
  },
  toolbar: { hoverBackground: hostToken('toolbar.hoverBackground', palette.slateAlpha[31], palette.neutralAlpha[31]) },
  list: {
    hoverBackground: hostToken('list.hoverBackground', palette.slate[800], palette.neutral[75]),
    activeSelectionBackground: hostToken('list.activeSelectionBackground', palette.blue[900], palette.neutral[100]),
    activeSelectionForeground: hostToken('list.activeSelectionForeground', palette.neutral[0], palette.neutral[1000]),
  },
  button: {
    background: hostToken('button.background', palette.blue[400], palette.blue[650]),
    foreground: hostToken('button.foreground', palette.neutral[0], palette.neutral[0]),
    hoverBackground: hostToken('button.hoverBackground', palette.blue[500], palette.blue[700]),
    secondaryBackground: hostToken('button.secondaryBackground', palette.transparent, palette.neutral[150]),
    secondaryForeground: hostToken('button.secondaryForeground', palette.neutral[250], palette.neutral[650]),
    secondaryHoverBackground: hostToken('button.secondaryHoverBackground', palette.neutral[750], palette.neutral[250]),
  },
  review: {
    keepBackground: hostToken('testing.runAction', palette.green[450], palette.green[450]),
    keepForeground: hostToken('button.foreground', palette.neutral[0], palette.neutral[0]),
  },
  context: {
    fileForeground: hostToken('textLink.foreground', palette.blue[300], palette.blue[650]),
    skillForeground: hostToken(
      'editorWarning.foreground',
      palette.yellow[500],
      palette.yellow[600],
      palette.yellow[500],
    ),
  },
  diff: {
    renamed: hostToken('gitDecoration.renamedResourceForeground', palette.green[450], palette.green[750]),
    added: hostToken('gitDecoration.addedResourceForeground', palette.green[425], palette.green[650]),
    removed: hostToken('gitDecoration.deletedResourceForeground', palette.red[600], palette.red[750]),
  },
  widget: { shadow: hostToken('widget.shadow', palette.blackAlpha[36], palette.blackAlpha[16]) },
  progressBar: { background: hostToken('progressBar.background', palette.blue[400], palette.blue[650]) },
  font: {
    family: hostToken('font.family', atoms.fontFamily.sans, atoms.fontFamily.sans, atoms.fontFamily.sans),
    size: hostToken('font.size', `${atoms.fontSize.md}px`, `${atoms.fontSize.md}px`, `${atoms.fontSize.md}px`),
  },
} as const satisfies ThemeGroup;

function isToken(value: ThemeToken | ThemeGroup): value is ThemeToken {
  return value.kind === 'token';
}

function references<T extends ThemeGroup>(group: T): References<T> {
  // Object.fromEntries loses key information; the traversal preserves every
  // branch and replaces only token leaves, matching References<T>.
  return Object.fromEntries(
    Object.entries(group).map(([name, value]) => [name, isToken(value) ? value.reference : references(value)]),
  ) as References<T>;
}

/** Typed native vocabulary. Components consume tokens.ts instead. */
export const codeOss = references(definitions);

/** Preview-only declarations. Native panes inherit variables from Code OSS. */
export function previewThemeStyles(theme: PreviewTheme): Record<`--vscode-${string}`, string> {
  const declarations: Record<`--vscode-${string}`, string> = {};
  const visit = (group: ThemeGroup) => {
    for (const value of Object.values(group)) {
      if (isToken(value)) declarations[value.property] = value.values[theme];
      else visit(value);
    }
  };
  visit(definitions);
  return declarations;
}
