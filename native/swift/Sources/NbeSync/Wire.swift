import Foundation

/// The wire protocol, ported rather than re-invented.
///
/// This is `packages/collab/src/sync.ts` in Swift, and the numbers matter more
/// than the names: a Swift peer and a TypeScript peer put the same byte in
/// front of the same payload, or they do not talk. Two implementations of one
/// protocol is the whole point — a mistake here is caught by
/// `SyncInteropTests`, not by review.
public enum Message: UInt8 {
    /// "This is my version vector." Answer with what I do not have.
    case have = 0
    /// "Here is an update." Apply it.
    case update = 1
    /// "Here is where I am." Presence, which never touches the document.
    case presence = 2
    /// "Here is how to reach me directly." WebRTC negotiation, and the relay's
    /// count of who is in the room.
    case signal = 3
}

/// One kind byte, then the payload.
public func envelope(_ kind: Message, _ payload: Data) -> Data {
    var out = Data([kind.rawValue])
    out.append(payload)
    return out
}

/// Moving bytes between peers, whatever the pipe.
///
/// Deliberately the same two-method shape as the TypeScript `Transport`: it does
/// not reconnect, authenticate, batch or retry, because those differ per
/// transport and belong to whichever one is being written.
public protocol Transport: AnyObject {
    func send(_ message: Data)
    /// Set by the session. One handler, not a list — nothing here has needed two.
    var onMessage: ((Data) -> Void)? { get set }
    func close()
}
