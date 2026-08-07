#if canImport(AppKit)
import XCTest
import AppKit
import Loro
@testable import NbeEditorKit
@testable import NbeSync
import NbeModel

/// Typing in Swift, seen by a peer.
///
/// This is the whole stack in one test: a person types into a per-block editing
/// surface, the keystroke becomes a CRDT operation, and another replica sees
/// it. The fixture it leaves behind is read by
/// `packages/collab/test/swift-interop.test.ts`, so the last link — a
/// TypeScript peer — is checked by TypeScript rather than asserted here.
final class DocumentEditorTests: XCTestCase {
    private var fixture: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("swift-typed.loro")
    }

    private func document(peerId: UInt64 = 21) throws -> (DocumentEditor, String) {
        let writer = try DocumentWriter(peerId: peerId)
        let page = "01920000-0000-7000-8000-000000000200"
        try writer.createPage(id: page, title: "Frappe")
        try writer.appendParagraph("bonjour", parentId: page, id: "01920000-0000-7000-8000-000000000201")
        return (try DocumentEditor(doc: writer.doc), "01920000-0000-7000-8000-000000000201")
    }

    func testTheDocumentBecomesEditingSurfaces() throws {
        let (editor, blockId) = try document()
        XCTAssertEqual(editor.views[blockId]?.string, "bonjour")
        XCTAssertEqual(editor.order.map(\.type), ["page", "paragraph"])
    }

    func testTypingReachesTheCrdt() throws {
        let (editor, blockId) = try document()
        let view = try XCTUnwrap(editor.views[blockId])

        view.setSelectedRange(NSRange(location: 7, length: 0))
        view.insertText(" le monde", replacementRange: NSRange(location: 7, length: 0))

        // read it back out of the document, not out of the view
        let reader = try SnapshotReader(snapshot: try editor.snapshot())
        XCTAssertEqual(try reader.allText(), ["bonjour le monde"])
    }

    func testAnotherReplicaSeesTheKeystroke() throws {
        let (editor, blockId) = try document()
        let peer = LoroDoc()
        try peer.import(bytes: try editor.snapshot())

        let view = try XCTUnwrap(editor.views[blockId])
        view.setSelectedRange(NSRange(location: 7, length: 0))
        view.insertText(" tout le monde", replacementRange: NSRange(location: 7, length: 0))

        try peer.import(bytes: try editor.doc.export(mode: .updates(from: peer.oplogVv())))
        XCTAssertEqual(try DocumentOrder(doc: peer).plainText(), "bonjour tout le monde")
    }

    func testTheEditIsADiffRatherThanAReplacement() throws {
        // if the whole paragraph were replaced per keystroke, two people typing
        // in one sentence would conflict on all of it — the reason text is a
        // container. A concurrent edit elsewhere in the same text must survive.
        let (editor, blockId) = try document(peerId: 31)
        let other = LoroDoc()
        try other.setPeerId(peer: 32)
        try other.import(bytes: try editor.snapshot())

        // they type at opposite ends, neither having seen the other
        let view = try XCTUnwrap(editor.views[blockId])
        view.setSelectedRange(NSRange(location: 7, length: 0))
        view.insertText(" fin", replacementRange: NSRange(location: 7, length: 0))

        let otherTree = other.getTree(id: "blocks")
        for target in otherTree.nodes() {
            let meta = try otherTree.getMeta(target: target)
            if case let .string(value: id)?? = meta.get(key: "id")?.asValue(), id == blockId,
               let text = meta.get(key: "text")?.asLoroText() {
                try text.insert(pos: 0, s: "début ")
            }
        }
        other.commit()

        try other.import(bytes: try editor.doc.export(mode: .snapshot))
        try editor.doc.import(bytes: try other.export(mode: .snapshot))

        let merged = try DocumentOrder(doc: editor.doc).plainText()
        XCTAssertTrue(merged.contains("début"), "the other peer's edit survived, got \(merged)")
        XCTAssertTrue(merged.contains("fin"), "this peer's edit survived, got \(merged)")
    }

    func testLeavesTheFixtureTypeScriptReads() throws {
        let (editor, blockId) = try document(peerId: 41)
        let view = try XCTUnwrap(editor.views[blockId])
        view.setSelectedRange(NSRange(location: 7, length: 0))
        view.insertText(" tapé dans Swift", replacementRange: NSRange(location: 7, length: 0))
        try editor.snapshot().write(to: fixture)

        XCTAssertEqual(try SnapshotReader(snapshot: try editor.snapshot()).allText(), ["bonjour tapé dans Swift"])
    }
}
#endif
