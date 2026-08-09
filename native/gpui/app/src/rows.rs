//! Une rangée par bloc : la gouttière (le « + » et la poignée ⋮⋮), le
//! surlignage de sélection, l'indicateur de dépôt, et l'habillage propre au
//! type (puce, numéro, case à cocher, note, image…).
//!
//! Le texte lui-même est `block::BlockElement` ; ici on ne décide que ce qui
//! l'entoure — miroir de `packages/dom/src/render.ts` et `controls.ts`.

use gpui::{
    Div, FontWeight, MouseButton, MouseDownEvent, ObjectFit, Render, Stateful, StyledImage, Window,
    canvas, div, img, prelude::*, px, relative,
};
use loro::LoroValue;

use carnet_model::blocks::DropEdge;
use carnet_model::store::Entry;

use crate::block::BlockElement;
use crate::editor::{DraggedBlocks, Editor};
use crate::icons::Icon;
use crate::theme::theme;
use crate::ui::{MenuItem, Tooltip};

/// La largeur réservée à la gouttière de chaque côté de la colonne de
/// texte — `--nbe-gutter-width` côté web.
pub const GUTTER: gpui::Pixels = px(58.);

/// Ce qu'une entrée du menu de bloc déclenche.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockAction {
    Delete,
    Duplicate,
    MoveUp,
    MoveDown,
    TurnInto(&'static str),
}

pub struct BlockMenuEntry {
    pub label: &'static str,
    pub icon: Icon,
    pub hint: Option<&'static str>,
    pub action: BlockAction,
    pub danger: bool,
}

/// Le menu de la poignée — le sous-ensemble de `controls.ts` que ce client
/// sait faire, dans le même ordre : agir, puis transformer.
pub const BLOCK_MENU: &[BlockMenuEntry] = &[
    BlockMenuEntry { label: "Supprimer", icon: Icon::TRASH, hint: Some("⌫"), action: BlockAction::Delete, danger: true },
    BlockMenuEntry { label: "Dupliquer", icon: Icon::DUPLICATE, hint: Some("⌘D"), action: BlockAction::Duplicate, danger: false },
    BlockMenuEntry { label: "Monter", icon: Icon::ARROW_UP, hint: Some("⌘⇧↑"), action: BlockAction::MoveUp, danger: false },
    BlockMenuEntry { label: "Descendre", icon: Icon::ARROW_DOWN, hint: Some("⌘⇧↓"), action: BlockAction::MoveDown, danger: false },
    BlockMenuEntry { label: "Texte", icon: Icon::PARAGRAPH, hint: None, action: BlockAction::TurnInto("paragraph"), danger: false },
    BlockMenuEntry { label: "Titre 1", icon: Icon::HEADING_1, hint: None, action: BlockAction::TurnInto("heading"), danger: false },
    BlockMenuEntry { label: "Liste à puces", icon: Icon::BULLETED_LIST, hint: None, action: BlockAction::TurnInto("bulleted_list_item"), danger: false },
    BlockMenuEntry { label: "À faire", icon: Icon::TODO, hint: None, action: BlockAction::TurnInto("to_do"), danger: false },
    BlockMenuEntry { label: "Citation", icon: Icon::QUOTE, hint: None, action: BlockAction::TurnInto("quote"), danger: false },
    BlockMenuEntry { label: "Code", icon: Icon::CODE, hint: None, action: BlockAction::TurnInto("code"), danger: false },
];

pub fn menu_item(entry: &BlockMenuEntry) -> MenuItem {
    let mut item = MenuItem::new(entry.label).icon(entry.icon);
    if let Some(hint) = entry.hint {
        item = item.hint(hint);
    }
    if entry.danger {
        item = item.danger();
    }
    item
}

/// L'habillage d'une note, par variante — les presets de
/// `packages/blocks-callout` : une icône et une teinte de fond.
fn callout_preset(variant: &str) -> (Icon, u32, u32) {
    match variant {
        "info" => (Icon::CALLOUT_INFO, 0xe9f3f7, 0x1c3d4a),
        "tip" => (Icon::CALLOUT_TIP, 0xf6f0fa, 0x33254a),
        "success" => (Icon::CALLOUT_SUCCESS, 0xeaf3eb, 0x1f3a24),
        "warning" => (Icon::CALLOUT_WARNING, 0xfbf3db, 0x413516),
        "danger" => (Icon::CALLOUT_DANGER, 0xfdebec, 0x45201f),
        "quote" => (Icon::QUOTE, 0xf4eeee, 0x3a2f2f),
        _ => (Icon::CALLOUT, 0xf1f1ef, 0x2b2b28), // note
    }
}

