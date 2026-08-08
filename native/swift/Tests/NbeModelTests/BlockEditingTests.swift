import Foundation
import Loro
import NbeModel
import XCTest
@testable import NbeSync

/// What a keystroke means, checked against the implementation that defines it.
///
/// Every case here is a mirror of `packages/core/src/commands.ts`, and the ones
/// that look arbitrary are the ones taken most literally: Enter on an empty
/// bullet *stops* being a bullet, Backspace at the start of a heading makes it a
/// paragraph before it merges anything, and Tab under the first sibling refuses
/// rather than erring. A phone where any of those differed would be a different
/// editor wearing the same name.
final class BlockEditingTests: XCTestCase {
    private let page = "01920000-0000-7000-8000-000000000200"

    private func document(_ lines: [String] = []) throws -> DocumentWriter {
        let writer = try DocumentWriter(peerId: 21)
        try writer.createPage(id: page, title: "Édition")
        for (offset, line) in lines.enumerated() {
            try writer.appendParagraph(line, parentId: page, id: "b\(offset)")
        }
        return writer
    }

    private func text(_ writer: DocumentWriter) throws -> [String] {
        try DocumentOrder(doc: writer.doc).entries().compactMap(\.text)
    }

    private func types(_ writer: DocumentWriter) throws -> [String] {
        try DocumentOrder(doc: writer.doc).entries().map(\.type)
    }

    private func entry(_ writer: DocumentWriter, _ id: String) throws -> DocumentOrder.Entry? {
        try DocumentOrder(doc: writer.doc).entries().first { $0.id == id }
    }

    // MARK: - Enter

    func testEnterSplitsAtTheCaret() throws {
        let writer = try document(["une phrase entière"])
        let landing = try writer.splitBlock("b0", at: 4, newId: "b1")

        XCTAssertEqual(try text(writer), ["une ", "phrase entière"])
        XCTAssertEqual(landing.id, "b1")
        XCTAssertEqual(landing.offset, 0)
    }

    func testEnterAtTheEndLeavesAnEmptyBlockToTypeIn() throws {
        let writer = try document(["complet"])
        try writer.splitBlock("b0", at: 7, newId: "b1")
        XCTAssertEqual(try text(writer), ["complet", ""])
    }

    func testEnterContinuesAListAndStartsWithAnUncheckedBox() throws {
        let writer = try document(["acheter du pain"])
        try writer.turnInto("b0", type: "to_do", props: ["checked": .bool(true)])
        try writer.splitBlock("b0", at: 15, newId: "b1")

        XCTAssertEqual(try types(writer), ["page", "to_do", "to_do"])
        // the new item is *not* inherited as checked, which would tick a task
        // nobody has done
        XCTAssertEqual(try entry(writer, "b1")?.isChecked, false)
        XCTAssertEqual(try entry(writer, "b0")?.isChecked, true)
    }

    func testEnterOnAnEmptyBulletStopsBeingABullet() throws {
        let writer = try document([""])
        try writer.turnInto("b0", type: "bulleted_list_item")
        let landing = try writer.splitBlock("b0", at: 0, newId: "unused")

        // nothing was created: the block became a paragraph in place
        XCTAssertEqual(try types(writer), ["page", "paragraph"])
        XCTAssertEqual(landing.id, "b0")
    }

    func testEnterAfterAHeadingGivesAParagraphNotAnotherHeading() throws {
        let writer = try document(["Titre"])
        try writer.turnInto("b0", type: "heading", props: ["level": .number(2)])
        try writer.splitBlock("b0", at: 5, newId: "b1")
        XCTAssertEqual(try types(writer), ["page", "heading", "paragraph"])
    }

