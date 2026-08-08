import Foundation

/// An SDP offer or answer, in the shape the browser puts on the wire.
///
/// The field names are not ours to choose: `packages/collab/src/webrtc.ts` sends
/// `RTCSessionDescription`'s own JSON, and a Swift peer that renamed anything
/// here would negotiate with nobody.
public struct SessionDescription: Codable, Equatable, Sendable {
    public var type: String
    public var sdp: String

    public init(type: String, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

/// One ICE candidate, likewise in `RTCIceCandidateInit`'s shape.
public struct IceCandidate: Codable, Equatable, Sendable {
    public var candidate: String
    public var sdpMid: String?
    public var sdpMLineIndex: Int32?

    public init(candidate: String, sdpMid: String?, sdpMLineIndex: Int32?) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
    }
}

/// One direct connection to one peer.
///
/// The WebRTC implementation is **injected** rather than imported, for the same
/// reason `packages/collab` injects `RTCPeerConnection`: this package's claim is
/// that the document format and the protocol need no dependency of our choosing,
/// and `swift test` should not download a WebRTC binary to check a state
/// machine. `apps/ios` supplies the real one; the tests supply two fakes wired
/// to each other.
public protocol PeerLink: AnyObject {
    /// Bytes arrived from the peer.
    var onData: ((Data) -> Void)? { get set }
    /// The data channel opened or closed.
    var onOpenChange: ((Bool) -> Void)? { get set }
    /// A local description to hand to the peer.
    var onDescription: ((SessionDescription) -> Void)? { get set }
    /// A local candidate to hand to the peer, as it is discovered.
    var onCandidate: ((IceCandidate) -> Void)? { get set }
    var isOpen: Bool { get }
    /// Begin. Exactly one of the two sides is the offerer.
    func start(offering: Bool)
    func accept(description: SessionDescription)
    func accept(candidate: IceCandidate)
    func send(_ message: Data)
    func close()
}

/// How much of the room we can reach without the relay.
public struct P2PState: Equatable, Sendable {
    public let peers: Int
    public let direct: Int
    /// True while the document still passes through the relay.
    public let relayed: Bool
}

/// Peer-to-peer over WebRTC, with the relay as its own signalling server.
///
/// The port of `packages/collab/src/webrtc.ts`, message for message — the
/// reasoning is in `docs/research/p2p-any-sync.md`. Two things are worth
/// repeating here because they are what makes the design small:
///
/// **Signalling is opaque bytes broadcast to a room, and a relay room already is
/// one.** There is no signalling server to run: offers, answers and candidates
/// ride the socket the peers already opened, under a message kind older peers
/// ignore.
///
/// **The relay is the TURN server.** When no data channel is open the bytes go
/// over the WebSocket that is already there, so the fallback is not a second
/// service with its own credentials — it is the transport that existed first.
public final class P2PTransport: Transport {
    public var onMessage: ((Data) -> Void)?
    /// The mesh changed. Called on the main queue, for a status line.
    public var onState: ((P2PState) -> Void)?

    private let signalling: Transport
    private let makeLink: () -> PeerLink
    private let me: String
    private var links: [String: PeerLink] = [:]
    /// The relay's count of the room, minus us. `nil` until it says.
    ///
    /// Without this the rule would be "go direct once every peer that greeted me
    /// has a channel" — and a peer that cannot do WebRTC never greets anybody, so
    /// two phones would mesh and silently stop delivering to the `nbe serve` node
    /// in the same room. Counting greeters cannot see a peer that does not greet;
    /// only the relay can.
    private var expected: Int?
    private let lock = NSLock()

    public init(signalling: Transport, id: String = UUID().uuidString, makeLink: @escaping () -> PeerLink) {
        self.signalling = signalling
        self.me = id
        self.makeLink = makeLink

        signalling.onMessage = { [weak self] message in
            self?.receive(message)
        }
        say(Signal(from: me, kind: .hello))
    }

    // MARK: - Transport

    /// Direct when it is direct for *everyone*, the relay otherwise.
    ///
    /// An all-or-nothing switch: with one peer meshed and one still negotiating,
    /// this uses the relay — which reaches both — rather than a channel *and* the
    /// relay, which would reach the meshed peer twice. Duplicate updates are
    /// idempotent, so that is a bandwidth choice and not a correctness one.
    public func send(_ message: Data) {
        lock.lock()
        let direct = meshedLocked() ? Array(links.values) : []
        lock.unlock()
        if direct.isEmpty {
            signalling.send(message)
        } else {
            for link in direct { link.send(message) }
        }
    }

