# Audit: adopting Loro (phase 5)

The roadmap says of the CRDT: *"Loro is the presumptive choice … behind the
same store interface the plain-JSON implementation satisfies — audit, then
adopt when this phase starts, not before."* This is that audit, done
2026-08-07, before any dependency was added.

Its conclusion is not "yes" or "no". It is that **two of the three things
phase 5 assumed were already true are not**, and that fixing them is worth
doing whether or not Loro is ever adopted.

## What holds

**Moves.** §3 chose `moveBlock(id, parent, afterSibling)` as *intent*, never
delete-plus-reinsert, and called that one of the two known concurrency traps.
Loro's `LoroTree.move(target, parent, index)` is exactly that operation, in a
container built for it. The decision pays off precisely as predicted: the op
does not need translating, only mapping.

**The identifier scheme.** UUIDv7 block ids (D6) and "no persisted integer
offsets" (§2.2) are what a CRDT needs from a document model. Nothing here has
to change.

**The transport shape.** Loro exchanges opaque update blobs, which is what the
roadmap already specifies (*"opaque update blobs over pluggable transports"*).

## What does not hold

### 1. The mark expansion metadata did not exist

§2.2 states that *"each mark type declares Peritext expansion semantics (bold
expands at boundaries, links do not) — dormant metadata until CRDTs, cheap to
declare now"*.

It had never been declared. Marks were `type: string` with no registry
anywhere in `core`. The document described something that was not built.

This matters more than a missing field, because Loro's `configTextStyle` takes
*exactly* this per-mark configuration:

```ts
doc.configTextStyle({ bold: { expand: "after" }, link: { expand: "none" } })
```

Both follow Peritext, which is why §2.2 was right to want it recorded early.

**Fixed 2026-08-07** (`core/src/marks.ts`), and it was never dormant: `marksAt`
decides what the *next typed character* inherits, and it carried every mark of
the preceding character. So typing after a link extended the link, and typing
after inline code stayed code — the opposite of what §2.2 described, visible in
the product, and repaired by the metadata that was supposed to be for later.

### 2. There is no store interface for a CRDT to go behind

`Doc` is `{ blocks: Map<BlockId, Block>; rootId: BlockId }` — a data structure,
not an interface — and `applyOp` mutates that `Map` directly. Every command
reads `doc.blocks.get(…)`. "Behind the same store interface" has no interface.

Two shapes are available, and they are not equivalent:

- **CRDT as the document.** `Doc` becomes an interface; a Loro-backed
  implementation satisfies it. Faithful, and it makes every existing command a
  CRDT operation for free. Costs a pass over `core`, and every read becomes a
  call into WASM.
- **CRDT as the transport.** The `Map` stays; the CRDT holds a parallel copy
  for merging, and remote updates come back as ops. Far less invasive, and it
  has a known failure mode: two representations of the same document that can
  disagree, with no authority to resolve which is right.

The second is tempting and is the one to distrust. A CRDT that is not the
source of truth is a cache of a truth nobody owns.

### 3. Our ops are not the sync unit, and should not be

`insert_block` carries `index`, `insert_text` carries `offset`,
`format_text` carries `from`/`to`. Integer positions are exactly what does not
merge — two clients inserting at index 3 mean different things.

That is not a flaw: §2.2 already limits offsets to "op payloads and ephemeral
selection", never to anything persisted. But it settles a question phase 5
might otherwise get wrong: **the ops are a local application format, and the
wire format is Loro's own updates.** Sending our ops between peers would
reintroduce the trap the op design avoids.

## Recommendation

In this order, and the first is already done:

1. ~~Declare the mark expansion semantics.~~ Shipped, with a present-day bug
   fixed on the way.
2. **Make `Doc` an interface** before adopting anything. It is the change that
   makes a CRDT possible and it is worth making on its own merits: today
   nothing can be swapped for the document store, including a lazy one for
   large documents.
3. **Then** adopt Loro, as the document rather than as a transport, with the
   op layer mapping onto its containers: `move_block` → `LoroTree.move`,
   text ops → `LoroText` with `configTextStyle` fed from `MARKS`.

Step 2 is the real cost of phase 5, and it is invisible from the outside. Doing
step 3 first would produce something that syncs and cannot be trusted.

## Follow-up: the interface was necessary and not sufficient

Written 2026-08-07, after starting the adapter.

Declaring `BlockStore` cost nothing and changed nothing at the call sites,
which was the right result — but it did not make the store swappable. The
reducer mutated the block `get` returned (`parent.children.splice(…)`,
`block.text = …`) and never wrote it back, because a `Map` hands out its own
object and the mutation *was* the write. Any store that materialises blocks on
demand — every CRDT-backed one — saw nothing.

Fixed by writing back after each mutation: free for a `Map`, and the write
signal for everything else. Verified by driving an editor against a store that
deliberately returns copies, where a missing write-back is a lost edit.

The lesson is about the audit itself: reading the code found the missing
interface, and only building against it found that the interface's *contract*
was unsatisfiable. Loro's own capabilities were checked by running them
(`LoroTree.move`, `configTextStyle`, update export/import all confirmed at
version 1.8) rather than by reading, which is why nothing there surprised us.

## Follow-up: the adapter, and a second identity assumption

`packages/collab` (2026-08-07). The tree owns the structure and nothing else
holds a copy: `get` derives `children` and `parentId` from `LoroTree`, `set`
applies them to it, and only type/version/props/text are stored on the node.
Storing structure in both places would be the same fact twice.

A real editor runs against it unchanged — insert, type, move, delete, undo —
and two peers exporting and importing each other's updates converge, including
the case the movable tree was chosen for: both moving the same block to
different parents yields one block in one place on both sides, not two.

Building it found a second assumption of the same family as the write-back one.
`move_block` called `getBlock` twice on the same parent when a block moves
*within* it, and relied on both calls returning the same object — true for a
`Map`, false for anything that materialises. The second copy had not seen the
removal the first made, so reordering inside one parent listed the block twice.

Both faults are the same shape: **the reducer assumed the store was a `Map`
in ways the type could not express.** The interface said what the members were;
it did not say that `get` may return a fresh object, or that mutations must be
written back. Both are now stated on `BlockStore` and tested by driving the
editor against a store that deliberately returns copies.

~~Still missing: text stored as a value.~~ Done (`collab/src/text.ts`): runs
map onto `LoroText`, so two people editing one paragraph merge instead of one
of them disappearing.

The difficulty was not the offsets, which turned out to be a question about the
*wire* format and was already settled. It was that `set(id, block)` hands over
a finished run array rather than an operation. Replacing the container with it
would be one enormous replacement per keystroke, throwing away exactly what the
CRDT is for — so the store diffs, and a keystroke becomes one insert at one
position. The operation is recovered from the value we were given.

A prefix/suffix diff is enough because that is the shape of typing. It is not
minimal for arbitrary rewrites: a paste changing the middle of a paragraph
produces one replacement spanning the change, which merges worse than it could
and is still correct.

## Not evaluated here

Performance, memory, and the WASM bundle's weight in the browser — all of
which need a prototype rather than documentation. The Swift bindings
(`loro-swift`), which matter for the native editor, are documented as existing
and have not been tried.
