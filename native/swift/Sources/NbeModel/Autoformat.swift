import Foundation

/// Markdown autoformat: what typing `# ` at the start of a block means.
///
/// A mirror of `AUTOFORMAT_RULES` in `packages/core/src/commands.ts`, table for
/// table. It lives in `NbeModel` — the target with no dependencies — because a
/// prefix is *syntax*, not language and not platform: the same three characters
/// mean a bulleted list in a browser, on a desktop and on a phone, and a build
/// where they did not would be a different product wearing the same name.
///
/// `test/swift-parity.test.ts` fails if the two tables drift. That test exists
/// because this is the exact shape of bug a second implementation produces: both
/// sides work, neither is wrong, and the same keystroke does two things.
///
/// The two that surprise people are deliberate and come from Notion: `>` is a
/// **toggle**, and a quote is `"`.
public enum Autoformat {
    public struct Rule: Equatable, Sendable {
        /// The exact text before the caret that triggers the conversion, the
        /// trailing space included when the rule is space-triggered.
        public let prefix: String
        public let type: String
        public let props: [String: JSONValue]

        public init(prefix: String, type: String, props: [String: JSONValue] = [:]) {
            self.prefix = prefix
            self.type = type
            self.props = props
        }
    }

    public static let rules: [Rule] = [
        Rule(prefix: "# ", type: "heading", props: ["level": .number(1)]),
        Rule(prefix: "## ", type: "heading", props: ["level": .number(2)]),
        Rule(prefix: "### ", type: "heading", props: ["level": .number(3)]),
        Rule(prefix: "- ", type: "bulleted_list_item"),
        Rule(prefix: "* ", type: "bulleted_list_item"),
        Rule(prefix: "1. ", type: "numbered_list_item"),
        Rule(prefix: "[] ", type: "to_do"),
        Rule(prefix: "[ ] ", type: "to_do"),
        Rule(prefix: "[x] ", type: "to_do", props: ["checked": .bool(true)]),
        Rule(prefix: "[X] ", type: "to_do", props: ["checked": .bool(true)]),
        Rule(prefix: "> ", type: "toggle"),
        Rule(prefix: "\" ", type: "quote"),
        Rule(prefix: "```", type: "code"),
    ]

    /// The rule for the text before the caret, if there is one.
    ///
    /// An exact match, not a prefix match: `-- ` is not a list, and matching
    /// loosely would convert a block the moment someone typed a dash.
    public static func match(_ textBeforeCaret: String) -> Rule? {
        rules.first { $0.prefix == textBeforeCaret }
    }

    /// The rule a whole block's text *opens with*, if any.
    ///
    /// `match` alone was not enough on a phone and the reason is worth writing
    /// down: keystrokes do not always arrive one at a time. Typing across a block
    /// split delivers a small batch, and a paste delivers a paragraph — in both
    /// cases the text goes from `""` to `"\" un"` without ever *being* `"\" "`,
    /// so an exact match never fires and the prefix stays in the document as
    /// literal text. Found by looking at a screenshot: a quote that was still a
    /// to-do reading `" une citation`.
    ///
    /// Still not a loose match — the prefix must be at the very start, and the
    /// trailing space is part of it, so `--` and `#tag` convert nothing.
    public static func opening(_ text: String) -> Rule? {
        // longest first, so `### ` wins over `## ` and `# `
        rules.sorted { $0.prefix.count > $1.prefix.count }.first { text.hasPrefix($0.prefix) }
    }

    /// `---` becomes a divider, which is the one rule that is not a prefix —
    /// it replaces the whole block rather than stripping something off it.
    public static let dividerText = "---"
}
