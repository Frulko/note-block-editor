//! Une rangée par bloc : la gouttière (puce, numéro, case, flèche), le style
//! du conteneur (citation, code, note), et les blocs sans texte (séparateur,
//! image). Le texte lui-même est `block::BlockElement` ; ici on ne décide que
//! l'habillage — miroir de `packages/dom/src/render.ts`.

use gpui::{
    Div, FontWeight, MouseButton, MouseDownEvent, ObjectFit, StyledImage, div, img, prelude::*,
    px, relative, rgb,
};
use loro::LoroValue;

use carnet_model::store::Entry;

use crate::block::BlockElement;
use crate::editor::Editor;
use crate::theme;

/// L'habillage d'une note, par variante — les presets de
/// `packages/blocks-callout/src/index.ts` : l'icône et une teinte de fond.
fn callout_preset(variant: &str) -> (&'static str, u32) {
    match variant {
        "info" => ("ℹ️", 0xe9f3f7),
        "tip" => ("🚀", 0xf6f0fa),
        "success" => ("✅", 0xeaf3eb),
        "warning" => ("⚠️", 0xfbf3db),
        "danger" => ("🛑", 0xfdebec),
        "quote" => ("❝", 0xf4eeee),
        _ => ("💡", 0xf1f1ef), // note
    }
}

pub fn row(editor: &Editor, ix: usize, entry: &Entry, cx: &mut gpui::Context<Editor>) -> Div {
    let indent = px(24. * entry.depth.saturating_sub(1) as f32);

    let mut row = div()
        .flex()
        .flex_row()
        .items_start()
        .ml(indent)
        .mt(theme::block_spacing(entry))
        .mb(px(1.))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |editor, event: &MouseDownEvent, _window, cx| {
                editor.click_block(ix, event, cx);
            }),
        );

    row = match entry.kind.as_str() {
        "divider" => {
            return div()
                .ml(indent)
                .py(px(9.))
                .on_mouse_down(MouseButton::Left, cx.listener(|_, _: &MouseDownEvent, _, _| {}))
                .child(div().h(px(1.)).w_full().bg(rgb(theme::RULE)));
        }
        "image" => return image_row(ix, entry, indent, cx),
        "bulleted_list_item" => row.child(gutter().child("•")),
        "numbered_list_item" => {
            row.child(gutter().child(format!("{}.", list_number(editor, ix))))
        }
        "to_do" => {
            let checked = entry.is_checked();
            row.child(
                gutter().pt(px(4.)).child(
                    // la case du web : 16 px, bord 1.4, coins 2 (blocks.css)
                    div()
                        .size(px(16.))
                        .border_1()
                        .border_color(rgb(if checked { theme::ACCENT } else { theme::TEXT }))
                        .rounded(px(2.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(checked, |checkbox| {
                            checkbox
                                .bg(rgb(theme::ACCENT))
                                .text_color(gpui::white())
                                .text_size(px(11.))
                                .child("✓")
                        })
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |editor, _: &MouseDownEvent, _window, cx| {
                                editor.toggle_todo(ix, cx);
                            }),
                        ),
                ),
            )
        }
        "toggle" => {
            let collapsed = entry.is_collapsed();
            row.child(
                gutter()
                    .text_size(px(12.))
                    .pt(px(4.))
                    .text_color(rgb(theme::MUTED))
                    .child(if collapsed { "▶" } else { "▼" })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |editor, _: &MouseDownEvent, _window, cx| {
                            editor.toggle_fold(ix, cx);
                        }),
                    ),
            )
        }
        "quote" => row.border_l_2().border_color(rgb(theme::TEXT)).pl(px(12.)),
        "code" => row.bg(rgb(theme::CODE_BG)).rounded(px(6.)).p(px(12.)),
        "callout" => {
            let variant = match entry.props.get("variant") {
                Some(LoroValue::String(variant)) => variant.to_string(),
                _ => "note".to_string(),
            };
            let (preset_icon, tint) = callout_preset(&variant);
            let icon = match entry.props.get("icon") {
                Some(LoroValue::String(icon)) if !icon.is_empty() => icon.to_string(),
                _ => preset_icon.to_string(),
            };
            row.bg(rgb(tint))
                .rounded(px(6.))
                .p(px(12.))
                .child(div().w(px(28.)).flex_none().child(icon))
        }
        "paragraph" | "heading" | "page" => row,
        // un type que ce client ne rend pas encore : dire lequel plutôt
        // qu'une ligne vide — §4 promet qu'il survit au aller-retour
        other if entry.text.is_none() => {
            return div().ml(indent).py(px(4.)).text_size(px(13.)).text_color(rgb(theme::MUTED)).child(
                format!("⬚ bloc non pris en charge ici : {other}"),
            );
        }
        _ => row,
    };

    row.child(div().flex_1().child(BlockElement { editor: cx.entity(), ix }))
}

