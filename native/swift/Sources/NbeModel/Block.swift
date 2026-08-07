import Foundation

/// A mark on a run of text (§2.2).
public struct Mark: Codable, Equatable, Sendable {
    public var type: String
    public var attrs: [String: JSONValue]?

    public init(type: String, attrs: [String: JSONValue]? = nil) {
        self.type = type
        self.attrs = attrs
    }
}

/// A run: text plus the marks covering all of it.
public struct Run: Codable, Equatable, Sendable {
    public var text: String
    public var marks: [Mark]?

    public init(text: String, marks: [Mark]? = nil) {
        self.text = text
        self.marks = marks
    }
}

/// A block, as it is stored (§2.1).
///
/// The same JSON the TypeScript editor writes, decoded by a second
/// implementation in another language — which is what §9 means by *"the
/// contract doubles as the spec a Swift port mirrors"*. `Tests` decodes a
/// document produced by the editor itself rather than one written here, so the
/// two are checked against each other and not against one author's idea of the
/// format.
public struct Block: Codable, Equatable, Sendable {
    public var id: String
    public var type: String
    public var version: Int
    public var props: [String: JSONValue]?
    public var text: [Run]?
    public var children: [Block]?

    public init(
        id: String,
        type: String,
        version: Int,
        props: [String: JSONValue]? = nil,
        text: [Run]? = nil,
        children: [Block]? = nil
    ) {
        self.id = id
        self.type = type
        self.version = version
        self.props = props
        self.text = text
        self.children = children
    }

    /// Decode a document.
    public static func decode(_ data: Data) throws -> Block {
        try JSONDecoder().decode(Block.self, from: data)
    }

    /// Encode it back.
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    /// The block's plain text, marks discarded.
    public var plainText: String {
        (text ?? []).map(\.text).joined()
    }

    /// Every block in the tree, parents before children.
    public var flattened: [Block] {
        [self] + (children ?? []).flatMap(\.flattened)
    }
}
