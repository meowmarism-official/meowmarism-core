# meowmarism core

The foundation of every meowmarism product. Design decisions are made once, here, and the products build on them.

| Product | Repository |
|---|---|
| meowmarism LITE | [meowmarism-lite](https://github.com/meowmarism-official/meowmarism-lite) |
| meowmarism PROFESSIONAL (PRO) | [meowmarism-professional](https://github.com/meowmarism-official/meowmarism-professional), planned |
| Website | [meowmarism-website](https://github.com/meowmarism-official/meowmarism-website) |

## What lives here

```
brand/     logo (colored and single color), server icon, ready-made PNGs (avatar, social preview, high resolution)
tokens/    colors, radii, navigation rail sizes and fonts as tokens.css and tokens.json
docs/      design rules, naming rules, the permission model and how products use core
scripts/   sync.js copies this core into a product
```

## How a product uses core

Products vendor core instead of depending on it at runtime. There is no build step and no submodule (release tarballs do not contain submodules, and the panel updates itself from a tarball):

```
node scripts/sync.js ../meowmarism-lite
```

This copies `brand/` and `tokens/` into the product's `panel/core/` and writes a `core.lock` with the core version and commit. The product commits both. See [docs/using-core.md](docs/using-core.md).

## Rules in short

- Names: **meowmarism LITE** and **meowmarism PROFESSIONAL**. Write PRO only where PROFESSIONAL is too long. The wordmark `meowmarism` is set in the brand font, the edition (`LITE`, `PRO`) is small, in capitals and in the accent color.
- Icons use a 24 grid, a 1.8 stroke, round caps and joins, and the current text color.
- Everything is self-hosted. No third-party fonts, scripts or images.

Licensed under the Meowmarism License 1.0, see [LICENSE](LICENSE). Contributions are governed by the [Contributor Agreement](CONTRIBUTOR-AGREEMENT.md).