fn gutter() -> Div {
    div().w(px(24.)).flex_none().text_size(px(15.))
}

/// Une image : `src` en data-URL, URL ou chemin ; largeur en % du bloc,
/// légende dessous — les props que `render.ts` écrit.
fn image_row(ix: usize, entry: &Entry, indent: gpui::Pixels, cx: &mut gpui::Context<Editor>) -> Div {
    let src = match entry.props.get("src") {
        Some(LoroValue::String(src)) => src.to_string(),
        _ => String::new(),
    };
    let width = match entry.props.get("width") {
        Some(LoroValue::I64(width)) => (*width).clamp(10, 100) as f32,
        Some(LoroValue::Double(width)) => (*width as f32).clamp(10., 100.),
        _ => 100.,
    };
    let caption = match entry.props.get("caption") {
        Some(LoroValue::String(caption)) => caption.to_string(),
        _ => String::new(),
    };

    let body = match crate::assets::image_source(&src) {
        Some(source) => div().w(relative(width / 100.)).child(
            img(source)
                .w_full()
                .max_h(px(480.))
                .object_fit(ObjectFit::ScaleDown)
                .rounded(px(4.)),
        ),
        // le web montre une zone de dépôt ; ici l'invitation suffit, le
        // dépôt marche sur toute la fenêtre
        None => div()
            .w_full()
            .py(px(24.))
            .border_1()
            .border_color(rgb(theme::RULE))
            .rounded(px(6.))
            .flex()
            .justify_center()
            .text_size(px(13.))
            .text_color(rgb(theme::MUTED))
            .child("Déposez une image sur la fenêtre"),
    };

    let mut root = div()
        .ml(indent)
        .py(px(4.))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |editor, event: &MouseDownEvent, _window, cx| {
                editor.click_block(ix, event, cx);
            }),
        )
        .child(body);
    if !caption.is_empty() {
        root = root.child(
            div().pt(px(4.)).text_size(px(12.)).text_color(rgb(theme::MUTED)).child(caption),
        );
    }
    root
}

/// Le numéro affiché d'un item numéroté : sa place dans la suite contiguë
/// d'items numérotés parmi ses frères — la numérotation repart après un
/// intrus, comme sur le web.
fn list_number(editor: &Editor, ix: usize) -> usize {
    let entry = &editor.entries[ix];
    let mut number = 1;
    let mut looking_for = entry.index;
    while looking_for > 0 {
        let above = editor.entries.iter().find(|sibling| {
            sibling.parent_id == entry.parent_id && sibling.index == looking_for - 1
        });
        match above {
            Some(sibling) if sibling.kind == "numbered_list_item" => {
                number += 1;
                looking_for -= 1;
            }
            _ => break,
        }
    }
    number
}

/// Le titre de page, au-dessus des blocs.
pub fn title(editor: &Editor) -> Div {
    let title: gpui::SharedString = editor
        .entries
        .first()
        .and_then(|entry| match entry.props.get("title") {
            Some(LoroValue::String(title)) => Some(title.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "Sans titre".to_string())
        .into();
    div()
        .text_size(px(34.))
        .font_weight(FontWeight::BOLD)
        .pb(px(24.))
        .child(title)
}
