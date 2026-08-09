//! La barre latérale : le dossier ouvert, ses pages, et de quoi en créer.
//!
//! L'arbre vient du vault, qui le dérive des blocs `sub_page` — la barre
//! latérale ne tient donc aucune structure de son côté, elle affiche.

use gpui::{Div, MouseButton, MouseDownEvent, Stateful, div, prelude::*, px};

use crate::icons::Icon;
use crate::theme::theme;
use crate::ui::{Tooltip, icon_button};
use crate::workspace::Workspace;
use crate::{NewPage, OpenVault};

pub fn sidebar(workspace: &Workspace, cx: &mut gpui::Context<Workspace>) -> Div {
    let palette = theme(cx).clone();
    let open = workspace.open_id.clone();

    let rows: Vec<Stateful<Div>> = match workspace.vault.as_ref() {
        Some(vault) => vault
            .flattened()
            .into_iter()
            .enumerate()
            .map(|(ix, (id, depth))| {
                let title = vault.title(&id);
                let active = open.as_deref() == Some(id.as_str());
                let click_id = id.clone();
                div()
                    .id(("page", ix))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .pl(px(8. + 14. * depth as f32))
                    .pr(px(8.))
                    .py(px(4.))
                    .rounded(px(5.))
                    .text_size(px(13.))
                    .when(active, |row| row.bg(palette.hover))
                    .hover(|style| style.bg(palette.hover))
                    .cursor_pointer()
                    .child(Icon::PAGE.sized(px(14.), palette.muted))
                    .group(format!("page-{ix}"))
                    .child(div().flex_1().truncate().child(title))
                    .child(
                        // supprimer la page : révélé au survol de sa ligne,
                        // parce qu'une corbeille toujours visible finit par
                        // être cliquée par accident
                        div()
                            .id(("delete-page", ix))
                            .invisible()
                            .group_hover(format!("page-{ix}"), |style| style.visible())
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(18.))
                            .rounded(px(4.))
                            .text_color(palette.muted)
                            .hover(|style| style.bg(palette.hover))
                            .tooltip(Tooltip::simple("Supprimer la page"))
                            .child(Icon::TRASH.sized(px(13.), palette.muted))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener({
                                    let id = id.clone();
                                    move |workspace, _: &MouseDownEvent, _window, cx| {
                                        workspace.delete_page(&id, cx);
                                    }
                                }),
                            ),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |workspace, _: &MouseDownEvent, _window, cx| {
                            workspace.open_page(&click_id, cx);
                        }),
                    )
            })
            .collect(),
        None => Vec::new(),
    };

    let folder = workspace
        .vault
        .as_ref()
        .and_then(|vault| vault.root.file_name().map(|name| name.to_string_lossy().to_string()))
        .unwrap_or_else(|| "Aucun dossier".to_string());

    div()
        .w(px(232.))
        .flex_none()
        .flex()
        .flex_col()
        .bg(palette.panel)
        .border_r_1()
        .border_color(palette.rule)
        .child(
            div()
                .h(px(44.))
                .flex_none()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.))
                .px(px(8.))
                .child(
                    div()
                        .id("vault")
                        .flex()
                        .flex_1()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .px(px(6.))
                        .py(px(4.))
                        .rounded(px(5.))
                        .text_size(px(13.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .hover(|style| style.bg(palette.hover))
                        .cursor_pointer()
                        .tooltip(Tooltip::simple("Changer de dossier"))
                        .child(Icon::FOLDER.sized(px(14.), palette.muted))
                        .child(div().flex_1().truncate().child(folder))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|workspace, _: &MouseDownEvent, window, cx| {
                                workspace.open_vault_action(&OpenVault, window, cx);
                            }),
                        ),
                )
                .child(
                    icon_button("new-page", Icon::PLUS, cx)
                        .tooltip(Tooltip::with_key("Nouvelle page", "⌘N"))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|workspace, _: &MouseDownEvent, window, cx| {
                                workspace.new_page(&NewPage, window, cx);
                            }),
                        ),
                ),
        )
        .child(
            div()
                .id("pages")
                .flex_1()
                .overflow_y_scroll()
                .px(px(6.))
                .pb(px(8.))
                .children(rows),
        )
}