    public func close() {
        say(Signal(from: me, kind: .bye))
        lock.lock()
        let all = links
        links.removeAll()
        lock.unlock()
        for link in all.values { link.close() }
        signalling.close()
    }

    public var state: P2PState {
        lock.lock()
        defer { lock.unlock() }
        return stateLocked()
    }

    // MARK: - Signalling

    /// The signalling message, field for field as `webrtc.ts` writes it.
    private struct Signal: Codable {
        enum Kind: String, Codable {
            case hello, bye, offer, answer, ice, members
        }

        var from: String
        var to: String?
        var kind: Kind
        /// `hello` only: an answer to someone else's hello, so it is not answered
        /// back — two peers would otherwise greet each other forever.
        var reply: Bool?
        /// `members` only: how many peers the relay has in this room, us included.
        var count: Int?
        var sdp: SessionDescription?
        var ice: IceCandidate?
    }

    private func say(_ signal: Signal) {
        guard let json = try? JSONEncoder().encode(signal) else { return }
        signalling.send(envelope(.signal, json))
    }

    private func receive(_ message: Data) {
        guard let first = message.first else { return }
        guard first == Message.signal.rawValue else {
            // the document, still coming over the relay: hand it up unchanged
            onMessage?(message)
            return
        }
        guard let signal = try? JSONDecoder().decode(Signal.self, from: Data(message.dropFirst())) else { return }
        guard signal.from != me, signal.to == nil || signal.to == me else { return }

        switch signal.kind {
        case .members:
            lock.lock()
            expected = max(0, (signal.count ?? 1) - 1)
            let next = stateLocked()
            lock.unlock()
            announce(next)

        case .hello:
            // answer a first hello so the newcomer learns about us; never answer
            // an answer
            if signal.reply != true {
                say(Signal(from: me, to: signal.from, kind: .hello, reply: true))
            }
            link(to: signal.from)

        case .bye:
            drop(signal.from)

        case .offer, .answer:
            // an offer can arrive before the hello that announced its sender
            guard let sdp = signal.sdp, let link = link(to: signal.from) else { return }
            link.accept(description: sdp)

        case .ice:
            guard let ice = signal.ice, let link = link(to: signal.from) else { return }
            link.accept(candidate: ice)
        }
    }

    /// Open a connection to a peer, if there is not one already.
    ///
    /// Who offers is decided by comparing the two ids, not by who arrived first.
    /// That is the cheap way out of glare — both sides offering at once, which
    /// otherwise needs the rollback dance of perfect negotiation to survive.
    @discardableResult
    private func link(to id: String) -> PeerLink? {
        lock.lock()
        if let existing = links[id] {
            lock.unlock()
            return existing
        }
        let link = makeLink()
        links[id] = link
        let offering = me < id
        let next = stateLocked()
        lock.unlock()

        link.onDescription = { [weak self] description in
            guard let self else { return }
            let kind: Signal.Kind = description.type == "offer" ? .offer : .answer
            self.say(Signal(from: self.me, to: id, kind: kind, sdp: description))
        }
        link.onCandidate = { [weak self] candidate in
            guard let self else { return }
            self.say(Signal(from: self.me, to: id, kind: .ice, ice: candidate))
        }
        link.onData = { [weak self] data in
            self?.onMessage?(data)
        }
        link.onOpenChange = { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            let state = self.stateLocked()
            self.lock.unlock()
            self.announce(state)
        }
        link.start(offering: offering)
        announce(next)
        return link
    }

    private func drop(_ id: String) {
        lock.lock()
        let link = links.removeValue(forKey: id)
        let next = stateLocked()
        lock.unlock()
        guard let link else { return }
        link.close()
        announce(next)
    }

    private func announce(_ state: P2PState) {
        DispatchQueue.main.async { self.onState?(state) }
    }

    private func meshedLocked() -> Bool {
        guard !links.isEmpty, links.values.allSatisfy(\.isOpen) else { return false }
        guard let expected else { return true }
        return links.count >= expected
    }

    private func stateLocked() -> P2PState {
        let direct = links.values.filter(\.isOpen).count
        return P2PState(peers: max(links.count, expected ?? 0), direct: direct, relayed: !meshedLocked())
    }
}
