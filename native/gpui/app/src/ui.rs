//! Les primitives d'interface partagées : bouton d'icône, infobulle, menu
//! flottant. Miroir de `packages/dom/src/ui.ts`, qui joue le même rôle côté
//! web — un seul endroit décide à quoi ressemble un menu, pour que le menu
//! slash et le menu d'une poignée de bloc ne divergent pas.

use gpui::{
    AnyView, App, Context, Corner, Div, ElementId, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, ParentElement, Pixels, Point, Render, SharedString, Styled, StatefulInteractiveElement,
    Window, anchored, deferred, div, px,
};

use crate::icons::Icon;
use crate::theme::theme;

/// Une infobulle : le libellé, et le raccourci quand il y en a un.
pub struct Tooltip {
    label: SharedString,
    key: Option<SharedString>,
}

impl Tooltip {
    pub fn build(label: impl Into<SharedString>, key: Option<&str>, cx: &mut App) -> AnyView {
        let label = label.into();
        let key = key.map(SharedString::from);
        cx.new(|_| Tooltip { label, key }).into()
    }

    /// Le cas courant : une infobulle sans raccourci.
    pub fn simple(label: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView {
        let label = label.into();
        move |_window, cx| Tooltip::build(label.clone(), None, cx)
    }

    pub fn with_key(
        label: impl Into<SharedString>,
        key: &'static str,
    ) -> impl Fn(&mut Window, &mut App) -> AnyView {
        let label = label.into();
        move |_window, cx| Tooltip::build(label.clone(), Some(key), cx)
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(if theme.dark { theme.popover } else { gpui::rgb(0x2b2b2b).into() })
            .text_color(if theme.dark { theme.text } else { gpui::white() })
            .text_size(px(12.))
            .shadow_md()
            .child(self.label.clone())
            .children(self.key.clone().map(|key| {
                div().text_color(theme.muted).child(key)
            }))
    }
}

/// Un bouton d'icône : la brique de toute la barre latérale et de la barre
/// d'état. Le `id` est requis par GPUI pour qu'un élément soit survolable.
pub fn icon_button(id: impl Into<ElementId>, icon: Icon, cx: &App) -> Div {
    let theme = theme(cx);
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .size(px(28.))
        .rounded(px(6.))
        .text_color(theme.muted)
        .hover(|style| style.bg(theme.hover).text_color(theme.text))
        .cursor_pointer()
        .child(icon.sized(px(16.)))
}

/// Une entrée de menu — description pure, sans comportement : c'est
/// l'appelant qui branche la sélection, comme `MenuEntry` côté web.
#[derive(Clone)]
pub struct MenuItem {
    pub icon: Option<Icon>,
    pub label: SharedString,
    /// Le raccourci affiché à droite, s'il y en a un.
    pub hint: Option<SharedString>,
    /// Une action destructrice se colore en rouge.
    pub danger: bool,
}

impl MenuItem {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self { icon: None, label: label.into(), hint: None, danger: false }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }
}

/// Un menu flottant ancré à un point de la fenêtre.
///
/// `deferred` le peint après tout le reste (sinon un bloc dessiné plus bas
/// passerait par-dessus), et `anchored` le rabat dans la fenêtre quand il
/// déborderait en bas — ce que le web obtient de son moteur de positionnement.
pub fn menu<T: 'static>(
    id: impl Into<ElementId>,
    items: &[MenuItem],
    selected: usize,
    at: Point<Pixels>,
    on_pick: impl Fn(&mut T, usize, &mut Window, &mut Context<T>) + Clone + 'static,
    cx: &mut Context<T>,
) -> gpui::Stateful<Div> {
    let theme = theme(cx).clone();
    let rows: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(ix, item)| {
            let pick = on_pick.clone();
            div()
                .id(ix)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .py(px(5.))
                .rounded(px(5.))
                .text_size(px(13.5))
                .when(ix == selected, |row| row.bg(theme.hover))
                .when(item.danger, |row| row.text_color(gpui::rgb(0xd23b3b)))
                .hover(|style| style.bg(theme.hover))
                .cursor_pointer()
                .children(item.icon.map(|icon| {
                    div().text_color(theme.muted).child(icon.sized(px(15.)))
                }))
                .child(div().flex_1().child(item.label.clone()))
                .children(item.hint.clone().map(|hint| {
                    div().text_color(theme.muted).text_size(px(11.5)).child(hint)
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |view, _: &MouseDownEvent, window, cx| {
                        pick(view, ix, window, cx);
                    }),
                )
        })
        .collect();

    div()
        .id(id.into())
        .absolute()
        .child(
            deferred(
                anchored().anchor(Corner::TopLeft).position(at).snap_to_window().child(
                    div()
                        .w(px(232.))
                        .p(px(4.))
                        .bg(theme.popover)
                        .text_color(theme.text)
                        .border_1()
                        .border_color(theme.rule)
                        .rounded(px(8.))
                        .shadow_lg()
                        .occlude()
                        .children(rows),
                ),
            )
            .with_priority(1),
        )
}
