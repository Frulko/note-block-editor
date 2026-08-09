//! Le format, pas la plateforme : les tables qui donnent leur *sens* aux
//! frappes, miroir de `packages/core/src/commands.ts` — table pour table,
//! comme `native/swift/Sources/NbeModel/Autoformat.swift`.
//!
//! `test/gpui-parity.test.ts` lit ce fichier comme du texte et échoue au
//! commit qui fait dériver les deux tables. Le format des littéraux ci-dessous
//! fait donc partie du contrat : une `Rule { .. }` par ligne.

/// La valeur d'une prop d'autoformat — le sous-ensemble dont la table a besoin.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Prop {
    Num(i64),
    Bool(bool),
}

/// Ce que taper `# ` en début de bloc veut dire.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rule {
    /// Le texte exact avant le caret qui déclenche la conversion,
    /// espace finale comprise quand la règle se déclenche à l'espace.
    pub prefix: &'static str,
    pub kind: &'static str,
    pub props: &'static [(&'static str, Prop)],
}

/// `AUTOFORMAT_RULES` de core, plus la règle du plugin code — comme le port
/// Swift, ce client n'a pas de système de plugins : il embarque le jeu de
/// blocs que les apps embarquent.
pub const RULES: &[Rule] = &[
    Rule { prefix: "# ", kind: "heading", props: &[("level", Prop::Num(1))] },
    Rule { prefix: "## ", kind: "heading", props: &[("level", Prop::Num(2))] },
    Rule { prefix: "### ", kind: "heading", props: &[("level", Prop::Num(3))] },
    Rule { prefix: "- ", kind: "bulleted_list_item", props: &[] },
    Rule { prefix: "* ", kind: "bulleted_list_item", props: &[] },
    Rule { prefix: "1. ", kind: "numbered_list_item", props: &[] },
    Rule { prefix: "[] ", kind: "to_do", props: &[] },
    Rule { prefix: "[ ] ", kind: "to_do", props: &[] },
    Rule { prefix: "[x] ", kind: "to_do", props: &[("checked", Prop::Bool(true))] },
    Rule { prefix: "[X] ", kind: "to_do", props: &[("checked", Prop::Bool(true))] },
    Rule { prefix: "> ", kind: "toggle", props: &[] },
    Rule { prefix: "\" ", kind: "quote", props: &[] },
    Rule { prefix: "```", kind: "code", props: &[] },
];

/// Types que Entrée *continue* au lieu de terminer — une deuxième puce, pas
/// un paragraphe sous une puce. `CONTINUING_TYPES`, mot pour mot.
pub const CONTINUING_TYPES: [&str; 4] = ["bulleted_list_item", "numbered_list_item", "to_do", "toggle"];

/// Les types qui portent du texte (`spec.inline` du schéma) — ceux qui
/// peuvent recevoir le caret. Le reste est « void » (séparateur, image) ou
/// « layout » (page, colonnes). Sans système de plugins, ce client embarque
/// le jeu que les apps embarquent : `code` et `callout` viennent des plugins.
pub const INLINE_TYPES: [&str; 10] = [
    "paragraph",
    "heading",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "toggle",
    "quote",
    "callout",
    "code",
    "table_cell",
];

/// Les types de disposition : ils portent des blocs, pas du contenu, et la
/// gouttière les traverse au lieu de les saisir.
pub const LAYOUT_TYPES: [&str; 5] = ["page", "column_list", "column", "table", "table_row"];

pub fn is_inline(kind: &str) -> bool {
    INLINE_TYPES.contains(&kind)
}

pub fn is_layout(kind: &str) -> bool {
    LAYOUT_TYPES.contains(&kind)
}

/// « void » : ni texte, ni disposition — un séparateur, une image. Il se
/// glisse au contact et ne reçoit jamais le caret.
pub fn is_void(kind: &str) -> bool {
    !is_inline(kind) && !is_layout(kind)
}

/// `---` devient un séparateur — la seule règle qui n'est pas un préfixe.
pub const DIVIDER_TEXT: &str = "---";

/// La règle pour le texte avant le caret, s'il y en a une.
/// Correspondance exacte, pas par préfixe : `-- ` n'est pas une liste.
pub fn match_autoformat(text_before_caret: &str) -> Option<&'static Rule> {
    RULES.iter().find(|rule| rule.prefix == text_before_caret)
}

pub fn is_continuing(kind: &str) -> bool {
    CONTINUING_TYPES.contains(&kind)
}

// --- offsets ---
//
// Le modèle web compte en UTF-16 (ARCHITECTURE §2.2), Loro en points de code,
// Rust en octets UTF-8. Les conversions vivent ici, une fois, plutôt qu'à
// chaque site d'appel — le rôle que `Offsets.swift` tient côté Swift.

/// Offset en points de code → offset en octets dans `text`.
pub fn byte_of_char(text: &str, char_offset: usize) -> usize {
    text.char_indices().nth(char_offset).map(|(i, _)| i).unwrap_or(text.len())
}

/// Offset en octets → offset en points de code.
pub fn char_of_byte(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset.min(text.len())].chars().count()
}

/// Offset UTF-16 (ce que rapporte l'IME) → points de code.
pub fn char_of_utf16(text: &str, utf16_offset: usize) -> usize {
    let mut units = 0;
    for (chars, c) in text.chars().enumerate() {
        if units >= utf16_offset {
            return chars;
        }
        units += c.len_utf16();
    }
    text.chars().count()
}

/// Points de code → offset UTF-16.
pub fn utf16_of_char(text: &str, char_offset: usize) -> usize {
    text.chars().take(char_offset).map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_only() {
        assert_eq!(match_autoformat("- ").unwrap().kind, "bulleted_list_item");
        assert_eq!(match_autoformat("### ").unwrap().kind, "heading");
        assert!(match_autoformat("-- ").is_none());
        assert!(match_autoformat("-").is_none());
    }

    #[test]
    fn offsets_roundtrip_through_astral_planes() {
        let text = "a👨‍👩‍👧é"; // famille = 3 scalaires + 2 ZWJ, é = 1
        for char_offset in 0..=text.chars().count() {
            let utf16 = utf16_of_char(text, char_offset);
            assert_eq!(char_of_utf16(text, utf16), char_offset);
            let byte = byte_of_char(text, char_offset);
            assert_eq!(char_of_byte(text, byte), char_offset);
        }
    }
}
