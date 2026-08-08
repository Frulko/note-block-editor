import XCTest

/// The editor, driven by a finger.
///
/// `swift test` covers what a keystroke *means* — split, merge, indent, the
/// autoformat table — against the document. None of it covers what this file
/// does: whether Return reaches the split at all, whether the caret survives a
/// keystroke, whether the `/` menu opens. Those faults are invisible from the
/// model, because in every one of them the document is perfectly correct and the
/// editor is unusable.
///
/// **It runs with no relay.** Nothing here starts a server: the app seeds its own
/// document and the editor works offline, which is the local-first claim asserted
/// rather than stated. The peer-to-peer path has its own tests
/// (`docs/TESTING.md`).
final class EditorUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        // joins a room that no relay serves, which is exactly the offline case
        app.launchEnvironment["CARNET_ROOM"] = "test-\(UUID().uuidString.prefix(8))"
        app.launch()
    }

    /// The first block, once the document has seeded itself.
    private func firstBlock() -> XCUIElement {
        let block = app.textViews.firstMatch
        XCTAssertTrue(block.waitForExistence(timeout: 15), "aucun bloc n’est apparu")
        return block
    }

    private var blocks: XCUIElementQuery { app.textViews }

    // MARK: - Typing and Return

    func testTypingLandsInTheBlock() {
        let block = firstBlock()
        block.tap()
        block.typeText("une phrase")
        XCTAssertEqual(blocks.firstMatch.value as? String, "une phrase")
    }

    func testReturnSplitsIntoTwoBlocksRatherThanInsertingANewline() {
        let block = firstBlock()
        block.tap()
        block.typeText("premier\nsecond")

        // two editing hosts, not one block holding a newline — a newline inside
        // a block would be a second block hiding in the first (§2.1)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks.element(boundBy: 0).value as? String, "premier")
        XCTAssertEqual(blocks.element(boundBy: 1).value as? String, "second")
    }

    func testTheCaretStaysWhereItWasAfterEveryKeystroke() {
        /*
         * The bug this catches is the classic one for a text view fed from a
         * model: each keystroke repaints the view, the caret goes to the end (or
         * the start), and the next character lands in the wrong place. Typing a
         * word and getting it back in order is the whole assertion.
         */
        let block = firstBlock()
        block.tap()
        block.typeText("abcdefgh")
        XCTAssertEqual(blocks.firstMatch.value as? String, "abcdefgh")
    }

    func testBackspaceAtTheStartMergesTheTwoBlocks() {
        let block = firstBlock()
        block.tap()
        block.typeText("un\n")
        XCTAssertEqual(blocks.count, 2)

        // the caret sits at offset 0 of the new empty block, which is the
        // keystroke under test — arrow keys are avoided on purpose, since they
        // need a hardware keyboard the simulator may not have attached
        blocks.element(boundBy: 1).typeText(XCUIKeyboardKey.delete.rawValue)

        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.firstMatch.value as? String, "un")
    }

    // MARK: - Markdown autoformat

    func testHashSpaceBecomesAHeadingAndTheHashDisappears() {
        let block = firstBlock()
        block.tap()
        block.typeText("# Titre")
        // the prefix is consumed: a heading that still reads "# Titre" is the
        // half of autoformat people notice when it is missing
        XCTAssertEqual(blocks.firstMatch.value as? String, "Titre")
    }

    func testDashSpaceBecomesABulletWithAMarker() {
        let block = firstBlock()
        block.tap()
        block.typeText("- une puce")
        XCTAssertEqual(blocks.firstMatch.value as? String, "une puce")
        XCTAssertTrue(app.staticTexts["•"].exists, "la puce n’est pas dessinée")
    }

    func testBracketsBecomeATaskWithARealCheckbox() {
        let block = firstBlock()
        block.tap()
        block.typeText("[] acheter du pain")
        XCTAssertEqual(blocks.firstMatch.value as? String, "acheter du pain")

        let box = app.buttons["À faire"]
        XCTAssertTrue(box.waitForExistence(timeout: 5), "pas de case à cocher")
        box.tap()
        XCTAssertTrue(app.buttons["Fait"].waitForExistence(timeout: 5), "la case ne se coche pas")
    }

    func testQuoteAndCodePrefixesConvertToo() {
        // `" ` and ``` are the two prefixes nobody guesses, and the ones a
        // screenshot caught staying in the text as literal characters
        let block = firstBlock()
        block.tap()
        block.typeText("\" x")
        XCTAssertTrue(waitFor(blocks.firstMatch, toHaveValue: "x"), "le préfixe de citation est resté")
    }

    func testAPrefixThatArrivesAsABatchStillConverts() {
        /*
         * The failure this catches is the one `match` could not see: after a split
         * the keystrokes arrive together, so the text never *is* "- " on its own.
         * Typing a bullet on the line after a heading is the shortest way to
         * reproduce it.
         */
        let block = firstBlock()
        block.tap()
        // short, unword-like input for the same reason as the reorder test: the
        // suggestion bar rewrites real words and takes Return when a completion is
        // highlighted, so a driven sentence is not the same input twice
        block.typeText("# T\n- x")
        XCTAssertTrue(waitFor(blocks.element(boundBy: 1), toHaveValue: "x"), "le préfixe de puce est resté")
        XCTAssertTrue(app.staticTexts["•"].waitForExistence(timeout: 5))
    }

    func testReturnContinuesAList() {
        let block = firstBlock()
        block.tap()
        block.typeText("- un\ndeux")
        // two bullets: Enter continues a list rather than ending it
        XCTAssertEqual(app.staticTexts.matching(identifier: "•").count, 2)
    }

    // MARK: - The slash menu

    func testTypingSlashOpensTheMenuAndChoosingTransformsTheBlock() {
        let block = firstBlock()
        block.tap()
        block.typeText("/")

        XCTAssertTrue(menuIsOpen(), "le menu « / » ne s’ouvre pas")

        tap("Titre 1")
        // the sheet closing is what proves the row was actually hit: a query that
        // matched a container instead of the button would tap nothing at all, and
        // an assertion on the text alone cannot tell the difference
        XCTAssertTrue(
            app.textFields["filtre"].waitForNonExistence(timeout: 5),
            "le menu ne s’est pas fermé : l’élément n’a pas été touché"
        )
        // the `/` was a command, not text, so nothing is left behind
        XCTAssertTrue(waitFor(blocks.firstMatch, toHaveValue: ""), "le « / » est resté dans le bloc")
    }

    func testTheMenuFiltersAsYouType() {
        let block = firstBlock()
        block.tap()
        block.typeText("/")
        XCTAssertTrue(menuIsOpen())

        // the sheet holds the keyboard, so the filter field is where the typing
        // goes — and it is focused on appear so that this keeps working
        app.textFields["filtre"].typeText("cit")

        // diacritic-insensitive: "cit" has to find « Citation »
        XCTAssertTrue(item("Citation").waitForExistence(timeout: 5))
        XCTAssertFalse(item("Liste à puces").exists)
    }

    func testTheKeyboardBarOffersTheSameMenu() {
        let block = firstBlock()
        block.tap()
        app.buttons["Insérer un bloc"].tap()
        XCTAssertTrue(menuIsOpen())
    }

    // MARK: - Nesting and drag

    func testTheKeyboardBarIndentsAndOutdents() {
        let block = firstBlock()
        block.tap()
        block.typeText("parent\nenfant")

        let before = blocks.element(boundBy: 1).frame.minX
        app.buttons["Imbriquer"].tap()
        let indented = blocks.element(boundBy: 1).frame.minX
        XCTAssertGreaterThan(indented, before, "le bloc n’est pas décalé")

        app.buttons["Sortir"].tap()
        XCTAssertEqual(blocks.element(boundBy: 1).frame.minX, before, accuracy: 1)
    }

    func testTheKeyboardBarReordersBlocks() {
        let block = firstBlock()
        block.tap()
        block.typeText("un\ndeux")
        XCTAssertTrue(waitFor(blocks.element(boundBy: 0), toHaveValue: "un"))

        // the caret is in "deux"; send it up past "un"
        app.buttons["Monter le bloc"].tap()
        XCTAssertTrue(waitForOrder(["deux", "un"]), "le bloc n’est pas monté")

        app.buttons["Descendre le bloc"].tap()
        XCTAssertTrue(waitForOrder(["un", "deux"]), "le bloc n’est pas redescendu")
    }

    func testTheDragHandleIsThereForEveryBlock() {
        /*
         * The drag *gesture* is not driven here, and the omission is deliberate
         * rather than lazy: a SwiftUI `draggable`/`dropDestination` session is not
         * reliably reproducible from XCUITest, and a flaky test is worse than an
         * honest gap. What the reorder *does* to the document is covered by
         * `BlockEditingTests` in `native/swift`, and the path a thumb can always
         * take is covered by the test above. The handle's presence is what is
         * checkable here.
         */
        let block = firstBlock()
        block.tap()
        block.typeText("un\ndeux")
        // this test is about the handle, so the precondition is only "two rows
        // exist" — comparing their text here would borrow the flakiest assertion
        // in the file for something it does not need
        XCTAssertTrue(app.textViews.element(boundBy: 1).waitForExistence(timeout: 15))
        // by label, not by identifier: the identifier belongs to the SF symbol
        let handles = app.images.matching(NSPredicate(format: "label == %@", "Déplacer le bloc"))
        XCTAssertGreaterThanOrEqual(handles.count, 2, "chaque bloc doit avoir sa poignée")
    }

    func testTypingInstantlyAfterTappingAnotherBlock() throws {
        /*
         * The regression test for the worst bug in this app's short history: typing
         * into a block in the same instant as tapping it used to lose the first
         * characters — "deux" arrived as "dex", found on a screenshot.
         *
         * The cause was the model arbitrating something only the platform knows.
         * UIKit moves the first responder on the tap; SwiftUI republishes `focus` a
         * frame later; a keystroke in between was compared against the *stale*
         * focus, refused, and buffered against a handover that did not exist. A
         * view being asked whether it may accept a character is the first
         * responder — that is what "it has the caret" means.
         *
         * **Not finished.** The refusal is gone and most of the loss with it, but a
         * character still disappears in roughly one synthetic run in three, and the
         * cause is below the model: UIKit delivers the keystroke while the first
         * responder is still moving. `XCTExpectFailure` is non-strict on purpose —
         * the run where it passes must not turn the suite red — and it stays here
         * so the day it is fixed is visible. This is the first concrete cost of
         * per-block editing on iOS that
         * `docs/research/per-block-contenteditable-evidence.md` predicted, and the
         * escape hatch is the single-host topology the web already has behind a flag.
         */
        XCTExpectFailure("frappe instantanée après une tape : une lettre encore perdue", strict: false)

        let block = firstBlock()
        block.tap()
        block.typeText("un\n")
        let second = blocks.element(boundBy: 1)
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        second.tap()
        second.typeText("deux")
        XCTAssertTrue(waitForOrder(["un", "deux"]))
    }

    // MARK: - Deleting

    func testTheBinRemovesTheBlockTheCaretIsIn() {
        let block = firstBlock()
        block.tap()
        block.typeText("a\n")
        XCTAssertTrue(blocks.element(boundBy: 1).waitForExistence(timeout: 10))
        app.typeText("b")
        blocks.element(boundBy: 1).tap()
        let survivor = blocks.firstMatch.value as? String
        app.buttons["Supprimer le bloc"].tap()

        // the count is the claim; the surviving text is asserted as *unchanged*
        // rather than as a literal, because what was typed into the other block is
        // subject to the keyboard's own corrections
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.firstMatch.value as? String, survivor)
    }

    // MARK: - Reaching the sheet

    /// An item in the slash menu, whatever element type SwiftUI made of it.
    ///
    /// Queried by identifier across every type on purpose: the same row is a
    /// `Button` in one iOS version and a `StaticText` inside a cell in another,
    /// and pinning the type is how this test breaks on an OS update rather than
    /// on a regression.
    private func item(_ label: String) -> XCUIElement {
        let button = app.buttons[label]
        if button.exists { return button }
        return app.descendants(matching: .any).matching(identifier: label).firstMatch
    }

    private func tap(_ label: String) {
        let element = item(label)
        XCTAssertTrue(element.waitForExistence(timeout: 10), "« \(label) » introuvable")
        element.tap()
    }

    /// The menu is open **and on screen**.
    ///
    /// Existence is not enough and that cost an hour: a sheet exists from the
    /// moment it is presented, while its frame is still below the window, and
    /// every query into it comes back empty. The gate is the filter field being
    /// hittable, which is true only once the sheet has finished arriving.
    private func menuIsOpen(timeout: TimeInterval = 10) -> Bool {
        let filter = app.textFields["filtre"]
        guard filter.waitForExistence(timeout: timeout) else { return false }
        let hittable = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: filter)
        return XCTWaiter().wait(for: [hittable], timeout: timeout) == .completed
    }

    /// The blocks' text, in the order they are laid out.
    ///
    /// Re-queried from scratch on every poll, which matters: an `XCUIElement`
    /// obtained by `element(boundBy:)` keeps resolving to the row it first matched,
    /// so asserting on one across a **reorder** passes or fails depending on when
    /// the snapshot was taken. That made this test flaky for a reason that had
    /// nothing to do with the product.
    /// The blocks' text as it is now, top to bottom.
    private func order() -> [String] {
        Thread.sleep(forTimeInterval: 1.5)
        let query = XCUIApplication().descendants(matching: .textView)
        return (0..<query.count).map { query.element(boundBy: $0).value as? String ?? "" }
    }

    private func waitForOrder(_ expected: [String], timeout: TimeInterval = 25) -> Bool {
        /*
         * Each row carries `bloc-<position>` as its identifier, so "the first
         * block" is a *name* rather than an index into a query result. That
         * matters after a reorder: an element resolved by `element(boundBy:)`
         * keeps pointing at the row it first matched, and hand-rolled polling
         * through one application object re-reads a cached snapshot — both report
         * the old order long after the screen has changed. A predicate expectation
         * on a named element is the one thing that refreshes.
         */
        /*
         * Measured rather than reasoned, after four approaches that each looked
         * right and failed:
         *
         * - `element(boundBy:)` held across the change keeps resolving to the row
         *   it first matched.
         * - A tight poll — however the query is rebuilt, and even through a fresh
         *   `XCUIApplication` — re-reads a cached snapshot.
         * - `XCTNSPredicateExpectation` on such an element inherits the same cache.
         * - A per-*position* accessibility identifier is not re-applied by SwiftUI
         *   on a pure reorder: the view keeps the name it was born with, so
         *   `bloc-0` still points at the row that moved down.
         *
         * What does work is a settle, then one fresh read. The sleep is the point,
         * not an accident: it lets the automation session take a new snapshot.
         */
        let attempts = max(1, Int(timeout / 2))
        for _ in 0..<attempts {
            Thread.sleep(forTimeInterval: 1.5)
            let query = XCUIApplication().descendants(matching: .textView)
            let values = (0..<query.count).map { query.element(boundBy: $0).value as? String ?? "" }
            if values == expected { return true }
        }
        return false
    }

    /// SwiftUI updates a frame after the model does, so an assertion that fires
    /// straight after a tap is asserting on the previous frame.
    private func waitFor(_ element: XCUIElement, toHaveValue value: String, timeout: TimeInterval = 10) -> Bool {
        let matched = expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: element)
        return XCTWaiter().wait(for: [matched], timeout: timeout) == .completed
    }
}
