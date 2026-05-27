## Summary

What changed and why?

## Verification

- [ ] `npm run verify`
- [ ] Added or updated fixture coverage when chain-derived state changes
- [ ] Compared digest output when state derivation changes

## Safety

- [ ] No `.env` files, secrets, wallet seeds, private keys, RPC passwords, or API tokens are committed
- [ ] The public API remains read-only
- [ ] No signing, faucet, mining, broadcast, marketplace, trading, orderbook, seller-package, or settlement route was added

## Digest impact

Does this change alter canonical inscription numbering, PRL-20 balances, PRLS mint accounting, transfer-lot state, or snapshot digest?

If yes, explain exactly why.
