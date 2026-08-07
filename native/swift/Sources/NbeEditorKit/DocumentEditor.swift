#if canImport(AppKit)
import AppKit
import Loro
import NbeModel
import NbeSync

/// A document, as a stack of per-block editing surfaces over the CRDT.
///
/// This is where the three halves meet: the CRDT holds the document, the model
/// describes a block, and `BlockTextView` is where a person types. Nothing here
/// re-derives structure — the order comes from `DocumentOrder`, the text from
/// the tree, and an edit goes straight back into the tree, so there is no
/// second copy of the document to fall out of step.
///
/// **An edit here is an edit any peer sees.** The view writes to `LoroText`
/// rather than replacing it, so two people typing in one paragraph merge by
/// position. That is the same rule `packages/collab/src/store.ts` follows and
/// the reason text is a container there.
///
/// No window is required to use it, which is what makes the binding testable
/// on a machine with no device attached.
public final class DocumentEditor {
    public let doc: LoroDoc
    private let tree: LoroTree
    /// One surface per block, keyed by our block id.
    public private(set) var views: [String: BlockTextView] = [:]
    /// The blocks, in reading order.
    public private(set) var order: [DocumentOrder.Entry] = []

    public init(doc: LoroDoc) throws {
        self.doc = doc
        self.tree = doc.getTree(id: "blocks")
        try reload()
    }

    /// Rebuild the surfaces from the document.
    ///
    /// Called on open and after a remote change. Views are reused by block id,
    /// so a peer's edit elsewhere does not throw away the caret here.
    public func reload() throws {
        order = try DocumentOrder(doc: doc).entries()
        var next: [String: BlockTextView] = [:]

        for entry in order where entry.text != nil {
            let view = views[entry.id] ?? makeView(for: entry.id)
            // setting `runs` never notifies, so this cannot echo back as a local edit
            view.runs = [Run(text: entry.text ?? "")]
            next[entry.id] = view
        }
        views = next
    }

    private func makeView(for blockId: String) -> BlockTextView {
        let view = BlockTextView()
        view.onChange = { [weak self] runs in
            try? self?.write(runs.map(\.text).joined(), to: blockId)
        }
        return view
    }

    /// Put a block's text back into the CRDT.
    ///
    /// Uses `LoroText.update`, which diffs rather than replaces — one keystroke
    /// becomes one insert at one position, which is the operation the CRDT
    /// wants. Replacing the container instead would make every keystroke a
    /// whole-paragraph conflict, throwing away exactly what the CRDT is for.
    private func write(_ text: String, to blockId: String) throws {
        for target in tree.nodes() {
            let meta = try tree.getMeta(target: target)
            guard case let .string(value: found)?? = meta.get(key: "id")?.asValue(), found == blockId else { continue }
            guard let container = meta.get(key: "text")?.asLoroText() else { return }
            // no timeout: a block's text is a sentence, and a diff that gave up
            // halfway would write a worse operation than the one it replaced
            try container.update(s: text, options: UpdateOptions(timeoutMs: nil, useRefinedDiff: true))
            doc.commit()
            return
        }
    }

    /// The bytes a peer wants.
    public func snapshot() throws -> Data {
        try doc.export(mode: .snapshot)
    }
}
#endif
