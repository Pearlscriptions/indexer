# Consensus And Determinism

The indexer is useful only if independent operators reach the same result.

## Canonical Ordering

Pearlscriptions are ordered by:

1. block height
2. transaction index inside the block
3. transaction input index
4. inscription index inside the executed Taproot script leaf

The first valid Pearlscription is number `0`.

## Witness Extraction

The indexer reads the executed Taproot script-path leaf from the witness. It does not scan arbitrary witness stack items as inscriptions.

The envelope format is:

```text
OP_FALSE
OP_IF
<protocol marker>
<content type>
<empty separator>
<body chunk 1>
...
<body chunk n>
OP_ENDIF
```

Body chunks are concatenated into one logical payload. Chunks must respect Pearl script element limits.

## PRL-20

`PRL-20` is a metaprotocol on top of Pearlscriptions. The public state machine indexes:

- `deploy`
- `mint`
- `transfer`

`transfer` creates BRC-style transfer lots that can move between owners when
the transfer inscription UTXO moves.

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release.

## PRLS Launch Rule

PRLS is the first official PRL-20 token:

```text
max: 2100000000
lim: 100000
dec: 18
total mints: 21000
```

Every valid PRLS mint must pay `1 PRL` to the release-manifest fee recipient. Fee budget is consumed per mint envelope. A batch with 20 PRLS mint envelopes needs 20 matching PRL fee payments.

Generic non-PRLS Pearlscriptions and PRL-20 tokens remain indexable without a protocol-mandated PRLS launch mint fee.

## Digest

Operators should compare:

```text
GET /indexer/digest
```

Two honest indexers scanning the same chain tip with the same release manifest should return the same snapshot digest.
