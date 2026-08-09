//! Le menu slash — miroir de `packages/dom/src/slash.ts`, réduit au jeu de
//! blocs que ce client embarque (pas de pages, de bases ni de plugins ici).
//! La table décrit *quoi* proposer ; `Editor` décide quand ouvrir, filtrer
//! et appliquer, avec les mêmes règles de fermeture que le web.

use gpui::{CursorStyle, Div, MouseButton, MouseDownEvent, div, prelude::*, px, rgb, rgba};
use loro::LoroValue;

use crate::editor::Editor;
use crate::theme;

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
    pub kind: &'static str,
    pub props: &'static [(&'static str, PropLit)],
}

pub const ITEMS: &[SlashItem] = &[
    SlashItem { label: "Texte", keywords: &["text", "p", "paragraph"], kind: "paragraph", props: &[] },
    SlashItem { label: "Titre 1", keywords: &["h1", "heading", "titre"], kind: "heading", props: &[("level", PropLit::Num(1))] },
    SlashItem { label: "Titre 2", keywords: &["h2", "heading", "titre"], kind: "heading", props: &[("level", PropLit::Num(2))] },
    SlashItem { label: "Titre 3", keywords: &["h3", "heading", "titre"], kind: "heading", props: &[("level", PropLit::Num(3))] },
    SlashItem { label: "Liste à puces", keywords: &["bullet", "ul", "liste"], kind: "bulleted_list_item", props: &[] },
    SlashItem { label: "Liste numérotée", keywords: &["number", "ol", "liste"], kind: "numbered_list_item", props: &[] },
    SlashItem { label: "À faire", keywords: &["todo", "check", "task", "case"], kind: "to_do", props: &[("checked", PropLit::Bool(false))] },
    SlashItem { label: "Dépliant", keywords: &["toggle", "collapse"], kind: "toggle", props: &[] },
    SlashItem { label: "Citation", keywords: &["quote", "citation"], kind: "quote", props: &[] },
    SlashItem { label: "Code", keywords: &["code"], kind: "code", props: &[] },
    SlashItem { label: "Note", keywords: &["callout", "note", "aside"], kind: "callout", props: &[("variant", PropLit::Str("note"))] },
    SlashItem { label: "Image", keywords: &["image", "img", "photo"], kind: "image", props: &[] },
    SlashItem { label: "Séparateur", keywords: &["divider", "hr"], kind: "divider", props: &[] },
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
pub fn menu(editor: &Editor, cx: &mut gpui::Context<Editor>) -> Option<Div> {
    let state = editor.slash.as_ref()?;
    let filtered = editor.slash_filtered();
    if filtered.is_empty() {
        return None;
    }
    let layout = editor.layouts.get(&state.block_id)?;
    let anchor = editor.position_of(&state.block_id, state.trigger)?;
    let top = anchor.y + layout.line_height + px(4.);

    let rows = filtered.into_iter().enumerate().map(|(row, item_ix)| {
        let item = &ITEMS[item_ix];
        let highlighted = row == state.selected;
        div()
            .px(px(10.))
            .py(px(5.))
            .text_size(px(14.))
            .rounded(px(4.))
            .when(highlighted, |entry| entry.bg(rgba(theme::SELECTION)))
            .child(item.label)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |editor, _: &MouseDownEvent, _window, cx| {
                    if let Some(state) = editor.slash.as_mut() {
                        state.selected = row;
                    }
                    editor.select_slash(cx);
                }),
            )
    });

    Some(
        div()
            .absolute()
            .left(anchor.x)
            .top(top)
            .w(px(220.))
            .p(px(4.))
            .bg(gpui::white())
            .border_1()
            .border_color(rgb(theme::RULE))
            .rounded(px(8.))
            .shadow_md()
            .cursor(CursorStyle::Arrow)
            .children(rows),
    )
}
