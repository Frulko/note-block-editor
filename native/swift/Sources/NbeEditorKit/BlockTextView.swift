#if canImport(AppKit)
import AppKit
import NbeModel

/// One block's text, as an editing surface.
///
/// D1 says one editing host per block, and this is that host on macOS: a
/// `NSTextView` per block rather than one view for the document. The evidence
/// note (`docs/research/per-block-contenteditable-evidence.md`) says that
/// choice is the one owing proof on mobile — so this deliberately keeps the
/// binding thin enough that a single-host variant would reuse all of it.
///
/// **The model is authoritative.** The view is fed from runs and reports back
/// as runs; it never becomes the source of truth. That is the same rule the web
/// editor follows, and it is what lets a remote edit repaint the view without
/// the view arguing.
///
/// **What this can and cannot be tested for, honestly.** Everything here works
/// without a window, so the binding — typing, deleting, replacing, the
/// grapheme arithmetic — is under test. What is *not* is IME composition,
/// the software keyboard, and touch selection, because those come from a real
/// input stack. Those are the device matrix, and no amount of headless testing
/// substitutes for them.
public final class BlockTextView: NSTextView {
    /// Called after every edit, with the block's new runs.
    public var onChange: (([Run]) -> Void)?

    /// The block's text, model-side. Setting it repaints without notifying.
    public var runs: [Run] = [] {
        didSet { render() }
    }

    private var applying = false

    public convenience init() {
        self.init(frame: NSRect(x: 0, y: 0, width: 600, height: 24))
        isRichText = false
        allowsUndo = false // undo is the model's, and it spans blocks
        delegate = nil
    }

    private func render() {
        applying = true
        textStorage?.setAttributedString(AttributedText.from(runs: runs))
        applying = false
    }

    public override func didChangeText() {
        super.didChangeText()
        guard !applying, let storage = textStorage else { return }
        /*
         * §5.1's ironclad rule, in its AppKit form: **nothing reaches the model
         * mid-composition.** An IME reports every intermediate state — typing
         * "にほん" fires three times before the commit — and each one would
         * become a CRDT operation broadcast to every peer, so a word being
         * composed here would appear as three pieces of garbage on someone
         * else's screen and land in the undo history.
         *
         * Measured, not assumed: driving `setMarkedText` reported "に", "にほ",
         * "にほん" and then "日本". The web editor has guarded this from the
         * start through `view.composing`; this is the same rule, and the Swift
         * side simply did not have it.
         */
        if hasMarkedText() { return }
        let updated = AttributedText.toRuns(storage)
        // keep the property in step without repainting under the caret
        applying = true
        runs = updated
        applying = false
        onChange?(updated)
    }

    /// Delete backwards by a whole grapheme, never half of one.
    ///
    /// `NSTextView` already does this for most input, and does not when the
    /// selection was set programmatically to an offset that came from the
    /// model — which is exactly what a remote edit or a restored caret
    /// produces. Snapping here costs nothing and closes that gap.
    public override func deleteBackward(_ sender: Any?) {
        let text = string
        let caret = selectedRange()
        if caret.length == 0, caret.location > 0 {
            let from = Offsets.previousGrapheme(in: text, from: caret.location)
            setSelectedRange(NSRange(location: from, length: caret.location - from))
        }
        super.deleteBackward(sender)
    }
}
#endif
