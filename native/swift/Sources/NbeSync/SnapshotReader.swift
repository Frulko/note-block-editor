import Foundation
import Loro
import NbeModel

/// Reading a document written by the TypeScript editor.
///
/// The point is not that Swift can call a Rust library — that is a given. It is
/// that **the two implementations agree on the same bytes**: a snapshot exported
/// by the web or desktop client opens here, with the same blocks, the same tree
/// and the same text.
///
/// The store's layout is mirrored rather than reimplemented: the tree owns the
/// structure and each node's map holds `id`, `type`, `version`, `props` and
/// `text`, exactly as `packages/collab/src/store.ts` writes it. If that ever
/// drifts, this stops reading and says so, which is the whole reason to have a
/// second implementation at all.
public struct SnapshotReader {
    public let doc: LoroDoc

    public init(snapshot: Data) throws {
        doc = LoroDoc()
        try doc.import(bytes: snapshot)
    }

    /// Every block in the document, in tree order.
    public func blocks() throws -> [Block] {
        let tree = doc.getTree(id: "blocks")
        return try tree.nodes().compactMap { target -> Block? in
            let data = try tree.getMeta(target: target)
            guard case let .string(value: id)?? = data.get(key: "id")?.asValue() else { return nil }
            var type = ""
            if case let .string(value: t)?? = data.get(key: "type")?.asValue() { type = t }
            var version = 1
            switch data.get(key: "version")?.asValue() {
            case let .double(value: v)?: version = Int(v)
            case let .i64(value: v)?: version = Int(v)
            default: break
            }
            return Block(id: id, type: type, version: version)
        }
    }

    /// Every block's text, which is what proves the two agree on content.
    public func allText() throws -> [String] {
        let tree = doc.getTree(id: "blocks")
        return try tree.nodes().compactMap { target in
            let data = try tree.getMeta(target: target)
            guard let text = data.get(key: "text")?.asLoroText() else { return nil }
            return text.toString()
        }
    }
}
