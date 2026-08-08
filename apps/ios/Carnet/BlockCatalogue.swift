import NbeModel
import NbeSync
import SwiftUI

/// The block types this app offers, and how each one looks.
///
/// A mirror of `builtinItems` in `packages/dom/src/slash.ts`, minus the ones
/// that need a host this app does not have — no table, no database, no sub-page,
/// no image picker. Those are absences, not disagreements: a slash menu that
/// offered a database and then did nothing would be worse than one that is
/// honest about its size.
///
/// The labels are French because this app is; the *prefixes* that trigger these
/// same types live in `NbeModel.Autoformat`, which is language-free on purpose
/// and checked against the TypeScript table by `test/swift-parity.test.ts`.
enum BlockCatalogue {
    struct Item: Identifiable {
        let label: String
        let hint: String
        let symbol: String
        let type: String
        let props: [String: JSONValue]
        /// What the autoformat prefix would be, shown as a hint. `nil` when
        /// there is none.
        let shortcut: String?

        var id: String { label }

        init(
            _ label: String,
            hint: String,
            symbol: String,
            type: String,
            props: [String: JSONValue] = [:],
            shortcut: String? = nil
        ) {
            self.label = label
            self.hint = hint
            self.symbol = symbol
            self.type = type
            self.props = props
            self.shortcut = shortcut
        }
    }

    static let items: [Item] = [
        Item("Texte", hint: "paragraphe", symbol: "text.alignleft", type: "paragraph"),
        Item("Titre 1", hint: "grand titre", symbol: "textformat.size.larger", type: "heading", props: ["level": .number(1)], shortcut: "# "),
        Item("Titre 2", hint: "titre de section", symbol: "textformat.size", type: "heading", props: ["level": .number(2)], shortcut: "## "),
        Item("Titre 3", hint: "sous-titre", symbol: "textformat.size.smaller", type: "heading", props: ["level": .number(3)], shortcut: "### "),
        Item("Liste à puces", hint: "une puce par ligne", symbol: "list.bullet", type: "bulleted_list_item", shortcut: "- "),
        Item("Liste numérotée", hint: "numérotée toute seule", symbol: "list.number", type: "numbered_list_item", shortcut: "1. "),
        Item("Case à cocher", hint: "une tâche", symbol: "checklist", type: "to_do", props: ["checked": .bool(false)], shortcut: "[] "),
        Item("Bascule", hint: "replie ses enfants", symbol: "chevron.right", type: "toggle", shortcut: "> "),
        Item("Citation", hint: "mise en retrait", symbol: "quote.opening", type: "quote", shortcut: "\" "),
        Item("Code", hint: "à chasse fixe", symbol: "curlybraces", type: "code", shortcut: "```"),
        Item("Séparateur", hint: "un trait", symbol: "minus", type: "divider", shortcut: "---"),
    ]

    /// Filter as someone types after the `/`.
    ///
    /// Diacritic- and case-insensitive, because typing `/cite` on a French
    /// keyboard must find « Citation » — a menu that demanded the accent would
    /// be a menu nobody finds.
    static func matching(_ query: String) -> [Item] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return items }
        return items.filter {
            $0.label.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                || $0.hint.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                || $0.type.contains(trimmed.lowercased())
        }
    }

    // MARK: - How a block reads

    /// Text that is not editable — a divider has no text to put a caret in.
    static func isVoid(_ type: String) -> Bool { type == "divider" }

    static func font(for entry: DocumentOrder.Entry) -> Font {
        switch entry.type {
        case "heading":
            switch entry.headingLevel {
            case 1: return .system(.title, design: .default, weight: .bold)
            case 2: return .system(.title2, design: .default, weight: .bold)
            default: return .system(.title3, design: .default, weight: .semibold)
            }
        case "code": return .system(.callout, design: .monospaced)
        case "quote": return .system(.body, design: .serif)
        default: return .body
        }
    }

    /// The same font as a `UIFont`, for the text view.
    static func uiFont(for entry: DocumentOrder.Entry) -> UIFont {
        switch entry.type {
        case "heading":
            let style: UIFont.TextStyle = entry.headingLevel == 1 ? .title1 : entry.headingLevel == 2 ? .title2 : .title3
            let base = UIFont.preferredFont(forTextStyle: style)
            let weight: UIFont.Weight = entry.headingLevel == 3 ? .semibold : .bold
            return UIFont.systemFont(ofSize: base.pointSize, weight: weight)
        case "code":
            return UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .callout).pointSize, weight: .regular)
        default:
            return UIFont.preferredFont(forTextStyle: .body)
        }
    }

    /// What appears in the gutter to the left of the text.
    ///
    /// `numbered_list_item` is the interesting one: the number is **not** stored.
    /// It is a function of how many numbered siblings precede this block, which
    /// is why `DocumentOrder.Entry` carries `parentId` and `index` — a stored
    /// number is a number that goes stale the moment anything moves.
    static func marker(for entry: DocumentOrder.Entry, in entries: [DocumentOrder.Entry]) -> String? {
        switch entry.type {
        case "bulleted_list_item": return "•"
        case "numbered_list_item": return "\(ordinal(of: entry, in: entries))."
        default: return nil
        }
    }

    static func ordinal(of entry: DocumentOrder.Entry, in entries: [DocumentOrder.Entry]) -> Int {
        let siblings = entries.filter { $0.parentId == entry.parentId }.sorted { $0.index < $1.index }
        var count = 0
        for sibling in siblings {
            if sibling.type == "numbered_list_item" { count += 1 } else if sibling.index < entry.index { count = 0 }
            if sibling.id == entry.id { break }
        }
        return max(1, count)
    }

    /// The placeholder shown in an empty block — the only place this app tells
    /// anyone the slash menu exists.
    static func placeholder(for entry: DocumentOrder.Entry, isFirst: Bool) -> String {
        switch entry.type {
        case "heading": return "Titre"
        case "code": return "Code"
        case "quote": return "Citation"
        case "to_do": return "À faire"
        case "bulleted_list_item", "numbered_list_item": return "Élément"
        default: return isFirst ? "Écrivez, ou tapez « / » pour les commandes" : "Tapez « / » pour les commandes"
        }
    }
}
