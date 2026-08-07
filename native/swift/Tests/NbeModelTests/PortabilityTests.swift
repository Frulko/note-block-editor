import XCTest
@testable import NbeModel

/// The document format, read by a second implementation.
///
/// §9 says the store contract "doubles as the spec a Swift port mirrors", and
/// §4 that "unknown types and unknown props round-trip untouched". Both are
/// claims about portability, and neither had ever been checked outside
/// TypeScript.
///
/// The fixture is written by the editor itself, so this is two implementations
/// checked against each other rather than against one author's idea of the
/// format.
final class PortabilityTests: XCTestCase {
    private func fixture() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "document", withExtension: "json"))
        return try Data(contentsOf: url)
    }

    func testDecodesADocumentWrittenByTheEditor() throws {
        let page = try Block.decode(fixture())
        XCTAssertEqual(page.type, "page")
        XCTAssertEqual(page.children?.count, 4)
    }

    func testReadsTextAndItsMarks() throws {
        let page = try Block.decode(fixture())
        let paragraph = try XCTUnwrap(page.flattened.first { $0.id == "p1" })
        XCTAssertTrue(paragraph.plainText.hasPrefix("Du texte en gras et un lien"))

        let bold = try XCTUnwrap(paragraph.text?.first { $0.marks?.contains(Mark(type: "bold")) == true })
        XCTAssertEqual(bold.text, "en gras")

        let link = try XCTUnwrap(paragraph.text?.first { run in
            run.marks?.contains(where: { $0.type == "link" }) == true
        })
        let href = try XCTUnwrap(link.marks?.first(where: { $0.type == "link" })?.attrs?["href"])
        XCTAssertEqual(href, .string("https://example.com"))
    }

    func testKeepsAnEmojiIntact() throws {
        // eight UTF-16 code units joined by zero-width joiners: a format that
        // mangled these would be unusable, and the failure is invisible until
        // someone types a family
        let page = try Block.decode(fixture())
        let paragraph = try XCTUnwrap(page.flattened.first { $0.id == "p1" })
        XCTAssertTrue(paragraph.plainText.contains("👨‍👩‍👧"))
    }

    func testNests() throws {
        let page = try Block.decode(fixture())
        let toggle = try XCTUnwrap(page.flattened.first { $0.id == "toggle1" })
        XCTAssertEqual(toggle.children?.first?.plainText, "Imbriqué.")
    }

    func testAnUnknownBlockTypeSurvives() throws {
        // §4: a block written by a newer version, or by a plugin this build has
        // never heard of, must come back out unchanged — otherwise opening a
        // document in an older client silently deletes parts of it
        let page = try Block.decode(fixture())
        let stranger = try XCTUnwrap(page.flattened.first { $0.type == "un_bloc_du_futur" })
        XCTAssertEqual(stranger.version, 3)

        let unknown = try XCTUnwrap(stranger.props?["inconnu"])
        XCTAssertEqual(unknown, .object(["profond": .array([.number(1), .number(2), .null, .bool(true)])]))
    }

    func testRoundTripsWithoutLosingAnything() throws {
        let original = try fixture()
        let once = try Block.decode(original)
        let written = try once.encoded()
        let twice = try Block.decode(written)
        XCTAssertEqual(once, twice, "un aller-retour a changé le document")

        // and against the bytes: every key of the original is still there
        let before = try JSONSerialization.jsonObject(with: original) as? [String: Any]
        let after = try JSONSerialization.jsonObject(with: written) as? [String: Any]
        XCTAssertEqual(
            Set(try XCTUnwrap(before).keys),
            Set(try XCTUnwrap(after).keys)
        )
    }

    func testAWholeNumberStaysAWholeNumber() throws {
        // `"level": 1` becoming `1.0` is a different document to any reader,
        // and Swift's Double round-trip is where that happens
        let page = try Block.decode(fixture())
        let heading = try XCTUnwrap(page.flattened.first { $0.type == "heading" })
        let written = try heading.encoded()
        XCTAssertTrue(String(decoding: written, as: UTF8.self).contains("\"level\":1"))
    }
}
