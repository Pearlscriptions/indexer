# PRL-20 v0 Spec

PRL-20 is a fungible-token metaprotocol built on top of Pearlscriptions. Pearl
consensus validates blocks and transactions; PRL-20 validity is derived by
indexers from ordered Pearlscription envelopes.

## Base Carrier

PRL-20 messages are Pearlscriptions with:

```text
marker:       prl-20
content-type: application/json
```

Envelope shape:

```text
OP_FALSE
OP_IF
  "prl-20"
  "application/json"
  0x00
  <json-bytes, split into <=520 byte pushes when needed>
OP_ENDIF
```

The envelope is embedded in an executed Taproot script-path leaf. Indexers parse
only that executed leaf and ignore envelope-like bytes elsewhere in the witness.

## Canonical Ordering

PRL-20 operations inherit Pearlscription ordering:

1. block height
2. transaction index
3. input/reveal order
4. envelope order inside the executed leaf

Mempool state is provisional.

## PRLS Launch Token

| Field | Value |
| --- | --- |
| Protocol | `prl-20` |
| Token | Pearlscriptions |
| Canonical ticker | `prls` |
| Max supply | `2100000000` |
| Mint amount | `100000` |
| Total mints | `21000` |
| Decimals | `18` |
| Premine | none |
| Mint model | public fair mint |
| Required launch fee | `1 PRL` per credited mint |

Deploy:

```json
{"p":"prl-20","op":"deploy","tick":"prls","max":"2100000000","lim":"100000","dec":"18"}
```

Mint:

```json
{"p":"prl-20","op":"mint","tick":"prls","amt":"100000"}
```

Transfer lot:

```json
{"p":"prl-20","op":"transfer","tick":"prls","amt":"100000"}
```

## Generic PRL-20 Tokens

The parser also supports permissionless non-PRLS tickers.

Deploy:

```json
{"p":"prl-20","op":"deploy","tick":"pearl","max":"21000000","lim":"1000","dec":"8"}
```

Mint:

```json
{"p":"prl-20","op":"mint","tick":"pearl","amt":"1000"}
```

Generic non-PRLS tokens do not require a protocol-mandated PRLS launch mint fee.

## JSON Rules

All PRL-20 payloads:

- must be valid JSON objects
- must not contain duplicate top-level fields
- must include string fields `p`, `op`, and `tick`
- must use `p = "prl-20"`
- must canonicalize ticker matching to lowercase
- must use tickers of 1-16 ASCII letters or digits
- must encode token amounts and deploy numeric values as canonical
  non-negative integer strings without leading zeroes
- must reject negative numbers, empty numbers, leading zeros, fractional decimal
  notation, and malformed numeric strings
- `dec` is display metadata; it does not make on-chain amount fields fractional

Extra fields are invalid.

## Deploy Rules

- First valid deploy for a ticker wins.
- `max`, `lim`, and `dec` are required string fields.
- `dec` must be between `0` and `18`.
- For generic tickers, `max > 0`, `lim > 0`, and `lim <= max`.
- For `prls`, `max`, `lim`, and `dec` must exactly match the PRLS launch
  parameters above.

## Mint Rules

- Token must already have a valid deploy.
- `amt` is required and must be a string.
- For `prls`, `amt` must be exactly `"100000"`.
- For generic tickers, `amt > 0` and `amt <= lim`.
- Minted supply must not exceed `max`.
- PRLS mints stop after `21000` valid full mints.

## PRLS Fee Rule

The official PRLS launch requires one `1 PRL` payment per credited PRLS mint.

The mint reveal transaction must pay at least `100000000` grains to the PRLS fee
recipient configured by the release manifest. Fee value is consumed per mint. A
single transaction with `N` valid PRLS mint envelopes needs at least `N PRL` of
matched fee output value to credit all `N` mints.

Missing or insufficient payment makes the PRLS mint invalid for PRL-20 state,
even if the underlying Pearl transaction and Pearlscription carrier are valid.

This fee rule is specific to the official `prls` launch token. It is not a
general Pearlscriptions fee requirement.

## Transfer-Lot Rules

A PRL-20 transfer inscription reserves balance into a transferable lot:

```json
{"p":"prl-20","op":"transfer","tick":"prls","amt":"100000"}
```

Rules:

- The token must be deployed.
- The sender must have enough available balance.
- The transfer inscription debits available balance and creates a lot controlled
  by the transfer inscription UTXO.
- When that UTXO moves to a new owner, the lot amount is credited to the new
  owner in PRL-20 state.
- Plain PRL coin movement without a PRL-20 operation does not move PRL-20
  balance.

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release.

## Batch Envelopes

An executed leaf may contain multiple valid Pearlscription envelopes.

- Pure PRL-20 mint batches may share one owner output so batch mints consolidate
  to the same recipient.
- Generic or mixed Pearlscription batches should map envelope order to matching
  owner outputs so each non-token inscription remains independently ownable.
- PRLS batch mints must still satisfy the fee rule per credited mint.

## Determinism

Any change that affects parsing, operation validity, ownership, balances, or
canonical numbering changes the snapshot digest and must be treated as a protocol
change.