/// L'icône qui représente un type de bloc, pour la poignée et les menus.
pub fn kind_icon(kind: &str) -> Icon {
    match kind {
        "heading" => Icon::HEADING_1,
        "bulleted_list_item" => Icon::BULLETED_LIST,
        "numbered_list_item" => Icon::NUMBERED_LIST,
        "to_do" => Icon::TODO,
        "toggle" => Icon::TOGGLE,
        "quote" => Icon::QUOTE,
        "code" => Icon::CODE,
        "callout" => Icon::CALLOUT,
        "image" => Icon::IMAGE,
        "divider" => Icon::DIVIDER,
        "table" => Icon::TABLE,
        "column_list" | "column" => Icon::COLUMNS,
        "database" => Icon::DATABASE,
        "sub_page" | "link_to_page" => Icon::PAGE,
        _ => Icon::PARAGRAPH,
    }
}

pub fn row(editor: &Editor, ix: usize, entry: &Entry, cx: &mut gpui::Context<Editor>) -> Stateful<Div> {
    let theme = theme(cx).clone();
    let indent = px(24. * entry.depth.saturating_sub(1) as f32);
    let id = entry.id.clone();
    let selected = editor.is_selected(&id);
    let drop_edge = editor
        .drop_target
        .as_ref()
        .filter(|(target, _)| target == &id)
        .map(|(_, edge)| *edge);

    // le conteneur : ce qui porte la sélection, l'indicateur de dépôt et la
    // gouttière révélée au survol
    // La gouttière vit **dans** la rangée, pas à sa gauche : posée dehors,
    // aller la chercher quittait le survol et la faisait disparaître avant
    // qu'on l'atteigne. Le web réserve la même place dans son padding
    // (`--nbe-gutter-width: 58px`).
    let mut root = div()
        .id(("row", ix))
        .group(format!("row-{ix}"))
        .relative()
        .pl(GUTTER + indent)
        .pr(GUTTER)
        .mt(crate::theme::block_spacing(entry))
        .rounded(px(3.))
        .when(selected, |row| row.bg(theme.selection))
        .on_drag_move({
            let editor = cx.entity();
            move |event: &gpui::DragMoveEvent<DraggedBlocks>, _window, cx| {
                // `on_drag_move` se déclenche sur **toutes** les rangées, pas
                // seulement celle sous le curseur : GPUI fournit `bounds`
                // pour qu'on tranche soi-même. Sans ce test, la dernière
                // rangée rendue gagnait et le bloc atterrissait toujours en
                // fin de document.
                if !event.bounds.contains(&event.event.position) {
                    return;
                }
                // au-dessus du milieu on dépose avant, au-dessous après —
                // la règle de `drop.ts`, sans les bandes latérales
                let edge = if event.event.position.y < event.bounds.center().y {
                    DropEdge::Before
                } else {
                    DropEdge::After
                };
                let dragged = event.drag(cx).0.clone();
                editor.update(cx, |editor, cx| {
                    let id = editor.entries.get(ix).map(|entry| entry.id.clone());
                    if let Some(id) = id {
                        editor.set_drop_target(&id, edge, &dragged, cx);
                    }
                });
            }
        })
;

    // l'indicateur de dépôt : une ligne de 2 px sur le bord visé, posée en
    // absolu pour ne pas décaler la mise en page d'un pixel
    if let Some(edge) = drop_edge {
        root = root.child(
            div()
                .absolute()
                .left(GUTTER + indent)
                .right(GUTTER)
                .h(px(2.))
                .rounded(px(2.))
                .bg(theme.accent)
                .map(|line| match edge {
                    DropEdge::Before => line.top(px(-1.)),
                    DropEdge::After => line.bottom(px(-1.)),
                }),
        );
    }

    root.child(gutter(editor, ix, entry, indent, cx)).child(body(editor, ix, entry, cx))
}

