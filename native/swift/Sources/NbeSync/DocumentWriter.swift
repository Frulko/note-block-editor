import Foundation
import Loro
import NbeModel

/// Editing a Carnet document from Swift.
///
/// Reading proved the two implementations agree on the format. This proves the
/// stronger thing: Swift is a **peer**, not a viewer — an edit made here merges
/// into the TypeScript editor's document like any other client's.
///
/// The layout is mirrored from `packages/collab/src/store.ts` rather than
/// reinvented, and the two rules that matter are the ones that were hard-won
/// there:
///
/// - **The tree owns the structure.** `children` and `parentId` are derived from
///   `LoroTree`, never stored, because the same fact in two places is how they
///   come to disagree.
/// - **Text is a container, not a value.** Stored as a value, two people editing
///   one paragraph conflict on the whole paragraph and a sentence disappears.
public final class DocumentWriter {
    public let doc: LoroDoc
    private let tree: LoroTree

    /// Open an existing document, or start an empty one.
    public init(snapshot: Data? = nil, peerId: UInt64? = nil) throws {
        doc = LoroDoc()
        if let peerId { try doc.setPeerId(peer: peerId) }
        if let snapshot { try doc.import(bytes: snapshot) }
        tree = doc.getTree(id: "blocks")
    }

    /// Our block ids, mapped to the tree's own node ids.
    ///
    /// A scan of every node per lookup was fine while this only appended
    /// paragraphs in tests. An editor calls it on **every keystroke**, and a
    /// document of five hundred blocks then reads five hundred maps to find one,
    /// which is how a text field starts feeling like a telegraph. The cache is
    /// checked against `tree.contains` before use, so a node deleted by a peer
    /// cannot be handed back as live.
    private var index: [String: TreeId] = [:]

    /// The tree node carrying this block id, if the document has one.
    func node(withId id: String) throws -> TreeId? {
        if let cached = index[id], tree.contains(target: cached) { return cached }
        for target in tree.nodes() {
            if case let .string(value: found)?? = try tree.getMeta(target: target).get(key: "id")?.asValue() {
                index[found] = target
                if found == id { return target }
            }
        }
        return nil
    }

    /// Where a block sits: its parent, and its position among its siblings.
    private func place(of target: TreeId) throws -> (parent: TreeParentId, index: Int) {
        let parent = try tree.parent(target: target)
        let siblings = tree.children(parent: parent) ?? []
        return (parent, siblings.firstIndex(of: target) ?? 0)
    }

    /// Write `props` onto a node, replacing the whole map.
    ///
    /// Replacing rather than patching, because a block's type change *is* a new
    /// set of props: keeping `level: 3` on a block that became a to-do leaves a
    /// value nothing reads and every reader has to defend against.
    private func write(props: [String: JSONValue], to meta: LoroMap) throws {
        // A **value**, not a container, because `packages/collab/src/store.ts`
        // writes `data.set('props', block.props)` — and props read out of a
        // container come back as `.container`, which every reader on the other
        // side would have to special-case. The first version of this used a
        // container and the props silently read back empty.
        try meta.insert(key: "props", v: LoroValue.map(value: props.mapValues(Self.loro(from:))))
    }

    /// A JSON value as Loro's own.
    ///
    /// The integer case is the one that matters: `level: 1` stored as a `Double`
    /// reads back as `1.0`, which §4 counts as a different document — and
    /// `PortabilityTests` has been asserting that since before this file could
    /// write props at all.
    static func loro(from value: JSONValue) -> LoroValue {
        switch value {
        case .null: return .null
        case let .bool(flag): return .bool(value: flag)
        case let .number(number):
            if number == number.rounded(), abs(number) < 9_007_199_254_740_992 { return .i64(value: Int64(number)) }
            return .double(value: number)
        case let .string(text): return .string(value: text)
        case let .array(items): return .list(value: items.map(loro(from:)))
        case let .object(fields): return .map(value: fields.mapValues(loro(from:)))
        }
    }

