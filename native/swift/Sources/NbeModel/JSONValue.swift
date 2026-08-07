import Foundation

/// Any JSON value, kept exactly as it was found.
///
/// `Codable` drops keys it was not told about, which would quietly break the
/// promise §4 of the architecture makes: *"unknown types and unknown props
/// round-trip untouched"*. A block written by a newer version, or by a plugin
/// this build has never heard of, has to survive being read and written back —
/// otherwise opening a document in an older client silently deletes parts of
/// it.
///
/// So props are not a typed struct. They are this, which can hold anything and
/// gives it back unchanged.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "valeur JSON inconnue")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value):
            // whole numbers go back out as integers: `"level": 1` must not
            // become `"level": 1.0`, which is a different document to a reader
            if value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
                try container.encode(Int(value))
            } else {
                try container.encode(value)
            }
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
