import XCTest
@testable import NbeEditorKit
import NbeModel

/// Counting, which Swift and the model do differently.
///
/// The model counts UTF-16 code units — what the web platform gives the
/// TypeScript editor and what §2.2 fixes as the offset unit. Swift counts
/// extended grapheme clusters. Every bug in this layer is one answering the
/// other's question, and the symptom is text that deletes in halves.
final class OffsetTests: XCTestCase {
    /// One Character, eleven UTF-16 units, four scalars joined by ZWJs.
    private let family = "👨‍👩‍👧"
    /// One Character, two UTF-16 units — a surrogate pair.
    private let wave = "🌊"

    func testPlainTextCountsTheSameBothWays() {
        XCTAssertEqual(Offsets.length(of: [Run(text: "bonjour")]), 7)
        XCTAssertEqual(Offsets.offset(in: "bonjour", of: "bonjour".endIndex), 7)
    }

    func testASurrogatePairIsTwoUnitsAndOneCharacter() {
        let text = "a\(wave)b"
        XCTAssertEqual(text.utf16.count, 4)
        XCTAssertEqual(text.count, 3)
        // the offset after the emoji is 3, not 2
        XCTAssertEqual(Offsets.nextGrapheme(in: text, from: 1), 3)
    }

    func testAnOffsetInsideAClusterRoundsTheWayItIsAsked() {
        let text = "a\(wave)b"
        // 2 is inside the surrogate pair; it must resolve to an edge, never into it
        XCTAssertEqual(Offsets.offset(in: text, of: Offsets.index(in: text, at: 2, prefer: .back)), 1)
        XCTAssertEqual(Offsets.offset(in: text, of: Offsets.index(in: text, at: 2, prefer: .forward)), 3)
    }

    func testAZeroWidthJoinerSequenceIsNeverSplit() {
        let text = "x\(family)y"
        XCTAssertEqual(text.count, 3, "the family is one character")
        // every offset strictly inside the family lands on one of its edges
        let end = 1 + family.utf16.count
        for offset in 2..<end {
            XCTAssertEqual(
                Offsets.offset(in: text, of: Offsets.index(in: text, at: offset, prefer: .back)), 1,
                "offset \(offset) split the cluster going back"
            )
            XCTAssertEqual(
                Offsets.offset(in: text, of: Offsets.index(in: text, at: offset, prefer: .forward)), end,
                "offset \(offset) split the cluster going forward"
            )
        }
    }

    func testMovingBackwardsCrossesAWholeCluster() {
        let text = "x\(family)y"
        let end = text.utf16.count
        XCTAssertEqual(Offsets.previousGrapheme(in: text, from: end), end - 1) // past "y"
        XCTAssertEqual(Offsets.previousGrapheme(in: text, from: end - 1), 1) // past the whole family
    }

    func testTheEndsAreClampedRatherThanCrashing() {
        let text = "abc"
        XCTAssertEqual(Offsets.offset(in: text, of: Offsets.index(in: text, at: -5)), 0)
        XCTAssertEqual(Offsets.offset(in: text, of: Offsets.index(in: text, at: 99)), 3)
        XCTAssertEqual(Offsets.previousGrapheme(in: text, from: 0), 0)
        XCTAssertEqual(Offsets.nextGrapheme(in: text, from: 3), 3)
    }

    func testAccentedTextMatchesWhatTheEditorWrote() {
        // the fixture's text, so a normalisation disagreement shows up here
        let text = "écrit par TypeScript"
        XCTAssertEqual(Offsets.length(of: [Run(text: text)]), text.utf16.count)
        XCTAssertEqual(Offsets.nextGrapheme(in: text, from: 0), 1, "é is one cluster")
    }
}
