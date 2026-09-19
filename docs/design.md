# Design rules

## Look
- Dark first. Surfaces `--bg`, `--panel`, `--panel2`, borders `--line`. One accent color, pink `#ff6fc4`, used for the active item, the logo and small highlights. Status uses green, yellow and red only for status.
- Radii: 6 px for controls and cards, 10 px for dialogs.
- No native browser dialogs (`alert`, `confirm`, `prompt`). Destructive actions use a custom dialog with a danger-styled button; irreversible deletes also ask to type the name.
- Nothing loads from a third party. Fonts, icons and scripts are served by the app itself.

## Navigation rail
- 56 px wide when closed, 208 px when hovered. Every icon is centered in the closed rail (18 px icons, 18.5 px side padding), labels fade in when it opens.
- The logo sits at the top of the rail. When something needs attention (an update) a small yellow dot sits on the left of the icon.

## Icons
- 24 grid, stroke 1.8, round caps and joins, `currentColor`, no fill. The logo follows the same rules.

## Logo
- `brand/logo.svg` is the colored version, `brand/logo-mono.svg` uses `currentColor`. Two whiskers per side, sharp notch at the top and the bottom, all corners are true circular fillets.

## Wordmark
- The text `meowmarism` uses the brand font (`--font-brand`), and only that text. The edition (`LITE`, `PRO`) is small, uppercase, letter-spaced and in the accent color. The brand font is not chosen yet; until then the UI font is used.