    func testASplitKeepsTheMarksOnBothHalves() throws {
        /*
         * The failure this catches is silent and permanent: read the plain
         * string, re-insert it, and every link, comment anchor and bold run in
         * the tail is gone — from every peer's copy, not just this one. §4 calls
         * unknown marks a promise, so the tail is re-applied as pieces.
         */
        let writer = try document(["gras et maigre"])
        guard let target = try writer.node(withId: "b0"),
              let container = try writer.doc.getTree(id: "blocks").getMeta(target: target).get(key: "text")?.asLoroText()
        else { return XCTFail("bloc introuvable") }
        try container.mark(from: 0, to: 4, key: "bold", value: true)
        writer.doc.commit()

        try writer.splitBlock("b0", at: 8, newId: "b1")

        let head = try marks(of: "b0", in: writer)
        let tail = try marks(of: "b1", in: writer)
        XCTAssertEqual(head.first?.0, "gras")
        XCTAssertNotNil(head.first?.1["bold"])
        XCTAssertEqual(tail.map(\.0).joined(), "maigre")
        XCTAssertTrue(tail.allSatisfy { $0.1["bold"] == nil })
    }

    private func marks(of id: String, in writer: DocumentWriter) throws -> [(String, [String: LoroValue])] {
        guard let target = try writer.node(withId: id),
              let container = try writer.doc.getTree(id: "blocks").getMeta(target: target).get(key: "text")?.asLoroText()
        else { return [] }
        return container.toDelta().compactMap { piece in
            guard case let .insert(insert: text, attributes: attributes) = piece else { return nil }
            return (text, attributes ?? [:])
        }
    }

    // MARK: - Backspace

    func testBackspaceAtTheStartOfAHeadingMakesItAParagraphFirst() throws {
        let writer = try document(["Titre"])
        try writer.turnInto("b0", type: "heading", props: ["level": .number(1)])
        let landing = try writer.mergeBackward("b0")

        XCTAssertEqual(try types(writer), ["page", "paragraph"])
        XCTAssertEqual(landing?.id, "b0")
        // the text is untouched: one Backspace changes the block, the next merges
        XCTAssertEqual(try text(writer), ["Titre"])
    }

    func testBackspaceMergesIntoThePreviousBlockAndSaysWhereTheCaretGoes() throws {
        let writer = try document(["premier", "second"])
        let landing = try writer.mergeBackward("b1")

        XCTAssertEqual(try text(writer), ["premiersecond"])
        XCTAssertEqual(landing?.id, "b0")
        XCTAssertEqual(landing?.offset, 7)
    }

    func testBackspaceOnTheFirstBlockDoesNothingRatherThanDeletingIt() throws {
        let writer = try document(["seul"])
        XCTAssertNil(try writer.mergeBackward("b0"))
        XCTAssertEqual(try text(writer), ["seul"])
    }

    func testAMergePromotesChildrenInsteadOfTakingThemAlong() throws {
        let writer = try document(["parent", "enfant"])
        XCTAssertTrue(try writer.indent("b1"))
        try writer.appendParagraph("suivant", parentId: page, id: "b2")

        // merging the parent away must not delete the child with it
        _ = try writer.mergeBackward("b0")
        XCTAssertTrue(try text(writer).contains("enfant"))
    }

    // MARK: - Tab

    func testTabNestsUnderTheSiblingAbove() throws {
        let writer = try document(["parent", "enfant"])
        XCTAssertTrue(try writer.indent("b1"))
        XCTAssertEqual(try entry(writer, "b1")?.depth, 2)
        XCTAssertEqual(try entry(writer, "b1")?.parentId, "b0")
    }

    func testTabRefusesForTheFirstOfItsSiblings() throws {
        let writer = try document(["premier", "second"])
        XCTAssertFalse(try writer.indent("b0"))
        XCTAssertEqual(try entry(writer, "b0")?.depth, 1)
    }

    func testShiftTabComesBackOutAfterItsParent() throws {
        let writer = try document(["parent", "enfant"])
        XCTAssertTrue(try writer.indent("b1"))
        XCTAssertTrue(try writer.outdent("b1"))
        XCTAssertEqual(try entry(writer, "b1")?.depth, 1)
        XCTAssertEqual(try text(writer), ["parent", "enfant"])
    }

