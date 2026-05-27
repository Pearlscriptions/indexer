# @pearlscriptions/prl20-core

Protocol parser and state machine for PRL-20.

This package is intentionally small and deterministic. It parses PRL-20 JSON
payloads, validates operation fields, applies PRLS launch rules, and derives
token balances from an ordered inscription stream.

## Commands

```bash
npm run test --workspace @pearlscriptions/prl20-core
```

## Invariants

- `PRLS` tokenomics are fixed: max `2100000000`, limit `100000`, decimals `18`.
- A valid PRLS mint credits exactly `100000` PRLS.
- PRLS mints require one `1 PRL` fee payment per credited mint.
- Generic non-PRLS tokens are indexable without a protocol-mandated PRLS launch mint fee.
- Transfer lots reserve balance until they are settled by an indexed spend.
