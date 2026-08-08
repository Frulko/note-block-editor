import Foundation

/// A transport over a WebSocket to `nbe relay`.
///
/// No dependency: `URLSessionWebSocketTask` is in Foundation, and this only
/// needs the client half.
///
/// **Messages sent before the socket opens are queued rather than dropped.**
/// `SyncSession` announces its version vector in its initialiser, and losing
/// that announcement is a peer that never catches up — the failure that looks
/// like it works.
///
/// Reconnection is the caller's business, which is the same line the TypeScript
/// transport takes and for the same reason: how long to wait and whether to give
/// up differ between an app in the foreground and a process meant to run for
/// months. What this guarantees is that reconnecting is cheap and correct.
public final class RelayTransport: NSObject, Transport, URLSessionWebSocketDelegate {
    public var onMessage: ((Data) -> Void)?
    /// The socket opened or closed. Called on the main queue.
    public var onOpenChange: ((Bool) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pending: [Data] = []
    private var isOpen = false
    private var closed = false
    private let lock = NSLock()

    /// - Parameters:
    ///   - url: the relay, e.g. `ws://192.168.1.10:8787`.
    ///   - room: appended as `?room=`, the way every other client joins.
    public init(url: URL, room: String) {
        super.init()
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "room", value: room))
        components.queryItems = query

        let configuration = URLSessionConfiguration.default
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        task = session?.webSocketTask(with: components.url!)
        task?.resume()
        listen()
    }

    /// One receive at a time, re-armed after each message — the shape
    /// `URLSessionWebSocketTask` requires.
    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(.data(data)):
                self.onMessage?(data)
                self.listen()
            case .success(.string):
                // not ours: some proxies inject text keepalives
                self.listen()
            case .success:
                self.listen()
            case .failure:
                self.markClosed()
            }
        }
    }

    public func send(_ message: Data) {
        lock.lock()
        if !isOpen {
            if !closed { pending.append(message) }
            lock.unlock()
            return
        }
        lock.unlock()
        task?.send(.data(message)) { _ in
            // a failed frame is followed by a socket failure, which is where the
            // caller's reconnection decision lives
        }
    }

    public func close() {
        markClosed()
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    private func markClosed() {
        lock.lock()
        let was = isOpen
        isOpen = false
        closed = true
        pending.removeAll()
        lock.unlock()
        if was { DispatchQueue.main.async { self.onOpenChange?(false) } }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        lock.lock()
        isOpen = true
        let queued = pending
        pending.removeAll()
        lock.unlock()
        for message in queued { webSocketTask.send(.data(message)) { _ in } }
        DispatchQueue.main.async { self.onOpenChange?(true) }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        markClosed()
    }
}
