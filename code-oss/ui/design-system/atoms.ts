/** Theme-independent values. Components use the semantic roles in tokens.ts. */
export const atoms = {
  color: {
    neutral: {
      0: '#ffffff',
      50: '#f8f8f8',
      100: '#e8e8e8',
      150: '#e5e5e5',
      200: '#cecece',
      250: '#cccccc',
      300: '#b8b8b8',
      400: '#9d9d9d',
      500: '#616161',
      600: '#3c3c3c',
      650: '#3b3b3b',
      700: '#313131',
      750: '#2b2b2b',
      800: '#1f1f1f',
      900: '#181818',
      1000: '#000000',
    },
    blue: { 400: '#0078d4', 500: '#026ec1', 600: '#0060c0', 650: '#005fb8', 700: '#0258a8', 900: '#04395e' },
    red: { 300: '#f48771', 700: '#a1260d' },
    yellow: { 500: '#cca700', 700: '#a18a36' },
    slate: { 500: '#5a5d5e', 800: '#2a2d2e' },
    blackAlpha: { 16: '#00000029', 36: '#0000005c' },
    neutralAlpha: { 31: '#b8b8b850' },
    slateAlpha: { 31: '#5a5d5e50' },
    transparent: 'transparent',
  },
  space: { none: 0, hairline: 1, xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, xxxl: 32 },
  radius: { none: 0, xs: 3, sm: 4, md: 6, lg: 12, round: '50%' },
  fontSize: { xs: 11, sm: 12, md: 13, lg: 14, xl: 16 },
  fontWeight: { regular: 400, medium: 500, semibold: 600 },
  fontFamily: { sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", mono: 'monospace' },
  lineHeight: { normal: 1.5 },
  borderWidth: { thin: 1 },
  opacity: { disabled: 0.5 },
} as const;

export type Space = keyof typeof atoms.space;

/** CSS shorthand with one to four named sizes; never emits unitless lengths. */
export function space(
  ...values: [Space] | [Space, Space] | [Space, Space, Space] | [Space, Space, Space, Space]
): string {
  return values.map(value => `${atoms.space[value]}px`).join(' ');
}
