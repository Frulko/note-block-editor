import XCTest
@testable import NbeSync

/// Swift as a peer, not a viewer.
///
/// Reading proved the two implementations agree on the format. This writes a
/// document from Swift and leaves it where a TypeScript test picks it up
/// (`packages/collab/test/swift-interop.test.ts`), so the round trip is checked
/// in both directions by the two implementations rather than by one of them
/// twice.
///
/// A fixed peer id keeps the bytes stable across runs; otherwise the fixture
/// would change on every test and its diffs would be unreadable.
final class WriterTests: XCTestCase {
    /// Where the fixture lives in the repository, not in the test bundle —
    /// bundle resources are read-only copies and the point is to hand a file to
    /// another language.
    private var fixture: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("from-swift.loro")
    }

    func testSwiftWritesADocumentTypeScriptCanRead() throws {
        let writer = try DocumentWriter(peerId: 7)
        let pageId = "01920000-0000-7000-8000-00000000000a"
        try writer.createPage(id: pageId, title: "Depuis Swift")
        try writer.appendParagraph("écrit par Swift", parentId: pageId, id: "01920000-0000-7000-8000-00000000000b")
        try writer.appendParagraph("deuxième ligne", parentId: pageId, id: "01920000-0000-7000-8000-00000000000c")

        let bytes = try writer.snapshot()
        XCTAssertFalse(bytes.isEmpty)
        try bytes.write(to: fixture)

        // and it reads back here too, so a failure downstream is TypeScript's.
        // Sorted: `nodes()` walks the tree, and that order is not the
        // document's — asserting on it would test Loro's traversal, not us.
        let reader = try SnapshotReader(snapshot: bytes)
        XCTAssertEqual(try reader.allText().sorted(), ["deuxième ligne", "écrit par Swift"])
        XCTAssertEqual(Set(try reader.blocks().map(\.type)), ["page", "paragraph"])
    }

    func testAnEditFromSwiftMergesIntoAnExistingDocument() throws {
        // open the document TypeScript wrote, add to it, and keep both sides
        let url = try XCTUnwrap(Bundle.module.url(forResource: "document", withExtension: "loro"))
        let writer = try DocumentWriter(snapshot: try Data(contentsOf: url), peerId: 9)
        try writer.appendParagraph(
            "ajouté par Swift",
            parentId: "01920000-0000-7000-8000-000000000001",
            id: "01920000-0000-7000-8000-00000000000d"
        )

        let reader = try SnapshotReader(snapshot: try writer.snapshot())
        let text = try reader.allText()
        XCTAssertTrue(text.contains("écrit par TypeScript"), "the original must survive, got \(text)")
        XCTAssertTrue(text.contains("ajouté par Swift"), "the addition must be there, got \(text)")
    }
}
