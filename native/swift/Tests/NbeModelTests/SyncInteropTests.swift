import XCTest
@testable import NbeSync

/// A snapshot written by the TypeScript editor, read by Swift.
///
/// The point is not that Swift can call a Rust library — that is a given. It is
/// that **two independent clients agree on the same bytes**. `document.loro` is
/// exported by `packages/collab/test/fixture.test.ts` using the editor's own
/// store, so this compares the port against the product rather than against one
/// author's idea of the format.
///
/// If the store's layout ever drifts — a renamed key, text stored as a value
/// instead of a container — these fail, which is the whole reason to keep a
/// second implementation.
final class SyncInteropTests: XCTestCase {
    private func snapshot() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "document", withExtension: "loro"))
        return try Data(contentsOf: url)
    }

    func testASnapshotFromTypeScriptOpens() throws {
        let reader = try SnapshotReader(snapshot: try snapshot())
        let blocks = try reader.blocks()
        XCTAssertFalse(blocks.isEmpty, "a document written by the editor should have blocks")
    }

    func testTheBlockTypesSurviveTheCrossing() throws {
        let reader = try SnapshotReader(snapshot: try snapshot())
        let types = Set(try reader.blocks().map(\.type))
        XCTAssertTrue(types.contains("page"), "the page block should be readable, got \(types)")
        XCTAssertTrue(types.contains("paragraph"), "the paragraph block should be readable, got \(types)")
    }

    func testTextIsAContainerAndReadsBackExactly() throws {
        let reader = try SnapshotReader(snapshot: try snapshot())
        // accented, because a byte-level disagreement shows up here first
        XCTAssertEqual(try reader.allText(), ["écrit par TypeScript"])
    }

    func testEveryBlockKeptItsIdentity() throws {
        let reader = try SnapshotReader(snapshot: try snapshot())
        let ids = try reader.blocks().map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "ids must be unique across the crossing")
        XCTAssertTrue(ids.allSatisfy { $0.hasPrefix("01920000-") }, "our UUIDv7s should arrive intact")
    }
}
