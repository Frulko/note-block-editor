import Foundation
import Loro
import NbeModel
import NbeSync
import SwiftUI

/// The document, the connection, and which of the two is carrying it.
///
/// Everything structural is `native/swift`: the same `DocumentWriter` the tests
/// use, the same `SyncSession`, the same `P2PTransport`. What lives here is the
/// part that is genuinely a phone's business — where the caret is, whether the
/// slash menu is open, which toggles are folded — and *none of that is in the
/// document*. A collapsed toggle is a fact about this screen; persisting it would
/// fold someone else's page from here.
@MainActor
final class Room: ObservableObject {
    @Published var blocks: [DocumentOrder.Entry] = []
    @Published var status = "Hors ligne"
    @Published var connected = false
    /// Which block holds the caret, and where it should be put.
    ///
    /// `caret` is consumed once: the view places it and calls back, because a
    /// caret the model kept insisting on would fight every tap the user made
    /// afterwards.
    @Published var focus: Focus?
    @Published var menu: Menu?
    /// Bumped once per caret request, so a view applies each one exactly once.
    ///
    /// SwiftUI may call `updateUIView` several times for one state change. Acting
    /// on `focus.caret` every time re-anchored the caret to the *start* of the
    /// block between two keystrokes — "deux" arrived as "xde". A request is an
    /// event, not a state, and this is what makes it one.
    @Published var focusRequest = 0
    /// Bumped on every model change that a keystroke in a text view did *not*
    /// cause — a peer's edit, a split, a slash-menu transformation.
    ///
    /// The view cannot tell those from the echo of its own typing by comparing
    /// text: both look like "the model differs from what I hold". Without this, a
    /// queued render carrying a stale entry resets the text under the caret and
    /// scrambles what was being typed ("deux" came back as "xde"); *with* it but
    /// counting only remote edits, the slash menu stripped the `/` in the model
    /// and the view kept showing it. The line is exactly "did this view type it".
    @Published var modelRevision = 0


    struct Focus: Equatable {
        var id: String
        /// A UTF-16 offset, or `nil` for "focus it, leave the caret alone".
        var caret: Int?
    }

    struct Menu: Equatable, Identifiable {
        var id: String
        /// Where the `/` sits, so it and the query can be removed on choosing.
        /// `nil` when the menu was opened from the button rather than by typing.
        var anchor: Int?
        var query: String
    }

    private var writer: DocumentWriter?
    private var session: SyncSession?
    private var transport: P2PTransport?
    private var collapsed: Set<String> = []
    private var pageId = "page"
    /// A caret in transit, and the keystrokes that arrived while it was.
    ///
    /// A split tells the model where the caret goes immediately; SwiftUI builds
    /// the receiving text view a frame later. Anything typed in that gap waits
    /// here rather than landing in the block the caret just left.
    ///
    /// **The target and the buffer are one value on purpose.** They were two, and
    /// the bug that taught the difference was worth the lesson: a character that
    /// nobody claimed stayed in the buffer, and the *next* block to be given a
    /// caret — a delete, a reorder, minutes later — flushed it into itself. A
    /// stray letter appearing in another paragraph reads as a typo, not as a bug,
    /// which is exactly why it must not be possible. Buffered text belongs to one
    /// handover and dies with it.
    private var handoverTarget: String?
    private var handoverBuffer = ""

    /// Give up on a caret in transit. Anything buffered for it is dropped, which
    /// is right: the keystrokes were meant for a block the user has since left.
    private func endHandover() {
        handoverTarget = nil
        handoverBuffer = ""
    }

    // MARK: - Joining

    func join(relay: String, room: String) {
        leave()
        guard let url = URL(string: relay) else {
            status = "Adresse invalide"
            return
        }
        /// Derived from the room name, and it has to match `examples/collab`
        /// exactly (`<salon>-root`) or the two clients sync one document and each
        /// render a different page of it — everything converges and both screens
        /// look empty, which is the confusing kind of broken.
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
        endHandover()
        session?.stop()
        session = nil
        transport = nil
        writer = nil
        blocks = []
        focus = nil
        menu = nil
        collapsed = []
        connected = false
        status = "Hors ligne"
    }

