# Andon client for Node.js

Send values from Node.js to [Andon](https://andon.app), the app for iPhone and iPad
that shows your data as tiles and widgets. Everything is end-to-end encrypted: the
content key stays in your process, and only the devices you paired can read what
you send.

**Get the app:** [Andon on the App Store](https://apps.apple.com/app/id6819064723).

## Getting started

1. **Design** your tiles in the [Andon configurator](https://andon.app/en/configurator)
   and create the view there. Download the `.env` and the document, `view.json`:
   it is the template your values fill.
2. **Pair** your iPhone or iPad: scan the configurator's QR code with the
   [Andon app](https://apps.apple.com/app/id6819064723).
3. **Install** this package: `npm install @smartrsolutions/andon-client`.
4. **Send values**, by tile ID:

```ts
import { readFileSync } from 'node:fs';
import { AndonView } from '@smartrsolutions/andon-client';

// ANDON_VIEW, ANDON_WRITE_SECRET, ANDON_CONTENT_KEY, ANDON_KEY_VERSION:
// the names the .env from the configurator uses.
const view = AndonView.fromEnv({
  template: readFileSync('view.json', 'utf8'),
});

view.set('t_oee', 79.3);                           // one tile
view.set({ t_oee: 79.3, t_shift: 580 });           // several at once
view.set('t_takt', 31.5, { at: new Date() });      // appended to a series

process.on('SIGTERM', async () => {
  await view.close();                              // sends what is still pending
  process.exit(0);
});
```

The package collects, checks, encrypts and uploads. It is written in TypeScript
and ships its types; from CommonJS, `require('@smartrsolutions/andon-client')`.
With Node-RED, use [`@smartrsolutions/node-red-andon`](https://www.npmjs.com/package/@smartrsolutions/node-red-andon)
instead.

## Values

`set(tileId, value, options)` gives one tile a value. What the value does depends
on the tile:

| Tile | Value | Effect |
|---|---|---|
| label | number or text | replaces the value |
| gauge, progress, donut | number | replaces the value |
| line, bar over time | number | appended to the series, now or at `at`; `series` picks the series |
| line, bar over time | array of `[timestamp, value]` pairs | replaces the series; `series` picks which |
| line, bar over time | `{series: [{name, samples}]}` | replaces every series |
| line, bar over time | `{series: [{name, start, stepSec, points}]}` | replaces every series: a point every `stepSec` from `start` |
| bar with categories, pie, donut | array of numbers, one per category | replaces the values; `series` picks the series |
| bar with categories, pie, donut | `{categories, series: [{name, values}]}` | replaces categories and values together |
| bar with categories, one series | `{series: [{name, values, statuses}]}` | a verdict per bar: `ok`, `warning`, `critical` or `null` |
| table | array of rows, a row an array of cells | replaces the rows |
| table | array of `{cells, status}` | replaces the rows, with a status per row |
| timeline | state ID | starts a new segment, now or at `at`; `lane` picks the lane |
| timeline | `{from, to}` | moves the time axis; what lies before `from` is trimmed |
| any tile | object, e.g. `{value: 79.3, status: 'warning'}` | sets the named fields; `null` removes one |

The options are `at` (a `Date`, milliseconds or ISO 8601), `series` and `lane`
(names). Numbers may arrive as text (`"79.3"`), as MQTT and most PLCs deliver them.
Timestamps in values are ISO 8601 in UTC, as `Date.toISOString()` writes them.

`set({ tileId: value, ... }, options)` sets several tiles at once; each value takes
the same forms, and the call is taken or refused as a whole. Values set together go
out in the same upload.

`replace(document)` swaps in a whole view document, template included: for a source
that builds its tiles itself rather than filling those of a template.
`generatedAt` and `staleAfterSec` are set on upload.

A value that does not fit its tile throws `InputError`, one that would leave the
view invalid throws `ValidationError`; the message says what the tile takes, and the
view stays as it was. The first real value of a series or timeline lane replaces
the points the template came with: those are the configurator's start values.

## When it uploads

- A change goes out at most once per **interval** (`intervalSec`, 30 by default,
  10 at least). The first change after a quiet spell goes out at once.
- While values keep arriving, even unchanged ones, a heartbeat goes out after half
  the **stale** time (`staleAfterSec`, three intervals by default).
- When no value arrives, nothing is sent: the app then shows the view as stale,
  which is what it should show when your source has stopped.
- Devices are woken only when a tile's **status** changes (`notify: 'auto'`;
  `'always'` or `'never'`). Every wake-up costs battery on every paired device.

`flush()` sends a pending change now, `close()` sends what is pending and stops
every timer so the process can exit (`close({ flush: false })` drops it).

## Status

The status of a tile (`ok`, `warning`, `critical`) is your judgement: the app does
not compute it from the value. Send it with the value, or name the tile in
`deriveStatus` to have it derived from its bands.

## Options

```ts
new AndonView({
  view,             // vw_…, from the .env
  writeSecret,      // ws_…, from the .env
  contentKey,       // base64, from the .env
  keyVersion,       // from the .env, 1 by default
  template,         // the template: a view document or its JSON text
  intervalSec,      // 30
  staleAfterSec,    // three intervals
  notify,           // 'auto'
  window,           // { points: 60, ageSec: 0 }: how much of a series is kept
  deriveStatus,     // tile IDs whose status follows from their bands
  onSent,           // (report) => …, after every stored upload
  onError,          // ({ message, status, retryInSec }) => …; console.warn without it
});
```

`AndonView.fromEnv({ prefix, ...options })` reads the keys from the environment.
A prefix such as `ANDON_CLOUD_` replaces the leading `ANDON_` of every name, so
several views can share one environment.

After an upload failed, `onError` says when the next try is (`retryInSec`). A
rejected write secret or an unknown view stops the uploads until the next value:
trying again changes nothing until the `.env` is current.

## Security

- The content key never leaves your process. The write secret is sent only in the
  `Authorization` header of the upload, and neither appears in a report or an
  error message.
- The `.env` from the configurator also holds the invite secret. This package does
  not read it: a data source does not pair devices.

## Requirements

Node.js 18 or newer.

## Contributing

The package is developed in a private repository next to the Andon relay and its
specification; its GitHub repository is a public mirror that receives every release
as one commit. Issues are welcome there, or by mail to <support@andon.app>. Pull
requests cannot be merged in the mirror, because the next release would overwrite
them: a change we take arrives with the next release. Security problems: please
write to <support@andon.app> instead of opening a public issue.

## License

Copyright 2026 SMARTR.solutions. MIT License; the text is in the file `LICENSE` of
this package.
