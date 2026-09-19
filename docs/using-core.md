# Using core in a product

1. Change core, commit it, and bump `version` in `package.json` when the change matters to products.
2. In the product run `node ../meowmarism-core/scripts/sync.js .` (or pass the product folder from core).
3. Commit `panel/core/` and `core.lock` in the product.

`core.lock` records the core version and commit that a product contains, for example:

```json
{ "core": "meowmarism-core", "version": "0.0.0", "commit": "abc1234...", "files": ["brand/logo.svg", "tokens/tokens.css"] }
```

Why not a submodule or a package: GitHub release tarballs do not include submodule contents, and the panel installs and updates itself from those tarballs. Vendored copies keep every release self-contained, and the products keep their promise of no dependencies and no build step.
