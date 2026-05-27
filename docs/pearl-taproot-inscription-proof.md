# Pearl Taproot Inscription Proof Summary

Pearlscriptions use a Taproot script-path reveal. The executed tapscript leaf contains a spend condition followed by a data envelope:

```text
<x-only-owner-pubkey>
OP_CHECKSIG
OP_FALSE
OP_IF
  "<marker>"
  "<content-type>"
  0x00
  <body-bytes>
OP_ENDIF
```

For PRL-20, the marker is `prl-20`, the content type is `application/json`, and the body is a strict JSON object such as:

```json
{"p":"prl-20","op":"mint","tick":"prls","amt":"100000"}
```

## Verified Behavior

Project fixtures and tests preserve Pearl simnet evidence for:

- single PRL-20 mint reveal acceptance with `testmempoolaccept allowed: true`
- accepted commit/reveal transactions on simnet
- confirmed reveal parsing from serialized witness bytes
- PRLS deploy and `1 PRL` fee mint fixtures
- multi-envelope reveal parsing
- generic Pearlscription file/text envelopes
- PRL-20 transfer lots
- multi-transfer-lot ownership proof on simnet
- 20-envelope PRL-20 batch mint acceptance proof

This public repo includes representative no-secret fixtures and tests so operators can verify parser and indexer behavior without relying on private infrastructure.

## Indexer Rules

- Parse only the executed Taproot script-path leaf immediately before a plausible control block.
- Ignore envelope-like bytes in other witness stack items.
- Require non-empty printable marker and content type fields.
- Index every valid envelope in the executed leaf in deterministic script order.
- Assign canonical inscription numbers by block height, transaction index, input index, and envelope order.
- Apply PRL-20 validity rules as a derived layer on top of Pearlscriptions.
- Treat PRLS mint fee validation as a launch-specific PRL-20 rule.

## Security Notes

This document intentionally avoids private hostnames, IP addresses, ports, local file paths, RPC credentials, wallet seeds, and full operator command transcripts. Operators should run their own Pearl full node, configure RPC credentials outside the repository, and compare `/indexer/digest` with other trusted indexers before relying on public state.