/// La gouttière gauche : ajouter un bloc, et la poignée qui glisse ou ouvre
/// le menu. Elle n'apparaît qu'au survol de sa rangée.
fn gutter(editor: &Editor, ix: usize, entry: &Entry, indent: gpui::Pixels, cx: &mut gpui::Context<Editor>) -> Div {
    let theme = theme(cx).clone();
    let id = entry.id.clone();
    let kind = entry.kind.clone();
    let group = format!("row-{ix}");
    // glisser une poignée emporte toute la sélection quand le bloc en fait
    // partie, comme `dragTargets()` côté web
    let targets = editor.drag_targets(&id);

    div()
        .absolute()
        .left(indent + px(4.))
        .top(px(1.))
        .w(px(50.))
        .flex()
        .flex_row()
        .justify_end()
        .gap(px(2.))
        .invisible()
        .group_hover(group, |style| style.visible())
        .child(
            div()
                .id(("add", ix))
                .flex()
                .items_center()
                .justify_center()
                .size(px(24.))
                .rounded(px(5.))
                .text_color(theme.muted)
                .hover(|style| style.bg(theme.hover))
                .cursor_pointer()
                .tooltip(Tooltip::simple("Ajouter un bloc en dessous"))
                .child(Icon::PLUS.sized(px(17.), theme.muted))
                .on_click(cx.listener(move |editor, _: &gpui::ClickEvent, _window, cx| {
                    editor.add_block_below(ix, cx);
                })),
        )
        .child(
            div()
                .id(("handle", ix))
                .flex()
                .items_center()
                .justify_center()
                .size(px(24.))
                .rounded(px(5.))
                .text_color(theme.muted)
                .hover(|style| style.bg(theme.hover))
                .cursor_grab()
                .tooltip(Tooltip::simple("Glisser pour déplacer · cliquer pour le menu"))
                .child(Icon::HANDLE.sized(px(17.), theme.muted))
                .on_drag(DraggedBlocks(targets), {
                    let kind = kind.clone();
                    move |dragged, _position, _window, cx| {
                        let count = dragged.0.len();
                        let kind = kind.clone();
                        cx.new(|_| DragPreview { count, kind })
                    }
                })
                // au *clic* : GPUI annule le clic dès que le glissé démarre
                // (`pending_mouse_down` est vidé au-delà du seuil), donc un tap
                // ouvre le menu et un glissé déplace — sans que le fond du menu
                // ne vienne avaler le geste
                .on_click(cx.listener(move |editor, event: &gpui::ClickEvent, _window, cx| {
                    let id = editor.entries.get(ix).map(|entry| entry.id.clone());
                    if let Some(id) = id {
                        editor.open_block_menu(&id, event.position(), cx);
                    }
                })),
        )
}

/// L'aperçu qui suit le curseur pendant le glissé.
pub struct DragPreview {
    count: usize,
    kind: String,
}

impl Render for DragPreview {
    fn render(&mut self, _window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(theme.popover)
            .border_1()
            .border_color(theme.rule)
            .text_color(theme.text)
            .text_size(px(13.))
            .shadow_lg()
            .child(kind_icon(&self.kind).sized(px(14.), theme.muted))
            .child(if self.count > 1 {
                format!("{} blocs", self.count)
            } else {
                "1 bloc".to_string()
            })
    }
}

