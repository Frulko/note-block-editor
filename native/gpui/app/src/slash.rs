//! Le menu slash — miroir de `packages/dom/src/slash.ts`, réduit au jeu de
//! blocs que ce client embarque (pas de pages, de bases ni de plugins ici).
//! La table décrit *quoi* proposer ; `Editor` décide quand ouvrir, filtrer
//! et appliquer, avec les mêmes règles de fermeture que le web.

use gpui::{Div, Stateful, px};
use loro::LoroValue;

use crate::editor::Editor;
use crate::icons::Icon;
use crate::ui::{self, MenuItem};

/// Une valeur de prop écrite dans la table — convertible en valeur Loro.
pub enum PropLit {
    Num(i64),
    Bool(bool),
    Str(&'static str),
}

impl PropLit {
    pub fn to_loro(&self) -> LoroValue {
        match self {
            PropLit::Num(number) => LoroValue::I64(*number),
            PropLit::Bool(flag) => LoroValue::Bool(*flag),
            PropLit::Str(text) => LoroValue::from(*text),
        }
    }
}

pub struct SlashItem {
    pub label: &'static str,
    pub keywords: &'static [&'static str],
    pub icon: Icon,
    pub kind: &'static str,
    pub props: &'static [(&'static str, PropLit)],
}

pub const ITEMS: &[SlashItem] = &[
    SlashItem { label: "Texte", keywords: &["text", "p", "paragraph"], icon: Icon::PARAGRAPH, kind: "paragraph", props: &[] },
    SlashItem { label: "Titre 1", keywords: &["h1", "heading", "titre"], icon: Icon::HEADING_1, kind: "heading", props: &[("level", PropLit::Num(1))] },
    SlashItem { label: "Titre 2", keywords: &["h2", "heading", "titre"], icon: Icon::HEADING_2, kind: "heading", props: &[("level", PropLit::Num(2))] },
    SlashItem { label: "Titre 3", keywords: &["h3", "heading", "titre"], icon: Icon::HEADING_3, kind: "heading", props: &[("level", PropLit::Num(3))] },
    SlashItem { label: "Liste à puces", keywords: &["bullet", "ul", "liste"], icon: Icon::BULLETED_LIST, kind: "bulleted_list_item", props: &[] },
    SlashItem { label: "Liste numérotée", keywords: &["number", "ol", "liste"], icon: Icon::NUMBERED_LIST, kind: "numbered_list_item", props: &[] },
    SlashItem { label: "À faire", keywords: &["todo", "check", "task", "case"], icon: Icon::TODO, kind: "to_do", props: &[("checked", PropLit::Bool(false))] },
    SlashItem { label: "Dépliant", keywords: &["toggle", "collapse"], icon: Icon::TOGGLE, kind: "toggle", props: &[] },
    SlashItem { label: "Citation", keywords: &["quote", "citation"], icon: Icon::QUOTE, kind: "quote", props: &[] },
    SlashItem { label: "Code", keywords: &["code"], icon: Icon::CODE, kind: "code", props: &[] },
    SlashItem { label: "Note", keywords: &["callout", "note", "aside"], icon: Icon::CALLOUT, kind: "callout", props: &[("variant", PropLit::Str("note"))] },
    SlashItem { label: "Image", keywords: &["image", "img", "photo"], icon: Icon::IMAGE, kind: "image", props: &[] },
    SlashItem { label: "Séparateur", keywords: &["divider", "hr", "trait"], icon: Icon::DIVIDER, kind: "divider", props: &[] },
];

/// Le menu ouvert : où il a été déclenché, et ce qui est surligné.
pub struct SlashState {
    pub block_id: String,
    /// Offset (octets) du `/` dans le texte du bloc.
    pub trigger: usize,
    pub selected: usize,
}

/// Les indices des entrées qui répondent à la requête.
pub fn filter(query: &str) -> Vec<usize> {
    let query = query.to_lowercase();
    ITEMS
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            query.is_empty()
                || item.label.to_lowercase().contains(&query)
                || item.keywords.iter().any(|keyword| keyword.contains(&query))
        })
        .map(|(ix, _)| ix)
        .collect()
}

/// Le menu rendu, ancré sous le `/` qui l'a ouvert.
pub fn menu(editor: &Editor, cx: &mut gpui::Context<Editor>) -> Option<Stateful<Div>> {
    let state = editor.slash.as_ref()?;
    let filtered = editor.slash_filtered();
    if filtered.is_empty() {
        return None;
    }
    let layout = editor.layouts.get(&state.block_id)?;
    let anchor = editor.position_of(&state.block_id, state.trigger)?;
    let at = gpui::point(anchor.x, anchor.y + layout.line_height + px(4.));

    let items: Vec<MenuItem> = filtered
        .iter()
        .map(|ix| {
            let item = &ITEMS[*ix];
            MenuItem::new(item.label).icon(item.icon)
        })
        .collect();

    Some(ui::menu(
        "slash-menu",
        &items,
        state.selected,
        at,
        |editor: &mut Editor, row, _window, cx| {
            if let Some(state) = editor.slash.as_mut() {
                state.selected = row;
            }
            editor.select_slash(cx);
        },
        cx,
    ))
}
