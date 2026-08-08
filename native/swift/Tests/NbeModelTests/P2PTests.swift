import Foundation
import Loro
import XCTest
@testable import NbeSync

/// The peer-to-peer state machine, without a WebRTC binary.
///
/// What is under test here is the part that can be wrong in a way ICE cannot
/// tell you about: who offers, who answers, when it is safe to stop using the
/// relay, and whether the messages on the wire are the ones
/// `packages/collab/src/webrtc.ts` writes. The transport injects its
/// `PeerLink`, so a fake pair standing in for two data channels tests all of it
/// — and `apps/ios` supplies the real one.
///
/// The case worth naming: **two peers meshing must not orphan a third that
/// cannot mesh.** That is the silent failure — everything on screen looks
/// healthy while the always-on node stops receiving the document — and it is
/// the last test in this file.
final class P2PTests: XCTestCase {
    // MARK: - Doubles

    /// A relay room: whatever one member sends, the others hear.
    final class Room {
        private var members: [Wire] = []

        /// Join, and build the thing that listens on the wire before the room
        /// says anything.
        ///
        /// The closure is not ceremony: this room is synchronous where a socket
        /// is not, so a membership announcement sent before the client had
        /// attached its handler would simply vanish — and the test would pass for
        /// the wrong reason, since a lost count falls back to counting greeters.
        func join<T>(_ attach: (Wire) -> T) -> T {
            let wire = Wire(room: self)
            members.append(wire)
            let listener = attach(wire)
            announceMembers()
            return listener
        }

        /// What `packages/cli/src/relay.ts` sends on every join: the size of the
        /// room. Peers cannot count a peer that never announces itself.
        private func announceMembers() {
            let json = try! JSONSerialization.data(withJSONObject: [
                "from": "relay", "kind": "members", "count": members.count,
            ])
            let frame = envelope(.signal, json)
            for member in members { member.onMessage?(frame) }
        }

        func broadcast(_ message: Data, from sender: Wire) {
            for member in members where member !== sender { member.onMessage?(message) }
        }
    }

    final class Wire: Transport {
        var onMessage: ((Data) -> Void)?
        private weak var room: Room?
        init(room: Room) { self.room = room }
        func send(_ message: Data) { room?.broadcast(message, from: self) }
        func close() { room = nil }
    }

    /// Two of these, wired to each other, stand in for a data channel pair.
    ///
    /// It performs the *shape* of the negotiation rather than a real one: an
    /// offer, an answer, then open. That is what the transport reacts to, and it
    /// is the whole of what the transport can get wrong.
    final class FakeLink: PeerLink {
        var onData: ((Data) -> Void)?
        var onOpenChange: ((Bool) -> Void)?
        var onDescription: ((SessionDescription) -> Void)?
        var onCandidate: ((IceCandidate) -> Void)?
        private(set) var isOpen = false
        /// Every link made by any transport in this test, so the two halves can
        /// find each other by the description they exchange.
        static var pending: [String: FakeLink] = [:]
        private var token = UUID().uuidString

        func start(offering: Bool) {
            guard offering else { return }
            FakeLink.pending[token] = self
            onDescription?(SessionDescription(type: "offer", sdp: token))
        }

        func accept(description: SessionDescription) {
            if description.type == "offer" {
                // the answering half adopts the offerer's token and replies
                token = description.sdp
                FakeLink.pending[token]?.peer = self
                peer = FakeLink.pending[token]
                onDescription?(SessionDescription(type: "answer", sdp: token))
                open()
            } else {
                open()
            }
        }

        func accept(candidate: IceCandidate) {}

        private weak var peer: FakeLink?

        private func open() {
            guard !isOpen else { return }
            isOpen = true
            onOpenChange?(true)
        }

        func send(_ message: Data) { peer?.onData?(message) }

        func close() {
            isOpen = false
            peer = nil
            onOpenChange?(false)
        }
    }

    override func setUp() {
        FakeLink.pending.removeAll()
    }

    // MARK: - Tests

    func testTwoPeersMeshAndLeaveTheRelay() throws {
        let room = Room()
        let alice = room.join { P2PTransport(signalling: $0, id: "aaaa") { FakeLink() } }
        let basile = room.join { P2PTransport(signalling: $0, id: "bbbb") { FakeLink() } }

        XCTAssertEqual(alice.state, P2PState(peers: 1, direct: 1, relayed: false))
        XCTAssertEqual(basile.state, P2PState(peers: 1, direct: 1, relayed: false))

        // and the document goes through: two Loro documents, joined by these
        var received: [Data] = []
        basile.onMessage = { received.append($0) }
        alice.send(envelope(.update, Data([1, 2, 3])))
        XCTAssertEqual(received, [envelope(.update, Data([1, 2, 3]))])
    }

    func testDocumentsConvergeOverTheMesh() throws {
        let room = Room()
        let alice = try DocumentWriter()
        let basile = try DocumentWriter()

        let left = room.join { P2PTransport(signalling: $0, id: "aaaa") { FakeLink() } }
        let right = room.join { P2PTransport(signalling: $0, id: "bbbb") { FakeLink() } }
        let sessionA = SyncSession(doc: alice.doc, transport: left)
        let sessionB = SyncSession(doc: basile.doc, transport: right)

        try alice.createPage(id: "page", title: "Notes")
        try alice.appendParagraph("écrit sans serveur", parentId: "page", id: "un")

        XCTAssertEqual(try DocumentOrder(doc: basile.doc).plainText(), "écrit sans serveur")

        // and back, because a channel that only worked one way would pass above
        try basile.setText("réécrit depuis l’autre pair", forBlock: "un")
        XCTAssertEqual(try DocumentOrder(doc: alice.doc).plainText(), "réécrit depuis l’autre pair")

        sessionA.stop()
        sessionB.stop()
    }

    func testStaysOnTheRelayWhileAPeerCannotMesh() throws {
        let room = Room()
        /*
         * A peer that speaks the protocol but not WebRTC — `nbe serve`, or an
         * older client. It never says hello, so the meshing peers cannot see it
         * by counting greetings; the relay's membership count is the only thing
         * that does.
         */
        let plain = try DocumentWriter()
        let plainSession = room.join { SyncSession(doc: plain.doc, transport: $0) }

        let first = try DocumentWriter()
        let left = room.join { P2PTransport(signalling: $0, id: "peer-0") { FakeLink() } }
        let sessionA = SyncSession(doc: first.doc, transport: left)
        let right = room.join { P2PTransport(signalling: $0, id: "peer-1") { FakeLink() } }
        let sessionB = SyncSession(doc: try DocumentWriter().doc, transport: right)

        // both have a direct channel and are *still* relayed, because the room
        // holds three
        XCTAssertEqual(left.state.direct, 1)
        XCTAssertTrue(left.state.relayed)
        XCTAssertTrue(right.state.relayed)

        try first.createPage(id: "page", title: "Notes")
        try first.appendParagraph("visible par le nœud", parentId: "page", id: "un")
        XCTAssertEqual(try DocumentOrder(doc: plain.doc).plainText(), "visible par le nœud")

        sessionA.stop()
        sessionB.stop()
        plainSession.stop()
    }
}
