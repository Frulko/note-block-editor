import Foundation
import NbeSync
import WebRTC

/// A real WebRTC data channel, standing in for `NbeSync`'s `PeerLink`.
///
/// This is the only file in the project that imports WebRTC, and that is the
/// point of the protocol it implements: `native/swift` describes the negotiation
/// and the mesh without owning a 40MB binary, so `swift test` checks the state
/// machine and this checks that a real ICE agent agrees with it.
///
/// **Two details are not optional and both bit before they were written down.**
///
/// Candidates arrive before the remote description more often than not — ICE
/// gathering starts as soon as the offer is created — and `add(_:)` fails on a
/// connection with no remote description. So they are buffered until there is
/// one. Skipping that produces a connection that works on a fast LAN and fails
/// on a slow one, which is the worst kind of intermittent.
///
/// The answering side never calls `createDataChannel`: it receives the channel
/// through the delegate. Creating one on both sides yields two channels, one of
/// which nobody reads.
final class WebRTCLink: NSObject, PeerLink, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    var onData: ((Data) -> Void)?
    var onOpenChange: ((Bool) -> Void)?
    var onDescription: ((SessionDescription) -> Void)?
    var onCandidate: ((IceCandidate) -> Void)?

    var isOpen: Bool { channel?.readyState == .open }

    /// One factory for the process. Creating one per connection is the classic
    /// way to make WebRTC look slow.
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil)
    }()

    private var connection: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var hasRemoteDescription = false
    private var queued: [RTCIceCandidate] = []

    override init() {
        super.init()
        let configuration = RTCConfiguration()
        configuration.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        connection = WebRTCLink.factory.peerConnection(with: configuration, constraints: constraints, delegate: self)
    }

    func start(offering: Bool) {
        guard offering, let connection else { return }
        let configuration = RTCDataChannelConfiguration()
        configuration.isOrdered = true
        channel = connection.dataChannel(forLabel: "nbe", configuration: configuration)
        channel?.delegate = self

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        connection.offer(for: constraints) { [weak self] offer, _ in
            guard let self, let offer else { return }
            connection.setLocalDescription(offer) { _ in
                self.onDescription?(SessionDescription(type: "offer", sdp: offer.sdp))
            }
        }
    }

    func accept(description: SessionDescription) {
        guard let connection else { return }
        let type: RTCSdpType = description.type == "offer" ? .offer : .answer
        connection.setRemoteDescription(RTCSessionDescription(type: type, sdp: description.sdp)) { [weak self] _ in
            guard let self else { return }
            self.hasRemoteDescription = true
            for candidate in self.queued { connection.add(candidate) { _ in } }
            self.queued.removeAll()

            guard type == .offer else { return }
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            connection.answer(for: constraints) { answer, _ in
                guard let answer else { return }
                connection.setLocalDescription(answer) { _ in
                    self.onDescription?(SessionDescription(type: "answer", sdp: answer.sdp))
                }
            }
        }
    }

    func accept(candidate: IceCandidate) {
        let ice = RTCIceCandidate(
            sdp: candidate.candidate,
            sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
            sdpMid: candidate.sdpMid
        )
        guard hasRemoteDescription, let connection else {
            queued.append(ice)
            return
        }
        connection.add(ice) { _ in }
    }

    func send(_ message: Data) {
        channel?.sendData(RTCDataBuffer(data: message, isBinary: true))
    }

    func close() {
        channel?.close()
        connection?.close()
        channel = nil
        connection = nil
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ connection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onCandidate?(
            IceCandidate(candidate: candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex)
        )
    }

    /// The answering side's channel arrives here rather than being created.
    func peerConnection(_ connection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        channel = dataChannel
        dataChannel.delegate = self
        onOpenChange?(dataChannel.readyState == .open)
    }

    func peerConnection(_ connection: RTCPeerConnection, didChange state: RTCIceConnectionState) {
        if state == .failed || state == .closed { onOpenChange?(false) }
    }

    func peerConnectionShouldNegotiate(_ connection: RTCPeerConnection) {}
    func peerConnection(_ connection: RTCPeerConnection, didChange state: RTCSignalingState) {}
    func peerConnection(_ connection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ connection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ connection: RTCPeerConnection, didChange state: RTCIceGatheringState) {}
    func peerConnection(_ connection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    // MARK: - RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        onOpenChange?(dataChannel.readyState == .open)
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        onData?(buffer.data)
    }
}
