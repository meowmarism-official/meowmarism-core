# meowmarism core

The foundation of every meowmarism product. Design decisions are made once, here, and the products build on them.

| Product | Repository |
|---|---|
| meowmarism LITE | [meowmarism-lite](https://github.com/meowmarism-official/meowmarism-lite) |
| meowmarism PROFESSIONAL (PRO) | [meowmarism-professional](https://github.com/meowmarism-official/meowmarism-professional) |
| Website | [meowmarism-website](https://github.com/meowmarism-official/meowmarism-website) |

## What lives here

```
brand/     logo (colored and single color), server icon, ready-made PNGs (avatar, social preview, high resolution)
tokens/    colors, radii, navigation rail sizes and fonts as tokens.css and tokens.json
modules/   backend code both products share: users and permissions, files, backups, Modrinth, mods, scheduler,
           metrics, players, access lists, properties, updater, login limiter, safety checks, startup timer, system info
ui/        the pages both products show: panel and instance frame, Automation, Players, Files, Backups, Mods, Console,
           Settings, Events, System, login, command palette, charts, plus their styles
lang/      German, French and Spanish dictionaries
docs/      design rules, naming rules, the permission model and how products use core
test/      tests for the modules (node --test)
scripts/   sync.js copies the legal files and the code above into the other repositories
```

The version in `package.json` counts breaking changes of what products depend on. `core.lock` in every product records the exact core commit that was copied, and the product tests check that copy against that commit and run the core tests too.

## One place for the legal files

`LICENSE`, `WEBSITE-LICENSE.md`, `BRAND-POLICY.md`, `CONTRIBUTOR-AGREEMENT.md` and `CONTRIBUTORS.md` are edited **only here**. Every distribution has to contain a complete copy of the license, so the other repositories carry copies, but those copies are generated:

```
node scripts/sync.js --all
```

This copies the three legal files into every meowmarism repository next to this one that already has commits (LITE, website, and PROFESSIONAL once it exists) and writes a `core.lock` with the core version and commit. Never edit the copies by hand.

## Design assets in products

Brand and tokens are vendored the same way when a product uses them (no build step, no submodule; release tarballs do not contain submodules and the panel updates itself from a tarball):

```
node scripts/sync.js --assets ../meowmarism-lite
```

This additionally copies `brand/`, `tokens/`, `modules/`, `ui/` and `lang/` into `panel/core/`. See [docs/using-core.md](docs/using-core.md).

## Rules in short

- Names: **meowmarism LITE** and **meowmarism PROFESSIONAL**. Write PRO only where PROFESSIONAL is too long. The wordmark `meowmarism` is set in the brand font, the edition (`LITE`, `PRO`) is small, in capitals and in the accent color.
- Icons use a 24 grid, a 1.8 stroke, round caps and joins, and the current text color.
- Everything is self-hosted. No third-party fonts, scripts or images.

Licensed under the Meowmarism License 1.0, see [LICENSE](LICENSE). Contributions are governed by the [Contributor Agreement](CONTRIBUTOR-AGREEMENT.md).
