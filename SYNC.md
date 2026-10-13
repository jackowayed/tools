# Baby-weight sync

The pilot syncs weigh-ins, deletions, birth date, and sex. Unit preference stays
on each device. There are no accounts and no end-to-end encryption. HTTPS
protects transport; the Worker and database can read synced health records.
A generated sync key grants read/write access. The server stores its SHA-256
hash, while the browser stores the key in IndexedDB for automatic reconnection.
Do not log Authorization headers or sync request/response bodies.

## Run locally

Use Node 22 or later:

```sh
npm ci
npm run db:local
npm run dev
```

Local development state lives in `../.tools-sync-state`, outside the static
asset directory, so SQLite writes do not trigger Wrangler’s asset watcher.

Open `http://localhost:8787/baby-weight.html`. Create sync on one browser profile,
copy its key, and connect from a second profile. Tabs within one profile share
local storage. Use HTTP localhost or HTTPS; WebCrypto and Web Locks require a
secure context. Serve the page with its adjacent JavaScript modules rather than
opening it with `file://`.

## Deploy

The checked-in database ID is a placeholder for local development. With a
Cloudflare identity authorized for this Worker and D1:

```sh
npx wrangler d1 create tools-baby-weight-sync
```

Put the returned database ID in `wrangler.jsonc` under `d1_databases`, keeping
`binding: "SYNC_DB"`. Then:

```sh
npx wrangler d1 migrations apply tools-baby-weight-sync --remote
npx wrangler deploy
```

The migration must be applied before clients can sync. The routes run in the
existing tools Worker; other tools and proxy routes retain their behavior.
`migrations`, tests, dependencies, and this document are excluded from static
assets. No remote database is created by installing dependencies or running tests.

## Local durability and migration

IndexedDB contains one bounded personal-log state record: entries, tombstones,
accepted settings and versions, pending operations, credential, cursor, and a
revision. Every mutation reads the latest record and commits the new state in a
strict-durability read/write transaction. IndexedDB serializes these transactions
across tabs. This single-record layout deliberately trades incremental-write
performance for simpler atomicity at the pilot's scale.

The UI renders a successful mutation only after commit. Failure leaves both the
previous state and outbox intact and reports that the change was not saved.
BroadcastChannel notifies other tabs to reread; becoming visible also refreshes.
A Web Lock reduces duplicate network work, but idempotency and transactions make
simultaneous sync loops safe without it.

The first open migrates existing `babyWeightLog` and `babyWeightSettings` once.
Valid legacy entry IDs are preserved; unsupported IDs receive UUIDs. Existing
localStorage keys remain as a backup and are never reread into an already
initialized database. They become stale after migration. Use the updated page
in all tabs; an already-open pre-sync version still writes the legacy store.
Browser storage clearing or eviction can remove local data and the sync key.
Keep a copy of the key; another connected device can also supply it.

Before first connection, the journal is local only. Creating sync uploads it,
including the current birth date and sex. Joining an existing dataset imports
entries/tombstones but adopts the remote birth date and sex. Setting edits made
while authentication is in flight remain pending. Once linked, the browser
cannot switch datasets. Disconnect retains the association and journals edits
for a later reconnect; an already-sent request can still finish. Reconnect uses
the original key. There is no key recovery or rotation in v1.

Offline changes work in a loaded page and survive reload in IndexedDB. This
pilot does not install a service worker: loading the page itself without a
network connection depends on the browser's HTTP cache.

## Protocol and convergence

All bodies have `v: 1`. API responses use `Cache-Control: no-store`.

- `POST /api/sync/create` returns `{v, datasetId, key}`. Pull never creates data.
- `POST /api/sync/append`, authenticated with `Authorization: Bearer <key>`,
  accepts `{v, ops}` and returns `{v, assigned: [{opId, seq}]}`.
- `POST /api/sync/pull`, with the same authentication, accepts `{v, afterSeq}`
  and returns `{v, records: [{seq, op}], cursor, hasMore}` in ascending order.

`sync-protocol.js` validates and canonicalizes immutable JSON operations:
`add-entry`, `delete-entry`, and per-field `set-setting`. IDs are UUIDs for new
records. No client timestamp is used for conflict resolution.

D1's global AUTOINCREMENT sequence may have gaps. A fixed D1 batch inserts
operations and reads their assignments in one transaction. SQL triggers reject
operation-ID reuse with different canonical content, entry-ID reuse with
different measurements, and writes beyond the quota. Only the specific
`(dataset_id, op_id)` duplicate constraint is ignored. Identical retries return
the original sequence. A conflict rolls back the whole append batch. Same-ID,
same-content entries imported under different operation IDs still render once.

A tombstone hides an entry permanently, regardless of arrival order. Two
independent adds with different IDs both survive. Settings merge independently
by the highest accepted server sequence; an offline setting can win when it
reconnects. Pending local settings overlay accepted settings until acknowledged.
There is no edit operation: delete and add a corrected weigh-in.

Each cycle pulls, pushes up to ten batches, then pulls again. Applying a page
and advancing its cursor is one local transaction. Acknowledgements remove only
the named operations and never advance the pull cursor. Overlapping pages are
safe and cannot decrease the cursor. Successful acknowledgements also fold in
accepted setting versions so delayed older pages cannot revert them. Invalid
responses/conflicts stop that cycle and preserve pending work.

The page retries on local mutation, online/visible events, and while visible
(pending work checked every five seconds; otherwise pulls about every thirty
seconds). Failures use exponential backoff with jitter up to approximately six
minutes. “Sync now” bypasses backoff. Background tabs may be throttled by the
browser.

## Limits and retention

- 32 KiB maximum request body, 50 operations per append, 100 records per pull.
- 10,000 accepted operations per dataset, enforced transactionally. Retries are
  accepted at the limit; new operations, including deletions, are retained
  locally with a quota error until an operator addresses capacity.
- Per-IP fixed windows: five dataset creations/hour and 120 authenticated-route
  attempts/minute. D1 retains only recent hashed-IP counters, cleaned on requests.
  These are basic pilot abuse controls, not protection against distributed abuse.
- Deletes hide records through tombstones; historical plaintext stays in D1.
  There is no self-service permanent erasure or log compaction in this pilot.

## Verification

```sh
npm run check
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
npx wrangler deploy --dry-run
```

The browser test needs a local Chromium binary; `playwright-core` does not
download one. Unit/integration tests run the actual Worker and migration against
Miniflare D1, with fake-indexeddb for deterministic local-storage race tests.
Browser tests use real IndexedDB in Chromium, two tabs, and two isolated browser
profiles. No production data or Cloudflare account is used.
