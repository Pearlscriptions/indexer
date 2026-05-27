# Security Policy

## Scope

This repository is a read-only Pearlscriptions and PRL-20 indexer. It should not contain wallet software, seed phrase handling, private keys, faucet tools, block generation tools, marketplace APIs, or settlement mutation routes.

The official Pearlscriptions marketplace is an application layer built on top of transfer lots. It is not part of this public indexer release.

## Secrets

Never commit:

- wallet seeds or mnemonic phrases
- private keys, WIFs, xprv values, or signing material
- Pearl RPC passwords
- database passwords
- API tokens
- production `.env` files

Use `.env.example` only as a placeholder template. Operators should keep real configuration outside git and restrict filesystem permissions on the host.

## Reporting

Use GitHub Security Advisories when available, or contact `pearlscriptions@proton.me`.

Please include:

- affected version or commit
- affected route, CLI command, or protocol path
- reproduction steps
- whether a mismatch changes inscription numbering, PRL-20 balances, PRLS mint accounting, transfer-lot state, or location tracking

## High-impact Issues

Treat these as critical:

- a deterministic consensus mismatch between honest indexers
- accepting malformed Taproot witness data as a valid Pearlscription
- crediting a PRLS mint without the required 1 PRL fee
- leaking config secrets in API responses or logs
- enabling transaction broadcast, marketplace APIs, or settlement flows in this read-only package