    func testShiftTabRefusesAtThePageLevel() throws {
        let writer = try document(["seul"])
        XCTAssertFalse(try writer.outdent("b0"))
    }

    // MARK: - Drag and drop

    func testABlockCanBeDroppedAfterAnother() throws {
        let writer = try document(["un", "deux", "trois"])
        try writer.move("b0", after: "b2")
        XCTAssertEqual(try text(writer), ["deux", "trois", "un"])
    }

    func testABlockCanBeDroppedAtTheTop() throws {
        let writer = try document(["un", "deux", "trois"])
        try writer.move("b2", after: nil)
        XCTAssertEqual(try text(writer), ["trois", "un", "deux"])
    }

    func testABlockCannotBeDroppedInsideItself() throws {
        // it would detach the block from the document, and the symptom is text
        // that vanishes rather than an error anyone sees
        let writer = try document(["parent", "enfant"])
        XCTAssertTrue(try writer.indent("b1"))
        try writer.move("b0", after: "b1")
        XCTAssertEqual(try text(writer), ["parent", "enfant"])
    }

    // MARK: - Props

    func testTheCheckboxIsAProp() throws {
        let writer = try document(["une tâche"])
        try writer.turnInto("b0", type: "to_do")
        XCTAssertEqual(try entry(writer, "b0")?.isChecked, false)
        try writer.setProp("b0", key: "checked", value: .bool(true))
        XCTAssertEqual(try entry(writer, "b0")?.isChecked, true)
    }

    func testAHeadingLevelSurvivesAsAWholeNumber() throws {
        // `3.0` is a different document to any other reader (§4), and a Double
        // is what a careless port would store
        let writer = try document(["Titre"])
        try writer.turnInto("b0", type: "heading", props: ["level": .number(3)])
        XCTAssertEqual(try entry(writer, "b0")?.props["level"], .number(3))
        XCTAssertEqual(try entry(writer, "b0")?.headingLevel, 3)
    }

    func testTurningIntoSomethingElseDropsThePropsThatNoLongerApply() throws {
        let writer = try document(["Titre"])
        try writer.turnInto("b0", type: "heading", props: ["level": .number(3)])
        try writer.turnInto("b0", type: "to_do")
        XCTAssertNil(try entry(writer, "b0")?.props["level"])
    }

    // MARK: - The unit the CRDT counts in

    func testLoroIndexesTextByUnicodeScalars() throws {
        /*
         * Pinned with a document rather than trusted from documentation, because
         * three units are in play — UTF-16 for the model, grapheme clusters for
         * Swift, code points for Loro — and if this ever changes in a minor
         * release the symptom is text torn in half around an emoji, in every
         * peer's copy.
         */
        let doc = LoroDoc()
        let container = doc.getText(id: "t")
        try container.insert(pos: 0, s: "é👍b")
        try container.insert(pos: 2, s: "X")
        XCTAssertEqual(container.toString(), "é👍Xb", "Loro compte en points de code, pas en unités UTF-16")
    }

    func testSplittingAfterAnEmojiCutsInTheRightPlace() throws {
        let writer = try document(["aé👍b"])
        // 4 UTF-16 units in: a(1) é(1) 👍(2) — just after the emoji
        try writer.splitBlock("b0", at: 4, newId: "b1")
        XCTAssertEqual(try text(writer), ["aé👍", "b"])
    }
}

extension BlockEditingTests {
    func testEmptyingABlockActuallyEmptiesIt() throws {
        // `LoroText.update` is a diff, and a diff to the empty string is the one
        // case where "compute the minimal edit" can decide there is nothing to do
        let writer = try DocumentWriter(peerId: 22)
        try writer.createPage(id: "p", title: "x")
        try writer.appendParagraph("/", parentId: "p", id: "b")
        try writer.setText("", forBlock: "b")
        XCTAssertEqual(try DocumentOrder(doc: writer.doc).entries().last?.text, "")
    }
}
