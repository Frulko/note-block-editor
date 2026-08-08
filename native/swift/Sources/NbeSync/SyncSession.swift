import Foundation
import Loro

/// Keeping a document in sync over a transport — the Swift half of `connect()`.
///
/// A peer opens by announcing what it already has; the other side replies with
/// exactly what is missing. That is the reason this is not "send a snapshot":
/// reconnecting after an hour offline then costs what was missed, not the size
/// of the document.
///
/// **The echo is stopped by Loro, not by us.** `subscribeLocalUpdate` fires only
/// for changes made *here*, so an imported update never bounces back. The
/// TypeScript side has to filter `event.by !== 'local'` by hand; this API hands
/// the same guarantee over for free, and the delta it hands over is minimal
/// rather than the whole oplog.
public final class SyncSession {
    private let doc: LoroDoc
    private let transport: Transport
    private var subscription: Subscription?
    /// Called after a remote update lands, so a view can repaint.
    public var onRemoteChange: (() -> Void)?

    public init(doc: LoroDoc, transport: Transport) {
        self.doc = doc
        self.transport = transport

        transport.onMessage = { [weak self] message in
            self?.receive(message)
        }
        subscription = doc.subscribeLocalUpdate { [weak self] update in
            self?.transport.send(envelope(.update, update))
        }
        // announce first, so the other side can answer with the difference
        transport.send(envelope(.have, doc.oplogVv().encode()))
    }

    private func receive(_ message: Data) {
        guard let first = message.first, let kind = Message(rawValue: first) else { return }
        let payload = message.dropFirst()

        switch kind {
        case .have:
            let vv = (try? VersionVector.decode(bytes: Data(payload))) ?? VersionVector()
            // an unreadable vector means "send me everything", which is slower
            // rather than wrong
            if let updates = try? doc.export(mode: .updates(from: vv)) {
                transport.send(envelope(.update, updates))
            }
        case .update:
            guard !payload.isEmpty, (try? doc.import(bytes: Data(payload))) != nil else { return }
            onRemoteChange?()
        case .presence, .signal:
            // presence never touches the document; signalling is consumed by the
            // transport below us and should never reach here
            break
        }
    }

    public func stop() {
        subscription = nil
        transport.close()
    }
}
