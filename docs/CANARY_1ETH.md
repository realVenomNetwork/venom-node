# 1 ETH Canary Notes

This document records operator settings that are useful for a small, solo
testnet canary. These settings are not production defaults.

## Solo P2P Reachability

Operators on residential or locked-down networks may not have a public
multiaddr that other peers can dial. For a solo canary where P2P reachability
is not part of the test objective, set:

```env
VENOM_ALLOW_PRIVATE_MULTIADDR=true
```

The node will register its private libp2p multiaddr and log a repeated warning.
Do not use this for production pilots. Production operators should configure
`PUBLIC_MULTIADDR` or port forwarding so other oracles can dial the node.