    /// Add a paragraph under `parentId`, at the end.
    ///
    /// - Returns: the block id, so a caller can address it later.
    @discardableResult
    public func appendParagraph(_ text: String, parentId: String, id: String) throws -> String {
        guard let parent = try node(withId: parentId) else {
            throw WriterError.missingParent(parentId)
        }
        let under = TreeParentId.node(id: parent)
        let target = try tree.createAt(parent: under, index: UInt32(tree.children(parent: under)?.count ?? 0))
        let meta = try tree.getMeta(target: target)
        try meta.insert(key: "id", v: id)
        try meta.insert(key: "type", v: "paragraph")
        try meta.insert(key: "version", v: Int64(1))
        // a container, so two peers typing in one paragraph merge by position
        let container = try meta.insertContainer(key: "text", child: LoroText())
        try container.insert(pos: 0, s: text)
        doc.commit()
        return id
    }

    /// Start a document with a page block, the way the editor does.
    @discardableResult
    public func createPage(id: String, title: String) throws -> String {
        let target = try tree.create(parent: .root)
        let meta = try tree.getMeta(target: target)
        try meta.insert(key: "id", v: id)
        try meta.insert(key: "type", v: "page")
        try meta.insert(key: "version", v: Int64(1))
        doc.commit()
        return id
    }

    /// Replace a block's text with `text`.
    ///
    /// **Diffed, not rewritten.** Deleting the old string and inserting the new
    /// one is one line shorter and wrong for a CRDT: it makes every keystroke a
    /// whole-paragraph replacement, so two people typing in one paragraph lose
    /// each other's sentence instead of merging. `LoroText.update` computes the
    /// minimal edit, which is what a `TextField` binding needs — the view hands
    /// over the finished string and the ops stay small.
    public func setText(_ text: String, forBlock id: String) throws {
        guard let target = try node(withId: id) else { throw WriterError.missingParent(id) }
        let meta = try tree.getMeta(target: target)
        let container = try meta.get(key: "text")?.asLoroText() ?? meta.insertContainer(key: "text", child: LoroText())
        try container.update(s: text, options: UpdateOptions(timeoutMs: nil, useRefinedDiff: true))
        doc.commit()
    }

    // MARK: - Structure: what a keystroke means

    /*
     * Everything below is a mirror of `packages/core/src/commands.ts`, and the
     * mirroring is not politeness — it is the only way Enter means the same
     * thing on a phone as in a browser. Where the two could differ, the
     * TypeScript one is the specification and this is the port.
     */

    /// Types that Enter *continues* rather than ends — a second bullet, not a
    /// paragraph under a bullet. `CONTINUING_TYPES`, verbatim.
    static let continuingTypes: Set<String> = ["bulleted_list_item", "numbered_list_item", "to_do", "toggle"]

    /// A block's text, as the CRDT holds it.
    private func text(of target: TreeId) throws -> LoroText? {
        try tree.getMeta(target: target).get(key: "text")?.asLoroText()
    }

    private func type(of target: TreeId) throws -> String {
        if case let .string(value: type)?? = try tree.getMeta(target: target).get(key: "type")?.asValue() { return type }
        return ""
    }

    private func blockId(of target: TreeId) throws -> String? {
        if case let .string(value: id)?? = try tree.getMeta(target: target).get(key: "id")?.asValue() { return id }
        return nil
    }

    /// Create a block next to `sibling`, at `offset` places after it.
    @discardableResult
    private func create(
        id: String,
        type: String,
        props: [String: JSONValue],
        text: String,
        besides sibling: TreeId,
        offset: Int
    ) throws -> String {
        let (parent, at) = try place(of: sibling)
        let target = try tree.createAt(parent: parent, index: UInt32(at + offset))
        let meta = try tree.getMeta(target: target)
        try meta.insert(key: "id", v: id)
        try meta.insert(key: "type", v: type)
        try meta.insert(key: "version", v: Int64(1))
        try write(props: props, to: meta)
        let container = try meta.insertContainer(key: "text", child: LoroText())
        if !text.isEmpty { try container.insert(pos: 0, s: text) }
        index[id] = target
        return id
    }

