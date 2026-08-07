# Browser storage for a local-first editor

Research note, 2026-08-07. Resolves the browser half of AQ#1 and most of AQ#2.

---

## 1. Verdict

- **IndexedDB is the browser's L0.** It is the only universally available
  store that is *transactional* — commit-or-rollback across object stores is
  the browser's temp+rename, for free.
- **OPFS is not L0.** It is the large-binary tier and the future home of a
  WASM-SQLite L2. Its sync API is worker-only, its writes are not atomic
  (`createSyncAccessHandle` writes in place), and it carries the *same*
  eviction risk as IndexedDB. It buys speed we do not need for a few hundred
  JSON documents, at the cost of a worker, a message protocol, and our own
  journalling.
- **File System Access cannot be the storage promise.** Chromium desktop and
  Chrome Android 132+ only. Firefox's standards position is
  ["we consider this harmful"](https://github.com/mozilla/standards-positions/issues/154);
  WebKit's is
  ["we don't see a way to grant write access… that safeguards the end user's interests"](https://github.com/WebKit/standards-positions/issues/28),
  closed 2023 — a stated position, not a backlog item. On Safari and Firefox,
  and therefore on all of iOS, "your files in a folder" is a **download
  button**. The product copy must say so.

**Therefore, in the browser, the readable projection is an artifact, not a
substrate.** L1 is produced from L0 on demand, never stored as the medium.

## 2. The precedent that settles it

Logseq **split its project over exactly this question**. The file-as-truth
product was forked to `logseq/og`; master is now a SQLite database version, and
markdown became a *derived mirror* — the namespace is literally
`frontend.worker.markdown-mirror`, "Markdown mirror derived-file support for DB
graphs".

What files-as-truth cost them while they still had it: writes debounced at
1000 ms, deferred entirely for pages over 500 blocks until typing stopped, and
a user-facing string in the write path reading *"Write file failed, please copy
the changes to other editors in case of losing data."*

Notion's web client converged independently on the same stack as Logseq's new
one — WASM SQLite over OPFS, in a worker, with a SharedWorker electing a
**single writer tab** — adopted *after* concurrent multi-tab writes corrupted
the database in production.

Both arrived at: a database is canonical, files are a projection, and any
shared writable store needs explicit single-writer arbitration. That is the
L0/L1 split this project already chose, arrived at independently by two teams
who tried the other way first.

## 3. Traps, with the ones we have already hit

**Transaction lifetime is the big one.** MDN: a transaction becomes inactive if
you return to the event loop without a pending request. In modern code that
means **any `await` on a non-IDB promise inside a transaction kills it**. The
spec fix was proposed in 2016 and never landed; design around it. Hash and
serialize *before* opening the transaction.

**Never save on `pagehide`.** MDN is explicit: transactions created in an
unload handler may never complete. Our demo's `workspace.ts` flushes on
`pagehide` and is correct *only* because `localStorage.setItem` is synchronous.
Port that pattern to IndexedDB unchanged and the last edit is lost on every
close. The IDB-safe shape is a short continuous debounce so there is nothing
important left to flush.

**Two real bugs in our own demo, confirmed by reading the source:**

1. `assets.ts` calls `openDb()` inside `inTx`, i.e. **on every store and every
   resolve**, and never closes. Each call leaks an `IDBDatabase`, and every
   leaked connection will block a future schema upgrade — silently, because
   `blocked` is unhandled. There is also no `db.onversionchange` handler, so
   one stale tab can wedge upgrades for every other tab.
2. `resolveAsset` caches object URLs and never calls `URL.revokeObjectURL`, so
   every image resolved in a session pins its blob for the page's lifetime.

**Performance shape.** Transaction *count* dominates write cost, not record
count: 100 records written one-transaction-each versus one transaction is
1075 ms versus 65 ms. Reads should use `getAll()` with a key range rather than
a cursor per record — up to 11× faster on Safari. The unit that follows is
**one record per page, one transaction per commit batch** — not one record per
block (thousands of tiny records, and consistency then costs transactions), and
not one record per workspace (rewrites the world per keystroke, which is
exactly what our `localStorage` demo does and why it also hits the 5 MiB cap).

**Safari will delete your data.** ITP's seven-day rule is still in force:
script-writeable storage — IndexedDB, localStorage, Cache, Service Worker
registrations — is erased after 7 days of Safari use without interaction. And
between 17.2 and 17.5, Safari *erased storage for all sites* through a SQLite
integrity bug ([WebKit 266559](https://bugs.webkit.org/show_bug.cgi?id=266559)).
The only documented ITP exemption is Home Screen installation — and an
installed web app's storage is **isolated from Safari's**, so it starts empty.

The conclusion is not "avoid IndexedDB" — every alternative on iOS sits on the
same WebKit storage layer that bug wiped. It is that **an export path the user
can reach must always exist, because the store can vanish through no fault of
ours.** The zip export is not a feature; it is the backstop.

## 4. Asset GC that survives undo

Excalidraw's rule, which is the cheapest correct one: delete a blob only if it
is **unreferenced by any live document AND untouched for longer than a grace
period** (they use one day), tracking a `lastRetrieved` timestamp.

- **Sweep, do not refcount.** Refcounts drift under undo, multi-tab and
  crashes; a mark-and-sweep over live documents cannot. We already keep every
  page's JSON in one store, so finding live `asset:` refs is one `getAll()`.
- **Never delete on the edit path.** Deleting a block is not deleting a blob.
- The grace period is what makes undo safe, and it also covers a crash between
  "paste image" and "save document" — one timestamp, no bookkeeping.
- Sweep at startup behind a Web Lock so only one tab does it.

This maps one-to-one onto the file backend: hashes become
`assets/<hash>.<ext>`, the sweep becomes the same scan over `.md` files. That
is why **AQ#2 does not need a different answer per runtime.**

## 5. Multi-tab is the default state, not an edge case

Every failure mode above is a multi-tab failure. The primitives are cheap and
already Baseline: `navigator.locks.request()` for single-writer election,
`BroadcastChannel` to tell other tabs a page changed, and
`db.onversionchange → db.close()` so upgrades are never wedged. CRDTs are not
needed for this; one writer plus invalidation is what Notion and Logseq both
ended up building anyway.

## 6. The architecture, and the seam that makes Phase 4 cheap

```
browser runtime
  L0   IndexedDB via `idb` (~1.2 kB)
         docs      page id  → { id, updatedAt, json }
         meta      'workspace' → { openId, collections[] }
         assets    sha256   → Blob
         assetMeta sha256   → { addedAt, lastSeen, mime }
       one readwrite transaction per commit batch — atomic by construction
       ~300 ms debounce, never an unload-time save
       Web Locks + BroadcastChannel for tabs
  L1   produced by @nbe/markdown, never stored
         (a) zip download — every browser, always
         (b) directory mirror — Chromium only, handle persisted in IDB
  L2   not in the browser yet (SQLite/WASM + OPFS + worker + single writer)
```

**The seam is four methods**: `loadDoc / saveDoc / listDocs / deleteDoc`, plus
`getAsset / putAsset`. Automerge-repo's storage adapter is the model — "any
key/value store which supports range queries", and nothing more. Two
implementations will genuinely exist (browser, desktop), so this is not a
speculative abstraction.

The Chromium directory mirror is worth building *because it is the cheapest
possible rehearsal of Phase 4*: it exercises L1 regeneration, external-edit
import and mirror-state recovery against a real filesystem, using the same
`@nbe/markdown` projection as the zip export, without Electron.

**Deliberately skipped:** OPFS for L0, SQLite in the browser, refcounted
assets, Storage Buckets, and a CRDT before Phase 5. Each is added when a
measurement demands it, not a roadmap.


## Caveat found 2026-08-08: WebKit will not store a `Blob`

This note calls IndexedDB the browser's L0 and stands by that — but the *value
types* are not uniform. WebKit's IndexedDB refuses a `Blob`: `put(new Blob(…))`
errors while reads on the same store succeed, so the failure is silent unless
the write's error is handled.

The demo's asset store hit exactly this, and every image would have failed to
persist on Safari and on all of iOS. Store an `ArrayBuffer` and rebuild the
`Blob` on read.

Found by running the browser suite on WebKit for the first time, which is a
better argument for cross-engine testing than any of the reasoning in this file.