    // MARK: - What the text view asks for

    func actions(for entry: DocumentOrder.Entry) -> BlockTextEditor.Actions {
        BlockTextEditor.Actions(
            write: { [weak self] text in self?.write(text, to: entry.id) },
            split: { [weak self] offset in self?.split(entry.id, at: offset) },
            mergeBackward: { [weak self] in self?.mergeBackward(entry.id) },
            turnInto: { [weak self] rule in self?.apply(rule, to: entry.id) },
            indent: { [weak self] in self?.indent(entry.id) },
            outdent: { [weak self] in self?.outdent(entry.id) },
            openMenu: { [weak self] anchor in
                self?.menu = Menu(id: entry.id, anchor: anchor, query: "")
            },
            refineMenu: { [weak self] query in
                guard let self, var open = self.menu, open.id == entry.id else { return }
                open.query = query
                self.menu = open
            },
            closeMenu: { [weak self] in
                if self?.menu?.id == entry.id { self?.menu = nil }
            },
            focused: { [weak self] in
                guard let self, self.focus?.id != entry.id else { return }
                // a handover in flight is not the user tapping somewhere: the
                // model already knows where the caret is going, and letting
                // `becomeFirstResponder` overwrite that loses the pending caret
                guard self.handoverTarget == nil || self.handoverTarget == entry.id else { return }
                self.focus = Focus(id: entry.id, caret: nil)
            },
            caretPlaced: { [weak self] in
                guard let self else { return }
                // the handover is over only now: the caret is where it was asked
                // to be and everything buffered for it has been inserted
                if self.handoverTarget == entry.id { self.endHandover() }
                guard var current = self.focus, current.caret != nil else { return }
                current.caret = nil
                self.focus = current
            },
            holdsCaret: { [weak self] in
                /*
                 * Only an in-flight handover can refuse a keystroke.
                 *
                 * The first version also compared against `focus`, and that was
                 * wrong in a way a screenshot finally showed: a view being asked
                 * whether it may accept a character *is* the first responder — the
                 * user is typing into it — while `focus` is published state that
                 * lags by a frame after a tap. So tapping another block and typing
                 * immediately had its first characters refused, buffered against a
                 * handover that did not exist, and dropped. "deux" arrived as
                 * "dex". The first responder is the truth about the caret;
                 * `handoverTarget` is the one case where the model knows better,
                 * because it is the model that moved it.
                 */
                guard let self, let target = self.handoverTarget else { return true }
                return target == entry.id
            },
            // appended unconditionally: writing into an optional that the
            // *taking* had just cleared silently dropped the keystroke — "deux"
            // arrived as "dux". A buffered character must always land somewhere
            buffer: { [weak self] text in self?.handoverBuffer += text },
            takeBuffer: { [weak self] in
                // only the block the handover was for, so an unclaimed keystroke
                // can never surface in some other paragraph later. The *target*
                // survives until the caret is confirmed placed, so a keystroke
                // arriving in between is accepted here rather than buffered into
                // nothing
                guard let self, self.handoverTarget == entry.id else { return "" }
                let held = self.handoverBuffer
                self.handoverBuffer = ""
                return held
            }
        )
    }

    /// A keystroke. Diffed by `DocumentWriter.setText`, so it stays a keystroke
    /// on the wire rather than a whole-paragraph replacement — which is what lets
    /// two people type in one paragraph and keep both sentences.
    private func write(_ text: String, to id: String) {
        try? writer?.setText(text, forBlock: id)
        // no `reload()`: the view already shows what was typed, and repainting
        // under the caret is how a text field loses a keystroke
        refreshEntry(id)
    }

    // MARK: - Structure

    private func split(_ id: String, at offset: Int) {
        guard let writer else { return }
        let landing = (try? writer.splitBlock(id, at: offset, newId: UUID().uuidString)) ?? (id: id, offset: offset)
        // claimed before anything is published, so the block being left cannot
        // accept another keystroke even for one frame
        handoverTarget = landing.id
        reload()
        requestFocus(landing.id, caret: landing.offset)
    }

