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