    /// **Enter.** Split the block at `offset`, or turn an empty non-paragraph
    /// into a paragraph.
    ///
    /// - Parameter offset: a **UTF-16** offset, because that is what a text view
    ///   reports and what §2.2 fixes as the model's unit. It is converted to the
    ///   CRDT's own unit here, once, rather than at every call site.
    /// - Returns: the block the caret belongs in afterwards, and where in it.
    @discardableResult
    public func splitBlock(_ id: String, at offset: Int, newId: String) throws -> (id: String, offset: Int) {
        guard let target = try node(withId: id) else { return (id, offset) }
        let type = try self.type(of: target)
        guard let container = try text(of: target) else { return (id, offset) }
        let whole = container.toString()

        // an empty bullet is how you *stop* being a list, which is the one Enter
        // that does not create anything
        if whole.isEmpty, type != "paragraph" {
            try turnInto(id, type: "paragraph")
            return (id, 0)
        }

        let cut = Offsets.scalarOffset(in: whole, utf16Offset: offset)
        let length = Offsets.scalarLength(of: whole)
        let tail = try Self.tail(of: container, from: cut, length: length)
        let continues = Self.continuingTypes.contains(type)

        if cut < length { try container.delete(pos: UInt32(cut), len: UInt32(length - cut)) }
        let created = try create(
            id: newId,
            type: continues ? type : "paragraph",
            props: continues && type == "to_do" ? ["checked": .bool(false)] : [:],
            text: "",
            besides: target,
            offset: 1
        )
        // the tail is re-applied rather than re-typed, so a bold half-sentence
        // stays bold when someone presses Enter in the middle of it
        if let fresh = try node(withId: created), let into = try text(of: fresh) {
            try Self.apply(tail, to: into, at: 0)
        }
        doc.commit()
        return (created, 0)
    }

    /// The pieces of `container` from `from` onwards, marks included.
    ///
    /// Splitting by reading the plain string and re-inserting it would be four
    /// lines shorter and would silently drop every mark in the tail — a link, a
    /// comment anchor, a peer's bold — the moment anyone pressed Enter in the
    /// middle of a formatted sentence. §4 calls that a promise, so it is not the
    /// place to be brief.
    private static func tail(of container: LoroText, from: Int, length: Int) throws -> [(String, [String: LoroValue])] {
        guard from < length else { return [] }
        var out: [(String, [String: LoroValue])] = []
        var seen = 0
        for piece in container.toDelta() {
            guard case let .insert(insert: text, attributes: attributes) = piece else { continue }
            let width = Offsets.scalarLength(of: text)
            let end = seen + width
            if end > from {
                let start = max(0, from - seen)
                let scalars = Array(text.unicodeScalars)
                let kept = String(String.UnicodeScalarView(scalars[start...]))
                if !kept.isEmpty { out.append((kept, attributes ?? [:])) }
            }
            seen = end
        }
        return out
    }

    private static func apply(_ pieces: [(String, [String: LoroValue])], to container: LoroText, at start: Int) throws {
        var at = start
        for (text, attributes) in pieces {
            try container.insert(pos: UInt32(at), s: text)
            let width = Offsets.scalarLength(of: text)
            for (key, value) in attributes {
                try container.mark(from: UInt32(at), to: UInt32(at + width), key: key, value: value)
            }
            at += width
        }
    }

    /// **Backspace at offset 0.** A non-paragraph becomes a paragraph; a
    /// paragraph merges into the block before it.
    ///
    /// - Returns: where the caret goes, or `nil` when there is nothing to merge
    ///   into — the first block of a document, where Backspace does nothing
    ///   rather than deleting the document.
    @discardableResult
    public func mergeBackward(_ id: String) throws -> (id: String, offset: Int)? {
        guard let target = try node(withId: id) else { return nil }
        let type = try self.type(of: target)
        if type != "paragraph" {
            try turnInto(id, type: "paragraph")
            return (id, 0)
        }

        let entries = try DocumentOrder(doc: doc).entries()
        guard let here = entries.firstIndex(where: { $0.id == id }) else { return nil }
        guard let previous = entries[..<here].last(where: { $0.text != nil }),
              let into = try node(withId: previous.id),
              let container = try text(of: into)
        else { return nil }

        // where the caret lands: the end of what the previous block already held
        let landing = Offsets.scalarLength(of: container.toString())
        if let source = try text(of: target) {
            let carried = source.toString()
            if !carried.isEmpty {
                // marks travel with the text; a merge that pasted the plain
                // string would strip a link off the sentence it belongs to
                let pieces = try Self.tail(of: source, from: 0, length: Offsets.scalarLength(of: carried))
                try Self.apply(pieces, to: container, at: landing)
            }
        }
        // children before deletion: a node with children cannot be deleted, and
        // taking them with it would delete text nobody asked to delete
        for child in tree.children(parent: .node(id: target)) ?? [] {
            try tree.movAfter(target: child, after: target)
        }
        index.removeValue(forKey: id)
        try tree.delete(target: target)
        doc.commit()
        return (previous.id, Offsets.utf16Offset(in: container.toString(), scalarOffset: landing))
    }

