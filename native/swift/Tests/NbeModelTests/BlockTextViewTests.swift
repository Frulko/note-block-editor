#if canImport(AppKit)
import XCTest
import AppKit
@testable import NbeEditorKit
import NbeModel

/// The binding between TextKit and the model.
///
/// Everything here runs without a window, which is the point: the plumbing —
/// typing, deleting, replacing, the grapheme arithmetic — is testable on this
/// machine. IME composition, the software keyboard and touch selection are not,
/// and no amount of this substitutes for the device matrix. What it does buy is
/// that when a device is finally available, a failure there is about the input
/// stack rather than about the binding.
final class BlockTextViewTests: XCTestCase {
    private func view(_ text: String, marks: [Mark]? = nil) -> BlockTextView {
        let v = BlockTextView()
        v.runs = [Run(text: text, marks: marks)]
        return v
    }

    func testRunsReachTheView() {
        XCTAssertEqual(view("bonjour").string, "bonjour")
    }

    func testTypingReportsNewRuns() {
        let v = view("bonjour")
        var reported: [Run]?
        v.onChange = { reported = $0 }

        v.setSelectedRange(NSRange(location: 7, length: 0))
        v.insertText(" monde", replacementRange: NSRange(location: 7, length: 0))

        XCTAssertEqual(v.string, "bonjour monde")
        XCTAssertEqual(reported?.map(\.text).joined(), "bonjour monde")
    }

    func testTypingInsideAMarkedRunKeepsTheMark() {
        // the marks travel as data, so text typed into a marked run inherits it
        let v = view("gras", marks: [Mark(type: "bold")])
        v.setSelectedRange(NSRange(location: 2, length: 0))
        v.insertText("XX", replacementRange: NSRange(location: 2, length: 0))
        XCTAssertEqual(v.string, "grXXas")
        XCTAssertEqual(v.runs.first?.marks, [Mark(type: "bold")])
    }

    func testReplacingASelectionReportsOnce() {
        let v = view("bonjour")
        var calls = 0
        v.onChange = { _ in calls += 1 }
        v.setSelectedRange(NSRange(location: 0, length: 7))
        v.insertText("salut", replacementRange: NSRange(location: 0, length: 7))
        XCTAssertEqual(v.string, "salut")
        XCTAssertEqual(calls, 1, "one edit is one notification")
    }

    func testBackspaceRemovesAWholeEmoji() {
        // the case the model's grapheme arithmetic exists for: a caret placed
        // from a model offset, then a delete
        let v = view("a🌊")
        v.setSelectedRange(NSRange(location: v.string.utf16.count, length: 0))
        v.deleteBackward(nil)
        XCTAssertEqual(v.string, "a", "half a surrogate pair must never survive")
    }

    func testBackspaceRemovesAWholeJoinedSequence() {
        let v = view("x👨‍👩‍👧")
        v.setSelectedRange(NSRange(location: v.string.utf16.count, length: 0))
        v.deleteBackward(nil)
        XCTAssertEqual(v.string, "x", "a ZWJ family is one character to a reader")
    }

    func testSettingRunsDoesNotReportAChange() {
        // a remote edit repaints the view; it must not echo back as a local one
        let v = view("bonjour")
        var calls = 0
        v.onChange = { _ in calls += 1 }
        v.runs = [Run(text: "depuis un pair")]
        XCTAssertEqual(v.string, "depuis un pair")
        XCTAssertEqual(calls, 0)
    }

    func testTextKit2IsTheLayoutPath() {
        // TextKit 1 is the legacy path and NSTextView silently falls back to it
        // if anything touches `layoutManager`; assert we are on the new one
        XCTAssertNotNil(view("bonjour").textLayoutManager)
    }
}
#endif
#if canImport(AppKit)

/// Composition, driven through the same protocol an IME uses.
///
/// `NSTextInputClient` is AppKit's composition entry point, so calling
/// `setMarkedText` directly exercises our handling of it — the same way the web
/// suite drives Chromium's real pipeline through CDP rather than simulating
/// keystrokes. What this still cannot cover is a *particular* IME's behaviour:
/// GBoard lying about its events, a Chinese IME's candidate window, a Korean
/// jamo composer. Those are the device matrix. What it does cover is the rule
/// those devices would otherwise expose the hard way.
final class CompositionTests: XCTestCase {
    private func composing() -> (BlockTextView, () -> [String]) {
        let view = BlockTextView()
        view.runs = [Run(text: "")]
        var seen: [String] = []
        view.onChange = { seen.append($0.map(\.text).joined()) }
        return (view, { seen })
    }

    func testNothingReachesTheModelMidComposition() {
        let (view, seen) = composing()
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 0, length: 0))
        view.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 0, length: 1))
        view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: 0, length: 2))

        /*
         * Each of these would otherwise be a CRDT operation broadcast to every
         * peer — a word being composed here appearing as three pieces of
         * garbage on someone else's screen, and three entries in the history.
         */
        XCTAssertEqual(seen(), [], "marked text is not a document change")
        XCTAssertTrue(view.hasMarkedText())
    }

    func testTheCommitReachesItExactlyOnce() {
        let (view, seen) = composing()
        view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: 0, length: 0))
        view.insertText("日本", replacementRange: NSRange(location: 0, length: 3))

        XCTAssertEqual(seen(), ["日本"], "one composed word is one change")
        XCTAssertFalse(view.hasMarkedText())
        XCTAssertEqual(view.string, "日本")
    }

    func testAnAbandonedCompositionLeavesNothingBehind() {
        // pressing Escape mid-composition, which every IME allows
        let (view, seen) = composing()
        view.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 0, length: 0))
        view.unmarkText()
        view.setSelectedRange(NSRange(location: 0, length: view.string.utf16.count))
        view.insertText("", replacementRange: view.selectedRange())

        XCTAssertEqual(view.string, "")
        XCTAssertEqual(seen().last, "", "the document ends empty, not holding a fragment")
    }

    func testComposingIntoExistingTextDoesNotDisturbIt() {
        let view = BlockTextView()
        view.runs = [Run(text: "bonjour ")]
        var seen: [String] = []
        view.onChange = { seen.append($0.map(\.text).joined()) }

        view.setSelectedRange(NSRange(location: 8, length: 0))
        view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: 8, length: 0))
        XCTAssertEqual(seen, [], "still composing")
        view.insertText("日本", replacementRange: NSRange(location: 8, length: 3))

        XCTAssertEqual(view.string, "bonjour 日本")
        XCTAssertEqual(seen, ["bonjour 日本"])
    }
}
#endif