/// Le corps d'une rangée : la gouttière propre au type, puis le texte.
fn body(editor: &Editor, ix: usize, entry: &Entry, cx: &mut gpui::Context<Editor>) -> Div {
    let theme = theme(cx).clone();
    let mut row = div().flex().flex_row().items_start().on_mouse_down(
        MouseButton::Left,
        cx.listener(move |editor, event: &MouseDownEvent, _window, cx| {
            editor.click_block(ix, event, cx);
        }),
    );

    row = match entry.kind.as_str() {
        "divider" => {
            return row.py(px(9.)).child(div().h(px(1.)).w_full().bg(theme.rule));
        }
        "image" => return image_row(entry, cx),
        "bulleted_list_item" => row.child(marker().child("•")),
        "numbered_list_item" => {
            row.child(marker().child(format!("{}.", list_number(editor, ix))))
        }
        "to_do" => {
            let checked = entry.is_checked();
            row.child(
                marker().pt(px(3.)).child(
                    div()
                        .id(("check", ix))
                        .size(px(16.))
                        .border_1()
                        .border_color(if checked { theme.accent } else { theme.muted })
                        .rounded(px(3.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .when(checked, |checkbox| {
                            checkbox.bg(theme.accent).child(Icon::CHECK.sized(px(12.), gpui::white()))
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
                marker().pt(px(3.)).child(
                    div()
                        .id(("fold", ix))
                        .size(px(18.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(3.))
                        .text_color(theme.muted)
                        .hover(|style| style.bg(theme.hover))
                        .cursor_pointer()
                        .child(
                            if collapsed { Icon::CHEVRON_RIGHT } else { Icon::CHEVRON_DOWN }
                                .sized(px(14.), theme.muted),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |editor, _: &MouseDownEvent, _window, cx| {
                                editor.toggle_fold(ix, cx);
                            }),
                        ),
                ),
            )
        }
        "quote" => row.border_l_2().border_color(theme.text).pl(px(12.)),
        "code" => row.bg(theme.code_bg).rounded(px(6.)).p(px(12.)),
        "callout" => {
            let variant = match entry.props.get("variant") {
                Some(LoroValue::String(variant)) => variant.to_string(),
                _ => "note".to_string(),
            };
            let (icon, light, dark) = callout_preset(&variant);
            row.bg(gpui::rgb(if theme.dark { dark } else { light }))
                .rounded(px(6.))
                .p(px(12.))
                .child(div().w(px(26.)).flex_none().child(icon.sized(px(16.), theme.muted)))
        }
        "paragraph" | "heading" | "page" => row,
        // un type que ce client ne rend pas encore : le nommer plutôt que de
        // laisser un trou — §4 promet qu'il survit à l'aller-retour
        other if entry.text.is_none() => {
            return row.py(px(4.)).text_size(px(13.)).text_color(theme.muted).gap(px(6.)).child(
                kind_icon(other).sized(px(14.), theme.muted),
            ).child(format!("bloc « {other} » — pas encore rendu ici"));
        }
        _ => row,
    };

    row.child(div().flex_1().child(BlockElement { editor: cx.entity(), ix }))
}

fn marker() -> Div {
    div().w(px(24.)).flex_none().text_size(px(15.))
}

/// Une image : `src` en data-URL, URL ou chemin ; largeur en % du bloc,
/// légende dessous.
fn image_row(entry: &Entry, cx: &mut gpui::Context<Editor>) -> Div {
    let theme = theme(cx).clone();
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
            img(source).w_full().max_h(px(480.)).object_fit(ObjectFit::ScaleDown).rounded(px(4.)),
        ),
        None => div()
            .w_full()
            .py(px(24.))
            .border_1()
            .border_color(theme.rule)
            .rounded(px(6.))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .text_size(px(13.))
            .text_color(theme.muted)
            .child(Icon::IMAGE.sized(px(16.), theme.muted))
            .child("Déposez une image sur la fenêtre"),
    };

    let mut root = div().py(px(4.)).child(body);
    if !caption.is_empty() {
        root = root
            .child(div().pt(px(4.)).text_size(px(12.)).text_color(theme.muted).child(caption));
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
        let above = editor
            .entries
            .iter()
            .find(|sibling| sibling.parent_id == entry.parent_id && sibling.index == looking_for - 1);
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
pub fn title(editor: &Editor, cx: &mut gpui::Context<Editor>) -> Div {
    let theme = theme(cx);
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
        .pl(GUTTER)
        .pr(GUTTER)
        .text_size(px(34.) * theme.font_scale)
        .font_weight(FontWeight::BOLD)
        .pb(px(24.))
        .child(title)
}

/// La mesure du contenu : un élément en position absolue qui couvre la
/// colonne, donc de la hauteur exacte du document. C'est ce que la scrollbar
/// lit — GPUI ne nous le dit pas autrement pour des blocs mesurés à la main.
pub fn content_ruler(cx: &mut gpui::Context<Editor>) -> impl IntoElement {
    let editor = cx.entity();
    // Le style va sur le `canvas` lui-même, pas sur un parent : un canvas sans
    // style est mis en page à **zéro pixel**, et il mesurait donc le vide —
    // la hauteur de contenu restait à 0 et le défilement était mort.
    canvas(
        move |bounds, _window, cx| {
            // du fond, pour que le dernier bloc ne colle pas au bord
            let height = bounds.size.height + px(240.);
            editor.update(cx, |editor: &mut Editor, _| editor.content_height = height);
        },
        |_bounds, _state, _window, _cx| {},
    )
    .absolute()
    .inset_0()
}
