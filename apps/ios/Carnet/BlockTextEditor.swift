import NbeModel
import NbeSync
import SwiftUI
import UIKit

/// One block's text, as an editing surface.
///
/// D1 says one editing host per block, and this is that host on iOS: a
/// `UITextView` per block rather than one view for the document. It is the
/// UIKit sibling of `NbeEditorKit.BlockTextView` (AppKit), and it exists as a
/// `UIViewRepresentable` rather than a `TextField` for reasons that are not
/// stylistic — SwiftUI's text controls cannot report **Backspace at offset 0**
/// or intercept **Return**, and those two keystrokes are most of what makes a
/// block editor a block editor.
///
/// **The model is authoritative.** The view is fed text and reports text back;
/// it never becomes the source of truth. That is the rule the web editor follows
/// and the reason a peer's edit can repaint this view without it arguing.
///
/// **Nothing reaches the model mid-composition.** `markedTextRange` is the
/// UIKit spelling of §5.1's ironclad rule: an IME reports every intermediate
/// state, and each one would otherwise become a CRDT operation broadcast to
/// every peer — so a word being composed here would arrive as three pieces of
/// garbage on someone else's screen. The AppKit side guards this with
/// `hasMarkedText()`; this is the same guard.
struct BlockTextEditor: UIViewRepresentable {
    let entry: DocumentOrder.Entry
    let placeholder: String
    /// Whether this block should hold the caret, and where.
    let caret: Int?
    /// Identifies the caret request, so it is applied once and not per render.
    let focusRequest: Int
    /// Changes on every model change this view did not type.
    let modelRevision: Int
    /// This block's position in the document.
    ///
    /// Only used as the view's accessibility identifier, and only for the UI
    /// tests — but it earns its place: without a stable name per *position*, a
    /// test that checks the order after a reorder has to resolve rows by index,
    /// and an index-resolved element keeps pointing at the row it first matched.
    let position: Int
    let actions: Actions

    struct Actions {
        /// The text changed. Plain text: this view renders no marks, and the
        /// writer diffs rather than replaces so a keystroke stays a keystroke.
        var write: (String) -> Void
        /// Return was pressed, at this UTF-16 offset.
        var split: (Int) -> Void
        /// Backspace was pressed with the caret at the very start.
        var mergeBackward: () -> Void
        /// A markdown prefix was recognised: strip it and change the block.
        var turnInto: (Autoformat.Rule) -> Void
        var indent: () -> Void
        var outdent: () -> Void
        /// `/` was typed at this offset — open the menu.
        var openMenu: (Int) -> Void
        /// The menu is open and its query changed.
        var refineMenu: (String) -> Void
        var closeMenu: () -> Void
        /// This block took the caret.
        var focused: () -> Void
        /// The caret was placed; stop asking for it.
        var caretPlaced: () -> Void
        /// Whether this block is the one the model says holds the caret.
        var holdsCaret: () -> Bool
        /// Keep a keystroke that arrived while the caret was moving elsewhere.
        var buffer: (String) -> Void
        /// Take what was buffered, to insert at the caret. Clears it.
        var takeBuffer: () -> String
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = false // so it sizes to its content inside the list
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.smartDashesType = .no // "--" must stay "--": it is our divider prefix
        view.smartQuotesType = .no // and `" ` is the quote prefix
        view.autocorrectionType = .yes
        view.spellCheckingType = .yes
        view.accessibilityIdentifier = "bloc-\(position)"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.actions = actions
        context.coordinator.entry = entry

        view.accessibilityIdentifier = "bloc-\(position)"

        let text = entry.text ?? ""
        let elsewhere = modelRevision != context.coordinator.lastModelRevision
        context.coordinator.lastModelRevision = modelRevision
        /*
         * **The view wins over the model while it holds the caret**, and this is
         * the rule that makes per-block editing survive SwiftUI at all. A render
         * can be queued with a stale entry and arrive after two more keystrokes;
         * assigning the model's text then resets what was being typed. "deux"
         * came back as "xde" until this condition existed.
         *
         * A change made *elsewhere* is the exception — a peer, a split, the slash
         * menu removing the `/` — and the only reliable way to know one is for the
         * model to say so. The text alone cannot tell an incoming edit from the
         * echo of an outgoing one.
         */
        let repositioning = caret != nil && focusRequest != context.coordinator.lastFocusRequest
        if view.text != text, view.markedTextRange == nil, elsewhere || repositioning || !view.isFirstResponder {
            let selection = view.selectedRange
            view.text = text
            // a remote edit that grew the block must not send the caret to the
            // start of it, which is what assigning `text` does on its own
            view.selectedRange = NSRange(location: min(selection.location, text.utf16.count), length: 0)
        }