    private func mergeBackward(_ id: String) {
        guard let writer else { return }
        // `nil` is the first block of the document: nothing to merge into, and
        // deleting it would leave nowhere to type
        guard let landing = (try? writer.mergeBackward(id)) ?? nil else { return }
        handoverTarget = landing.id
        reload()
        requestFocus(landing.id, caret: landing.offset)
    }

    /// A markdown prefix was recognised. The text has **already** been stripped
    /// by the view, which owns the caret; this only changes what the block is.
    private func apply(_ rule: Autoformat.Rule, to id: String) {
        guard let writer else { return }
        try? writer.turnInto(id, type: rule.type, props: rule.props)

        if rule.type == "divider" {
            // a divider has no caret, so it comes with a paragraph to carry on in
            let next = UUID().uuidString
            _ = try? writer.splitBlock(id, at: 0, newId: next)
            try? writer.turnInto(next, type: "paragraph")
            reload()
            requestFocus(next, caret: 0)
            return
        }
        // the row changes shape (a heading is a different font), so the list is
        // rebuilt — but the caret is left exactly where the view put it
        reload()
    }

    func indent(_ id: String) {
        endHandover()
        guard (try? writer?.indent(id)) == true else { return }
        reload()
        requestFocus(id, caret: nil)
    }

    func outdent(_ id: String) {
        endHandover()
        guard (try? writer?.outdent(id)) == true else { return }
        reload()
        requestFocus(id, caret: nil)
    }

    func move(_ id: String, after sibling: String) {
        endHandover()
        guard id != sibling else { return }
        try? writer?.move(id, after: sibling)
        reload()
    }

    /// Swap with the block above it, keeping the caret in it.
    func moveUp(_ id: String) {
        endHandover()
        guard let here = blocks.firstIndex(where: { $0.id == id }), here > 0 else { return }
        // one place up means "after whatever the block above was after", and the
        // top of the list has no such thing — hence the nil
        let anchor = here >= 2 ? blocks[here - 2].id : nil
        try? writer?.move(id, after: anchor)
        reload()
        requestFocus(id, caret: nil)
    }

    func moveDown(_ id: String) {
        endHandover()
        guard let here = blocks.firstIndex(where: { $0.id == id }), here + 1 < blocks.count else { return }
        try? writer?.move(id, after: blocks[here + 1].id)
        reload()
        requestFocus(id, caret: nil)
    }

    func remove(_ id: String) {
        endHandover()
        guard let writer, blocks.count > 1 else { return }
        let previous = blocks.prefix(while: { $0.id != id }).last
        try? writer.remove(id)
        reload()
        if let previous { requestFocus(previous.id, caret: previous.text?.utf16.count ?? 0) }
    }

    func setChecked(_ id: String, _ checked: Bool) {
        try? writer?.setProp(id, key: "checked", value: .bool(checked))
        reload()
    }

    /// Append a paragraph at the end and put the caret in it.
    func appendAtEnd() {
        endHandover()
        guard let writer else { return }
        let id = UUID().uuidString
        if let last = blocks.last {
            _ = try? writer.splitBlock(last.id, at: last.text?.utf16.count ?? 0, newId: id)
        } else {
            try? writer.appendParagraph("", parentId: pageId, id: id)
        }
        reload()
        requestFocus(blocks.last?.id ?? id, caret: 0)
    }

    /// Put the caret somewhere, once.
    private func requestFocus(_ id: String, caret: Int?) {
        focus = Focus(id: id, caret: caret)
        if caret != nil { focusRequest += 1 }
    }

    /// Nothing holds the caret any more, so the keyboard bar goes away with it.
    func clearFocus() {
        endHandover()
        focus = nil
    }

    // MARK: - The slash menu

    /// Opened from the keyboard bar rather than by typing `/`.
    func openMenuFromButton() {
        guard let id = focus?.id else { return }
        menu = Menu(id: id, anchor: nil, query: "")
    }

    func dismissMenu() {
        menu = nil
    }

