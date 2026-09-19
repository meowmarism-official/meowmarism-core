# Using core in a product

1. Change core, commit it, and bump `version` in `package.json` when the change matters to products.
2. From core run `node scripts/sync.js --all` (legal files) or `node scripts/sync.js --assets ../meowmarism-lite` (legal files plus brand and tokens).
3. Commit the copied files and `core.lock` in the product.

`core.lock` records the core version and commit that a product contains, for example:

```json
{ "core": "meowmarism-core", "version": "0.0.0", "commit": "abc1234...", "files": ["brand/logo.svg", "tokens/tokens.css"] }
```

Why not a submodule or a package: GitHub release tarballs do not include submodule contents, and the panel installs and updates itself from those tarballs. Vendored copies keep every release self-contained, and the products keep their promise of no dependencies and no build step.

## The legal files

`LICENSE`, `CONTRIBUTOR-AGREEMENT.md` and `CONTRIBUTORS.md` live in core only. Products and the website carry generated copies (a distribution must include the license). Change them in core, sync, and commit the copies. The `core.lock` of a product shows which core commit its legal files come from.