        view.font = BlockCatalogue.uiFont(for: entry)
        view.textColor = entry.type == "quote" ? .secondaryLabel : .label
        if entry.type == "to_do", entry.isChecked {
            view.textColor = .secondaryLabel
            view.attributedText = NSAttributedString(
                string: text,
                attributes: [
                    .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                    .font: BlockCatalogue.uiFont(for: entry),
                    .foregroundColor: UIColor.secondaryLabel,
                ]
            )
        }

        context.coordinator.placeholder(placeholder, in: view)

        if let caret, repositioning {
            context.coordinator.lastFocusRequest = focusRequest
            /*
             * Asked for by the model after a split or a merge, and taken
             * **synchronously**. The first version deferred this to the next
             * runloop turn, and the gap was long enough to lose a keystroke:
             * type "un⏎deux" quickly and the "de" went into the block Return had
             * just left, giving "unde" and "ux". A caret handover is not a
             * cosmetic update; it decides where the next character goes.
             */
            if !view.isFirstResponder { view.becomeFirstResponder() }
            let clamped = min(caret, view.text.utf16.count)
            view.selectedRange = NSRange(location: clamped, length: 0)

            // whatever was typed during the handover, in order, as if it had
            // always been meant for here
            let buffered = actions.takeBuffer()
            if !buffered.isEmpty { view.insertText(buffered) }

            // clearing the request is deferred, because it publishes to the
            // observable object this update is already reading
            DispatchQueue.main.async { actions.caretPlaced() }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(entry: entry, actions: actions)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var entry: DocumentOrder.Entry
        var actions: Actions
        var lastModelRevision = 0
        var lastFocusRequest = 0
        /// The last text this view handed to the model.
        var lastWritten: String?
        /// Where the `/` that opened the menu sits, so its query can be read
        /// back out of the text and removed when an item is chosen.
        private var menuAnchor: Int?
        private weak var placeholderLabel: UILabel?

        init(entry: DocumentOrder.Entry, actions: Actions) {
            self.entry = entry
            self.actions = actions
        }

        // MARK: - Placeholder

        /// UIKit has no placeholder for `UITextView`, so it is a label behind it.
        func placeholder(_ text: String, in view: UITextView) {
            if placeholderLabel == nil {
                let label = UILabel()
                label.textColor = .tertiaryLabel
                label.numberOfLines = 1
                label.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(label)
                NSLayoutConstraint.activate([
                    label.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                    label.topAnchor.constraint(equalTo: view.topAnchor),
                ])
                placeholderLabel = label
            }
            placeholderLabel?.text = text
            placeholderLabel?.font = view.font
            placeholderLabel?.isHidden = !view.text.isEmpty
        }

        // MARK: - Keystrokes

        func textView(
            _ view: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            /*
             * A keystroke that arrives while the caret is on its way to another
             * block belongs to that block, not to this one.
             *
             * This is the fix for a bug a test found and a person would have
             * called "it eats letters": typing "un⏎deux" fast put "de" back into
             * the block Return had just left, giving "unde" and "ux". A split
             * changes what the model says holds the caret *synchronously*, but
             * SwiftUI creates the new text view a frame later, and this view is
             * still the first responder in between. So the gap is buffered rather
             * than narrowed — narrowing it only makes the bug rarer.
             */
            if !actions.holdsCaret() {
                if !text.isEmpty { actions.buffer(text) }
                return false
            }

            /*
             * Return splits the block instead of inserting a newline. A block's
             * text is one paragraph by definition (§2.1) — a newline inside it
             * would be a second block hiding in the first, invisible to every
             * other client and unrepresentable in Markdown.
             */
            if text == "\n" {
                closeMenu()
                actions.split(range.location)
                return false
            }

            // Backspace with nothing behind it: UIKit reports (0,0) and an empty
            // replacement, which is the only way to see this keystroke at all
            if text.isEmpty, range.location == 0, range.length == 0 {
                closeMenu()
                actions.mergeBackward()
                return false
            }

            // A hardware keyboard only — the software one has no Tab — so the
            // buttons above the keyboard are the real path for this on a phone
            if text == "\t" {
                actions.indent()
                return false
            }

            return true
        }

        func textViewDidChange(_ view: UITextView) {
            // §5.1: nothing at all while an IME is composing
            guard view.markedTextRange == nil else { return }
            let text = view.text ?? ""
            let caret = view.selectedRange.location

            /*
             * Autoformat strips the prefix **in the view, synchronously**, and
             * only then tells the model. Going through the model first was the
             * first version and it was wrong in a way only a driven keystroke
             * shows: the model stripped the text, SwiftUI repainted a frame
             * later, and everything typed in between landed at the old caret —
             * "# Titre" came back as "e# Titr". The view owns the caret; the
             * model owns the content. Both are true, and the order matters.
             */
            // the caret must be past the prefix, or a rule would fire while the
            // user is still inside the characters that trigger it
            let before = String(text.prefix(upTo: Offsets.index(in: text, at: caret)))
            if text == Autoformat.dividerText, before == text {
                view.text = ""
                lastWritten = ""
                actions.write("")
                actions.turnInto(Autoformat.Rule(prefix: Autoformat.dividerText, type: "divider"))
                return
            }
            /*
             * `opening` rather than `match`, so a batch of keystrokes — or a paste
             * — is recognised too. The guard on the type is what keeps it from
             * firing forever: a bullet whose text still starts with "- " has
             * already been converted and the characters are the user's.
             */
            if let rule = Autoformat.opening(before), rule.type != entry.type {
                let stripped = String(text.dropFirst(before.count))
                view.text = stripped
                view.selectedRange = NSRange(location: 0, length: 0)
                placeholderLabel?.isHidden = !stripped.isEmpty
                lastWritten = stripped
                actions.write(stripped)
                actions.turnInto(rule)
                return
            }

            lastWritten = text
            actions.write(text)
            updateMenu(text: text, caret: caret)
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            actions.focused()
        }

        func textViewDidEndEditing(_ view: UITextView) {
            /*
             * The menu is deliberately **not** closed here, and that is the whole
             * of a bug worth remembering: presenting the sheet takes the keyboard
             * away from this text view, which ends editing, which used to close
             * the menu — so typing `/` opened a sheet that dismissed itself in
             * the same frame. Losing focus is a *consequence* of the menu, not a
             * reason to cancel it.
             *
             * The anchor is kept for the same reason: whoever chooses an item
             * still needs to know which `/` to remove.
             */
        }

        // MARK: - The slash menu

        private func updateMenu(text: String, caret: Int) {
            let utf16 = Array(text.utf16)
            guard caret <= utf16.count else { return }

            if menuAnchor == nil {
                // opened by the `/` itself, and only when it starts a word — so
                // `and/or` does not open a menu mid-sentence
                guard caret > 0, utf16[caret - 1] == UInt16(UnicodeScalar("/").value) else { return }
                let previous = caret >= 2 ? utf16[caret - 2] : UInt16(UnicodeScalar(" ").value)
                guard previous == UInt16(UnicodeScalar(" ").value) || caret == 1 else { return }
                menuAnchor = caret - 1
                actions.openMenu(caret - 1)
                return
            }

            guard let anchor = menuAnchor else { return }
            // the caret moved back past the `/`, or the `/` was deleted
            guard caret > anchor, anchor < utf16.count,
                  utf16[anchor] == UInt16(UnicodeScalar("/").value)
            else {
                closeMenu()
                return
            }
            let query = String(decoding: utf16[(anchor + 1)..<caret])
            // a space ends it: someone is writing a sentence, not a command
            if query.contains(" ") { closeMenu() } else { actions.refineMenu(query) }
        }

        private func closeMenu() {
            guard menuAnchor != nil else { return }
            menuAnchor = nil
            actions.closeMenu()
        }
    }
}

private extension String {
    init(decoding units: ArraySlice<UInt16>) {
        self = String(decoding: Array(units), as: UTF16.self)
    }
}
