import Foundation
import Loro
import NbeModel

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
    ///
    /// `props`, `parentId` and `index` were added when a real editor needed
    /// them: a heading has a level, a to-do has a checkbox, a numbered item has
    /// to count its own siblings, and a drag has to know where it landed. All
    /// four are questions about a block's *place*, and re-deriving them in the
    /// view is how the view acquires a second copy of the tree.
    public struct Entry: Equatable, Sendable {
        public let id: String
        public let type: String
        public let text: String?
        /// How deep this block sits. The root's children are at zero.
        public let depth: Int
        public let props: [String: JSONValue]
        /// Our block id for the parent; `nil` for a root.
        public let parentId: String?
        /// Position among its siblings.
        public let index: Int
        public let childCount: Int

        /// `heading` only, and 1 when absent rather than 0 — an unknown level
        /// should read as the biggest heading, not as no heading.
        public var headingLevel: Int {
            if case let .number(value)? = props["level"] { return max(1, min(3, Int(value))) }
            return 1
        }

        /// `to_do` only.
        public var isChecked: Bool {
            if case let .bool(value)? = props["checked"] { return value }
            return false
        }
    }

    /// Every block, depth-first, in the order a reader meets them.
    public func entries() throws -> [Entry] {
        var out: [Entry] = []
        for (index, root) in tree.roots().enumerated() {
            try walk(root, depth: 0, parentId: nil, index: index, into: &out)
        }
        return out
    }

    private func walk(_ target: TreeId, depth: Int, parentId: String?, index: Int, into out: inout [Entry]) throws {
        let meta = try tree.getMeta(target: target)
        guard case let .string(value: id)?? = meta.get(key: "id")?.asValue() else { return }
        var type = ""
        if case let .string(value: t)?? = meta.get(key: "type")?.asValue() { type = t }
        let children = tree.children(parent: .node(id: target)) ?? []

        out.append(
            Entry(
                id: id,
                type: type,
                text: meta.get(key: "text")?.asLoroText()?.toString(),
                depth: depth,
                props: Self.props(of: meta),
                parentId: parentId,
                index: index,
                childCount: children.count
            )
        )

        for (position, child) in children.enumerated() {
            try walk(child, depth: depth + 1, parentId: id, index: position, into: &out)
        }
    }

    /// A block's props, as JSON rather than as Loro's own value type.
    ///
    /// The conversion is here and not in the view because §4 promises unknown
    /// props round-trip untouched: a value this build has never heard of has to
    /// come back out the way it went in, and `JSONValue` is the type that keeps
    /// that promise.
    static func props(of meta: LoroMap) -> [String: JSONValue] {
        guard case let .map(value: raw)?? = meta.get(key: "props")?.asValue() else { return [:] }
        return raw.mapValues(json(from:))
    }

    static func json(from value: LoroValue) -> JSONValue {
        switch value {
        case .null: return .null
        case let .bool(value): return .bool(value)
        case let .double(value): return .number(value)
        case let .i64(value): return .number(Double(value))
        case let .string(value): return .string(value)
        case let .list(value): return .array(value.map(json(from:)))
        case let .map(value): return .object(value.mapValues(json(from:)))
        // binary and container have no JSON spelling; dropping them is wrong but
        // the alternative is inventing one, and props never hold either
        case .binary, .container: return .null
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