    /// **The slash menu, and autoformat.** Change what a block *is*.
    public func turnInto(_ id: String, type: String, props: [String: JSONValue] = [:]) throws {
        guard let target = try node(withId: id) else { return }
        let meta = try tree.getMeta(target: target)
        try meta.insert(key: "type", v: type)
        try write(props: props, to: meta)
        doc.commit()
    }

    /// Set one prop, keeping the others — the to-do checkbox, a heading level.
    public func setProp(_ id: String, key: String, value: JSONValue) throws {
        guard let target = try node(withId: id) else { return }
        let meta = try tree.getMeta(target: target)
        var props = DocumentOrder.props(of: meta)
        props[key] = value
        try write(props: props, to: meta)
        doc.commit()
    }

    /// **Tab.** Become a child of the sibling above.
    ///
    /// - Returns: whether anything moved. The first child of its parent has
    ///   nothing to indent under, and refusing is the correct answer rather than
    ///   an error.
    @discardableResult
    public func indent(_ id: String) throws -> Bool {
        guard let target = try node(withId: id) else { return false }
        let (parent, at) = try place(of: target)
        let siblings = tree.children(parent: parent) ?? []
        guard at > 0, at - 1 < siblings.count else { return false }
        let above = siblings[at - 1]
        let adopted = tree.children(parent: .node(id: above))?.count ?? 0
        try tree.movTo(target: target, parent: .node(id: above), to: UInt32(adopted))
        doc.commit()
        return true
    }

    /// **Shift-Tab.** Move out to just after the parent.
    @discardableResult
    public func outdent(_ id: String) throws -> Bool {
        guard let target = try node(withId: id) else { return false }
        guard case let .node(id: parent) = try tree.parent(target: target) else { return false }
        // the page itself is the top level: a block directly under it has nowhere
        // further out to go
        guard case .node = try tree.parent(target: parent) else { return false }
        try tree.movAfter(target: target, after: parent)
        doc.commit()
        return true
    }

    /// **Drag and drop.** Put `id` immediately after `sibling`, or first among
    /// `sibling`'s siblings when it is `nil`.
    public func move(_ id: String, after sibling: String?) throws {
        guard let target = try node(withId: id) else { return }
        if let sibling, let anchor = try node(withId: sibling) {
            // moving a block into its own subtree would detach it from the
            // document, and Loro is right to refuse — so ask first
            var walking = try tree.parent(target: anchor)
            while case let .node(id: ancestor) = walking {
                if ancestor == target { return }
                walking = try tree.parent(target: ancestor)
            }
            try tree.movAfter(target: target, after: anchor)
        } else if case let .node(id: parent) = try tree.parent(target: target) {
            try tree.movTo(target: target, parent: .node(id: parent), to: 0)
        }
        doc.commit()
    }

    /// Remove a block, promoting its children rather than taking them with it.
    public func remove(_ id: String) throws {
        guard let target = try node(withId: id) else { return }
        for child in tree.children(parent: .node(id: target)) ?? [] {
            try tree.movAfter(target: child, after: target)
        }
        index.removeValue(forKey: id)
        try tree.delete(target: target)
        doc.commit()
    }

    /// Everything since `from`, or a whole snapshot — the bytes a peer wants.
    public func snapshot() throws -> Data {
        try doc.export(mode: .snapshot)
    }

    public enum WriterError: Error {
        case missingParent(String)
    }
}
