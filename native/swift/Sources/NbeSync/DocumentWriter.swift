import Foundation
import Loro

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

    /// The tree node carrying this block id, if the document has one.
    private func node(withId id: String) throws -> TreeId? {
        for target in tree.nodes() {
            if case let .string(value: found)?? = try tree.getMeta(target: target).get(key: "id")?.asValue(),
               found == id {
                return target
            }
        }
        return nil
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

    /// Everything since `from`, or a whole snapshot — the bytes a peer wants.
    public func snapshot() throws -> Data {
        try doc.export(mode: .snapshot)
    }

    public enum WriterError: Error {
        case missingParent(String)
    }
}
