# Contributing

Thanks for helping make Pearlscriptions easier to verify independently.

This repository is protocol infrastructure, so correctness matters more than
feature count. Small, well-tested changes are preferred.

## Project Rules

- Keep this package read-only by default.
- Do not add wallet generation, signing, seed storage, faucet, or mining utilities.
- Do not add marketplace, orderbook, trading, seller-package, or settlement routes to the public indexer package.
- Keep PRLS tokenomics fixed: max `2100000000`, mint amount `100000`, decimals `18`, total mints `21000`.
- Keep the official PRLS launch fee rule: `1 PRL` per PRLS mint to the public fee recipient in the release manifest.
- Preserve canonical inscription numbering.

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release.

## Development

```bash
npm install
npm run verify
```

For changes that affect chain-derived state, add or update fixture tests and compare `/indexer/digest` before and after the change.

## Good First Contributions

- improve operator documentation
- add fixtures for edge-case witness parsing
- add read-only API tests
- improve digest comparison tooling
- tighten Postgres query coverage

## Pull Request Checklist

- Tests pass with `npm run verify`.
- No secrets or `.env` files are committed.
- New API routes are read-only `GET` routes.
- Protocol changes update docs in `docs/`.
- Any digest-changing change is explained clearly.
