//! La scrollbar, dessinée par nous.
//!
//! Le défilement de l'éditeur est manuel (voir `editor.rs` : la scrollbar
//! native de `div` ne voit pas nos blocs, dont la hauteur est mesurée à la
//! main), donc l'ascenseur l'est aussi : un `Element` qui connaît la hauteur
//! du contenu, peint son curseur, et capte la souris pendant le glissé — y
//! compris hors de ses propres bornes, sinon relâcher le bouton à côté
//! laisserait la scrollbar collée au curseur.

use gpui::{
    App, Bounds, CursorStyle, DispatchPhase, Element, ElementId, Entity, GlobalElementId, Hitbox,
    InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Style, Window, fill, point, px, relative, size,
};

use crate::editor::Editor;
use crate::theme::theme;

/// Largeur de la piste, et du curseur au repos.
const TRACK: Pixels = px(12.);
const THUMB: Pixels = px(6.);
const THUMB_HOVER: Pixels = px(9.);
const MIN_THUMB: Pixels = px(36.);

pub struct Scrollbar {
    pub editor: Entity<Editor>,
}

impl IntoElement for Scrollbar {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

/// La géométrie du curseur pour un état de défilement donné.
///
/// Séparée du rendu pour être vérifiable : c'est trois règles de trois, et
/// c'est exactement le genre de calcul qui se trompe d'un facteur au premier
/// essai.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbGeometry {
    pub top: Pixels,
    pub height: Pixels,
}

pub fn thumb_geometry(
    scroll_y: Pixels,
    content: Pixels,
    viewport: Pixels,
) -> Option<ThumbGeometry> {
    if content <= viewport || viewport <= px(0.) {
        return None; // rien à faire défiler : pas de scrollbar
    }
    let ratio = (viewport / content).clamp(0., 1.);
    let height = (viewport * ratio).max(MIN_THUMB).min(viewport);
    let max_scroll = content - viewport;
    let progress = if max_scroll > px(0.) { (scroll_y / max_scroll).clamp(0., 1.) } else { 0. };
    Some(ThumbGeometry { top: (viewport - height) * progress, height })
}

/// Le défilement que représente un curseur posé à `thumb_top`.
pub fn scroll_for_thumb_top(
    thumb_top: Pixels,
    thumb_height: Pixels,
    content: Pixels,
    viewport: Pixels,
) -> Pixels {
    let travel = viewport - thumb_height;
    let max_scroll = (content - viewport).max(px(0.));
    if travel <= px(0.) {
        return px(0.);
    }
    max_scroll * (thumb_top / travel).clamp(0., 1.)
}

impl Element for Scrollbar {
    type RequestLayoutState = ();
    type PrepaintState = (Option<ThumbGeometry>, Hitbox);

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = TRACK.into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let editor = self.editor.read(cx);
        let geometry = thumb_geometry(editor.scroll_y, editor.content_height, bounds.size.height);
        (geometry, window.insert_hitbox(bounds, gpui::HitboxBehavior::Normal))
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut (),
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (geometry, hitbox) = prepaint;
        let Some(geometry) = *geometry else { return };
        let viewport = bounds.size.height;
        let hovered = hitbox.is_hovered(window);
        let dragging = self.editor.read(cx).scroll_drag.is_some();
        let theme = theme(cx);

        let width = if hovered || dragging { THUMB_HOVER } else { THUMB };
        let thumb = Bounds::new(
            point(bounds.right() - width - px(3.), bounds.top() + geometry.top),
            size(width, geometry.height),
        );
        let mut color = theme.muted;
        color.a = if dragging { 0.75 } else if hovered { 0.55 } else { 0.3 };
        window.paint_quad(fill(thumb, color).corner_radii(width / 2.));

        if hovered || dragging {
            window.set_cursor_style(CursorStyle::Arrow, hitbox);
        }

        // saisir le curseur : on retient l'écart entre le clic et le haut du
        // curseur, sinon celui-ci saute sous la souris au premier pixel
        let editor = self.editor.clone();
        let hitbox_bounds = hitbox.bounds;
        window.on_mouse_event({
            let editor = editor.clone();
            move |event: &MouseDownEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                    return;
                }
                if !hitbox_bounds.contains(&event.position) {
                    return;
                }
                let grab = if thumb.contains(&event.position) {
                    event.position.y - thumb.top()
                } else {
                    // clic dans la piste : le curseur vient se centrer là
                    geometry.height / 2.
                };
                editor.update(cx, |editor, cx| {
                    editor.scroll_drag = Some(grab);
                    let top = event.position.y - hitbox_bounds.top() - grab;
                    editor.scroll_y =
                        scroll_for_thumb_top(top, geometry.height, editor.content_height, viewport);
                    cx.notify();
                });
            }
        });

        window.on_mouse_event({
            let editor = editor.clone();
            move |event: &MouseMoveEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let Some(grab) = editor.read(cx).scroll_drag else { return };
                let top = event.position.y - hitbox_bounds.top() - grab;
                editor.update(cx, |editor, cx| {
                    editor.scroll_y =
                        scroll_for_thumb_top(top, geometry.height, editor.content_height, viewport);
                    cx.notify();
                });
            }
        });

        window.on_mouse_event(move |_: &MouseUpEvent, phase, _window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            if editor.read(cx).scroll_drag.is_some() {
                editor.update(cx, |editor, cx| {
                    editor.scroll_drag = None;
                    cx.notify();
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_thumb_when_everything_fits() {
        assert!(thumb_geometry(px(0.), px(400.), px(600.)).is_none());
    }

    #[test]
    fn thumb_spans_the_visible_fraction_and_travels_to_the_end() {
        let (content, viewport) = (px(2000.), px(500.));
        let top = thumb_geometry(px(0.), content, viewport).unwrap();
        assert_eq!(top.top, px(0.));
        assert_eq!(top.height, px(125.)); // 500/2000 de 500
        let bottom = thumb_geometry(content - viewport, content, viewport).unwrap();
        assert_eq!(bottom.top + bottom.height, viewport);
    }

    #[test]
    fn dragging_the_thumb_maps_back_to_the_same_scroll() {
        let (content, viewport) = (px(3000.), px(600.));
        for scroll in [px(0.), px(250.), px(1200.), px(2400.)] {
            let geometry = thumb_geometry(scroll, content, viewport).unwrap();
            let back = scroll_for_thumb_top(geometry.top, geometry.height, content, viewport);
            assert!((back - scroll).abs() < px(0.5), "{scroll:?} -> {back:?}");
        }
    }

    #[test]
    fn a_tiny_thumb_stays_grabbable() {
        let geometry = thumb_geometry(px(0.), px(100_000.), px(500.)).unwrap();
        assert_eq!(geometry.height, MIN_THUMB);
    }
}