    /// - Parameter open: the menu as the sheet held it, **passed in** rather than
    ///   read back from `menu`. Reading it back was a bug that looked like a dead
    ///   button: a detent change can drive the presentation binding, which cleared
    ///   `menu`, and then choosing an item returned at the first guard — no
    ///   transformation, no dismissal, nothing to see. The sheet already has the
    ///   value; asking for it twice is what created the window to lose it.
    func choose(_ item: BlockCatalogue.Item, for open: Menu) {
        endHandover()
        guard let writer else { return }
        menu = nil

        /*
         * The `/` and the word after it go away — they were a command, not text.
         *
         * Bounded by the next space rather than by the length of what was typed
         * into the sheet: the sheet holds the keyboard, so its query was never in
         * the block, and trusting its length would delete real words to the right
         * of the trigger.
         */
        if let anchor = open.anchor, let text = blocks.first(where: { $0.id == open.id })?.text {
            let units = Array(text.utf16)
            let space = UInt16(UnicodeScalar(" ").value)
            var end = min(anchor + 1, units.count)
            while end < units.count, units[end] != space { end += 1 }
            let head = String(decoding: Array(units.prefix(anchor)), as: UTF16.self)
            let tail = String(decoding: Array(units.suffix(from: end)), as: UTF16.self)
            try? writer.setText(head + tail, forBlock: open.id)
        }

        if item.type == "divider" {
            try? writer.turnInto(open.id, type: "divider")
            let next = UUID().uuidString
            _ = try? writer.splitBlock(open.id, at: 0, newId: next)
            try? writer.turnInto(next, type: "paragraph")
            reload()
            requestFocus(next, caret: 0)
            return
        }

        try? writer.turnInto(open.id, type: item.type, props: item.props)
        reload()
        requestFocus(open.id, caret: blocks.first { $0.id == open.id }?.text?.utf16.count ?? 0)
    }

    // MARK: - Toggles, which are this screen's business only

    func isCollapsed(_ id: String) -> Bool { collapsed.contains(id) }

    func toggleCollapsed(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
        reload()
    }

    // MARK: - Reading

    private func seedIfEmpty() {
        guard let writer else { return }
        let existing = (try? DocumentOrder(doc: writer.doc).entries()) ?? []
        guard existing.isEmpty else { return }
        try? writer.createPage(id: pageId, title: "Notes")
        try? writer.appendParagraph("", parentId: pageId, id: UUID().uuidString)
    }

    /// Rebuild the visible list from the document.
    ///
    /// Every caller is a *structural* change — a peer's update, a split, a menu
    /// choice — so this is where the revision is bumped. Typing goes through
    /// `refreshEntry` instead and deliberately does not bump it, which is what
    /// keeps a view from being repainted with its own echo.
    private func reload() {
        modelRevision += 1
        guard let writer else { return }
        let entries = (try? DocumentOrder(doc: writer.doc).entries()) ?? []
        var hiddenUnder: [String] = []
        var visible: [DocumentOrder.Entry] = []

        for entry in entries where entry.type != "page" {
            // drop anything inside a folded toggle, by depth rather than by a
            // parent walk — the list is already in reading order
            while let last = hiddenUnder.last,
                  let depth = entries.first(where: { $0.id == last })?.depth,
                  entry.depth <= depth {
                hiddenUnder.removeLast()
            }
            if !hiddenUnder.isEmpty { continue }
            visible.append(entry)
            if entry.type == "toggle", collapsed.contains(entry.id) { hiddenUnder.append(entry.id) }
        }
        blocks = visible
    }

    /// Refresh one block without rebuilding the list.
    ///
    /// Typing must not reorder or recreate rows: SwiftUI would rebuild the text
    /// view, and the caret would jump to the end of the line every few
    /// characters. So a keystroke updates exactly the entry that changed.
    private func refreshEntry(_ id: String) {
        guard let writer, let index = blocks.firstIndex(where: { $0.id == id }) else { return }
        guard let fresh = (try? DocumentOrder(doc: writer.doc).entries())?.first(where: { $0.id == id }) else { return }
        blocks[index] = fresh
    }
}
