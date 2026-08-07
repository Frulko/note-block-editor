import Foundation
import Loro

/// The document in reading order — the thing an editor actually renders.
///
/// `LoroTree.nodes()` walks the tree in its own order, which is **not** the
/// document's. Both implementations tripped on that within an hour of each
/// other: a TypeScript test asserted the order `values()` returns and a Swift
/// test asserted the order `nodes()` returns, and both were wrong for the same
/// reason. Having been caught twice, it is worth a named primitive rather than
/// a comment telling the next person to be careful.
///
/// Reading order is a depth-first walk from the root through each node's
/// children, which is the order a person sees and the order a renderer needs.
public struct DocumentOrder {
    private let doc: LoroDoc
    private let tree: LoroTree

    public init(doc: LoroDoc) {
        self.doc = doc
        self.tree = doc.getTree(id: "blocks")
    }

    /// One block, flattened — enough to lay out, not the whole model.
    public struct Entry: Equatable, Sendable {
        public let id: String
        public let type: String
        public let text: String?
        /// How deep this block sits. The root's children are at zero.
        public let depth: Int
    }

    /// Every block, depth-first, in the order a reader meets them.
    public func entries() throws -> [Entry] {
        var out: [Entry] = []
        for root in tree.roots() {
            try walk(root, depth: 0, into: &out)
        }
        return out
    }

    private func walk(_ target: TreeId, depth: Int, into out: inout [Entry]) throws {
        let meta = try tree.getMeta(target: target)
        guard case let .string(value: id)?? = meta.get(key: "id")?.asValue() else { return }
        var type = ""
        if case let .string(value: t)?? = meta.get(key: "type")?.asValue() { type = t }
        out.append(Entry(id: id, type: type, text: meta.get(key: "text")?.asLoroText()?.toString(), depth: depth))

        for child in tree.children(parent: .node(id: target)) ?? [] {
            try walk(child, depth: depth + 1, into: &out)
        }
    }

    /// The plain text of the document, one block per line.
    ///
    /// What a preview shows, and what makes a mismatch between the two
    /// implementations legible in a test failure.
    public func plainText() throws -> String {
        try entries().compactMap(\.text).joined(separator: "\n")
    }
}
