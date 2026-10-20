# Changelog

Versions follow [semantic versioning](https://semver.org): a major version may
break existing code, and its entry says what to change.

## 1.0.0

The first version.

- **AndonView**: `set(tileId, value, { at, series, lane })`, `set({ tileId: value })`,
  `replace(document)`, `flush()`, `close()`, `AndonView.fromEnv()`, `onSent` and
  `onError`. The rules are those of the Node-RED package 1.2.1: what a value does to
  its tile, the configurator's validation, when an upload goes out, the heartbeat,
  `notify` by status fingerprint, the answers of the relay.
- **@smartrsolutions/andon-client/runtime**: the parts AndonView is built from, for
  a caller with a front of its own.
