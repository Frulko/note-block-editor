import XCTest
@testable import NbeEditorKit
import NbeModel

/// Runs through attributed text and back.
///
/// The property worth protecting is not that bold looks bold — it is that a
/// mark this layer has no visual for still survives. A link's href, a comment's
/// thread id and a mark a plugin invented all carry data the editor needs, and
/// a projection that dropped them would lose it silently.
final class AttributedTextTests: XCTestCase {
    private func roundTrip(_ runs: [Run]) -> [Run] {
        AttributedText.toRuns(AttributedText.from(runs: runs))
    }

    func testPlainTextSurvives() {
        XCTAssertEqual(roundTrip([Run(text: "bonjour")]), [Run(text: "bonjour")])
    }

    func testTheStringIsTheConcatenationOfTheRuns() {
        let attributed = AttributedText.from(runs: [Run(text: "abc"), Run(text: "déf", marks: [Mark(type: "bold")])])
        XCTAssertEqual(attributed.string, "abcdéf")
    }

    func testAMarkWithDataComesBackIntact() {
        let link = Mark(type: "link", attrs: ["href": .string("https://exemple.fr")])
        let runs = [Run(text: "un "), Run(text: "lien", marks: [link])]
        XCTAssertEqual(roundTrip(runs), runs)
    }

    func testAMarkThisLayerHasNoVisualForSurvives() {
        // exactly the case a prettier mapping onto .font and .underlineStyle
        // would lose — and the reason this carries the model's own array
        let comment = Mark(type: "comment", attrs: ["threadId": .string("fil-7")])
        let invented = Mark(type: "surligneur-maison", attrs: ["teinte": .number(0.5)])
        let runs = [Run(text: "commenté", marks: [comment, invented])]
        XCTAssertEqual(roundTrip(runs), runs)
    }

    func testAdjacentRunsSharingMarksAreMerged() {
        // a view splits attribute runs for its own reasons; those are not model
        // boundaries, and without the merge a sentence shatters as it is typed
        let bold = Mark(type: "bold")
        let split = [Run(text: "gr", marks: [bold]), Run(text: "as", marks: [bold])]
        XCTAssertEqual(roundTrip(split), [Run(text: "gras", marks: [bold])])
    }

    func testDifferentMarksAreNotMerged() {
        let runs = [Run(text: "a", marks: [Mark(type: "bold")]), Run(text: "b", marks: [Mark(type: "italic")])]
        XCTAssertEqual(roundTrip(runs), runs)
    }

    func testEmojiKeepTheirLength() {
        let runs = [Run(text: "x👨‍👩‍👧y", marks: [Mark(type: "bold")])]
        let attributed = AttributedText.from(runs: runs)
        // NSAttributedString counts UTF-16, which is the model's unit too
        XCTAssertEqual(attributed.length, Offsets.length(of: runs))
        XCTAssertEqual(roundTrip(runs), runs)
    }

    func testAnEmptyRunIsDropped() {
        XCTAssertEqual(roundTrip([Run(text: ""), Run(text: "réel")]), [Run(text: "réel")])
    }
}
