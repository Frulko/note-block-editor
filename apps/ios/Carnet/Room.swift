import Foundation
import Loro
import NbeSync
import SwiftUI

/// The document, the connection, and which of the two is carrying it.
///
/// Everything below the `@Published`s is `native/swift`: the same
/// `DocumentWriter` the tests use, the same `SyncSession`, the same
/// `P2PTransport`. The app supplies a real `PeerLink` and a screen, and that is
/// the whole of what it adds — which is the claim `docs/ARCHITECTURE.md` makes
/// about the Swift layer being a peer rather than a viewer.
@MainActor
final class Room: ObservableObject {
    @Published var blocks: [DocumentOrder.Entry] = []
    @Published var status = "Hors ligne"
    @Published var connected = false

    private var writer: DocumentWriter?
    private var session: SyncSession?
    private var transport: P2PTransport?
    /// Derived from the room name, and it has to match `examples/collab` exactly
    /// (`<salon>-root`) or the two clients sync one document and each render a
    /// different page of it — everything converges and both screens look empty,
    /// which is the confusing kind of broken.
    private var pageId = "page"

    func join(relay: String, room: String) {
        leave()
        guard let url = URL(string: relay) else {
            status = "Adresse invalide"
            return
        }

        pageId = "\(room)-root"
        do {
            let writer = try DocumentWriter()
            self.writer = writer

            let signalling = RelayTransport(url: url, room: room)
            let p2p = P2PTransport(signalling: signalling) { WebRTCLink() }
            p2p.onState = { [weak self] state in
                guard let self else { return }
                self.status = state.peers == 0
                    ? "Connecté — en attente d’un pair"
                    : state.relayed
                        ? "\(state.peers) pair(s), via le relais"
                        : "Pair-à-pair — \(state.direct) pair(s) en direct"
            }
            transport = p2p

            let session = SyncSession(doc: writer.doc, transport: p2p)
            session.onRemoteChange = { [weak self] in
                Task { @MainActor in self?.reload() }
            }
            self.session = session

            connected = true
            status = "Connexion…"
            /*
             * The page is derived from the room name rather than generated, the
             * same way the web demo does it: two peers each inventing a root
             * would render two different documents that both sync correctly,
             * which is the confusing kind of broken.
             *
             * The wait lets an existing document arrive before we decide the room
             * is empty. ponytail: a fixed delay, not a handshake — replace it
             * with a "synced" signal from `SyncSession` if a slow link ever makes
             * an empty page flash.
             */
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(600))
                self.seedIfEmpty()
                self.reload()
            }
        } catch {
            status = "Document illisible : \(error)"
        }
    }

    func leave() {
        session?.stop()
        session = nil
        transport = nil
        writer = nil
        blocks = []
        connected = false
        status = "Hors ligne"
    }

    /// Add a paragraph at the end.
    func append(_ text: String = "") {
        guard let writer else { return }
        try? writer.appendParagraph(text, parentId: pageId, id: UUID().uuidString)
        reload()
    }

    /// Write a block's text back into the CRDT.
    ///
    /// Diffed by `DocumentWriter.setText`, so a keystroke is a keystroke on the
    /// wire rather than a whole-paragraph replacement — which is what lets two
    /// people type in one paragraph and keep both sentences.
    func setText(_ text: String, for id: String) {
        try? writer?.setText(text, forBlock: id)
    }

    private func seedIfEmpty() {
        guard let writer else { return }
        let existing = (try? DocumentOrder(doc: writer.doc).entries()) ?? []
        guard existing.isEmpty else { return }
        try? writer.createPage(id: pageId, title: "Notes")
        try? writer.appendParagraph("", parentId: pageId, id: UUID().uuidString)
    }

    private func reload() {
        guard let writer else { return }
        let entries = (try? DocumentOrder(doc: writer.doc).entries()) ?? []
        blocks = entries.filter { $0.type != "page" }
    }
}
