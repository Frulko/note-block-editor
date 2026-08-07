import XCTest
import Loro
@testable import NbeSync

/// Reading order, which the tree's own order is not.
///
/// This exists because both implementations made the same mistake within an
/// hour: a test asserted the order the CRDT's node listing happens to return.
/// A renderer needs the order a person reads in, and nothing was providing it.
final class DocumentOrderTests: XCTestCase {
    private func document() throws -> DocumentWriter {
        let writer = try DocumentWriter(peerId: 11)
        let page = "01920000-0000-7000-8000-000000000100"
        try writer.createPage(id: page, title: "Ordre")
        try writer.appendParagraph("premier", parentId: page, id: "01920000-0000-7000-8000-000000000101")
        try writer.appendParagraph("deuxième", parentId: page, id: "01920000-0000-7000-8000-000000000102")
        try writer.appendParagraph("troisième", parentId: page, id: "01920000-0000-7000-8000-000000000103")
        return writer
    }

    func testBlocksComeBackInTheOrderTheyWereWritten() throws {
        let order = DocumentOrder(doc: try document().doc)
        XCTAssertEqual(try order.entries().compactMap(\.text), ["premier", "deuxième", "troisième"])
    }

    func testTheRootIsFirstAndItsChildrenAreDeeper() throws {
        let entries = try DocumentOrder(doc: try document().doc).entries()
        XCTAssertEqual(entries.first?.type, "page")
        XCTAssertEqual(entries.first?.depth, 0)
        XCTAssertTrue(entries.dropFirst().allSatisfy { $0.depth == 1 })
    }

    func testPlainTextReadsLikeTheDocument() throws {
        XCTAssertEqual(
            try DocumentOrder(doc: try document().doc).plainText(),
            "premier\ndeuxième\ntroisième"
        )
    }

    func testADocumentFromTypeScriptReadsInOrderToo() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "document", withExtension: "loro"))
        let doc = LoroDoc()
        try doc.import(bytes: try Data(contentsOf: url))
        // the fixture is one page with one paragraph under it
        let entries = try DocumentOrder(doc: doc).entries()
        XCTAssertEqual(entries.map(\.type), ["page", "paragraph"])
        XCTAssertEqual(entries.compactMap(\.text), ["écrit par TypeScript"])
    }
}
