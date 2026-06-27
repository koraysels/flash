/**
 * Design tokens for Flash. The UI keeps its Swiss/monospace identity, but neutrals
 * are tinted off pure #000/#fff (asphalt-cool ink, faint-warm paper) so the palette
 * reads intentional rather than harsh. Overriding `black`/`white` means every
 * existing `border-black` / `bg-white` / `text-white` class inherits the tint with
 * no component churn. `ink`/`paper`/`danger`/`warn` are the named roles to reach for
 * in new/refactored code.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tinted neutrals (replace pure black/white app-wide)
        black: '#1b1d22',   // ink — dark asphalt, slight cool cast
        white: '#fcfbf9',   // paper — near-white, faint warm
        ink: '#1b1d22',
        paper: '#fcfbf9',
        // Semantic roles
        danger: '#dc2626',  // speeders / destructive
        warn: '#d9810a',    // not-calibrated / caution
        ok: '#15803d',      // healthy / confirmed
      },
      fontFamily: {
        mono: ['ui-monospace', 'Cascadia Code', 'Source Code Pro', 'Menlo', 'Consolas', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
