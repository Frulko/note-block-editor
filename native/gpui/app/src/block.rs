//! Le texte d'un bloc, en tant qu'`Element` GPUI.
//!
//! GPUI ne fournit pas de champ texte — Zed construit le sien, et c'est le
//! contrat qu'on est venu tester. Cet élément façonne son texte
//! (`shape_text`, retour à la ligne compris), peint runs marqués, caret et
//! sélection, branche l'IME du système sur le bloc actif, et fait suivre le
//! scroll au caret.

use gpui::{
    App, Bounds, Element, ElementId, ElementInputHandler, Entity, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels, Point, SharedString, Style,
    TextAlign, TextRun, Window, WrappedLine, fill, point, px, relative, size,
    AvailableSpace,
};

use crate::editor::Editor;
use crate::theme;

/// Ce que le dernier `paint` d'un bloc a mesuré — ce que la souris interroge.
pub struct BlockLayout {
    pub lines: Vec<WrappedLine>,
    pub bounds: Bounds<Pixels>,
    pub line_height: Pixels,
}

pub struct BlockElement {
    pub editor: Entity<Editor>,
    pub ix: usize,
}

pub struct BlockPrepaint {
    lines: Vec<WrappedLine>,
    line_height: Pixels,
    selections: Vec<PaintQuad>,
    cursor: Option<PaintQuad>,
}

impl IntoElement for BlockElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl BlockElement {
    /// Ce que ce bloc affiche, cloné hors de l'entité pour les fermetures.
    fn snapshot(&self, window: &Window, cx: &App) -> (SharedString, Vec<TextRun>, Pixels, Pixels, bool) {
        let editor = self.editor.read(cx);
        let entry = &editor.entries[self.ix];
        let active = entry.id == editor.active_id;
        let base = window.text_style().font();
        let palette = theme::theme(cx);
        let (font, font_size, line_height, color) = theme::block_style(entry, &base, palette);
        let text: SharedString = entry.text.clone().unwrap_or_default().into();
        let mut runs = theme::text_runs(
            &entry.runs,
            &font,
            palette,
            if active { editor.marked_range.as_ref() } else { None },
        );
        if runs.is_empty() {
            runs.push(TextRun {
                len: text.len(),
                font,
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            });
        }
        (text, runs, font_size, line_height, active)
    }
}

impl Element for BlockElement {
    type RequestLayoutState = ();
    type PrepaintState = BlockPrepaint;

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
        let (text, runs, font_size, line_height, _) = self.snapshot(window, cx);
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let layout_id = window.request_measured_layout(style, move |known, available, window, _cx| {
            let width = known.width.or(match available.width {
                AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            let height = window
                .text_system()
                .shape_text(text.clone(), font_size, &runs, width, None)
                .map(|lines| {
                    lines
                        .iter()
                        .fold(px(0.), |total, line| total + line.size(line_height).height)
                })
                .unwrap_or(line_height)
                .max(line_height);
            size(width.unwrap_or(px(0.)), height)
        });
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> BlockPrepaint {
        let (text, runs, font_size, line_height, active) = self.snapshot(window, cx);
        let palette = theme::theme(cx).clone();
        let lines: Vec<WrappedLine> = window
            .text_system()
            .shape_text(text, font_size, &runs, Some(bounds.size.width), None)
            .map(|lines| lines.into_iter().collect())
            .unwrap_or_default();

        let mut selections = Vec::new();
        let mut cursor = None;
        if active {
            let editor = self.editor.read(cx);
            let in_block_mode = editor.block_selection.is_some();
            let range = editor.selected_range.clone();
            if in_block_mode {
                // en mode bloc, le surlignage est celui de la rangée : pas de
                // caret, pas de sélection de texte
            } else if range.is_empty() {
                if let Some(origin) = position_in_lines(&lines, range.start, line_height) {
                    cursor = Some(fill(
                        Bounds::new(bounds.origin + origin, size(px(2.), line_height)),
                        palette.accent,
                    ));
                }
            } else {
                let start = position_in_lines(&lines, range.start, line_height);
                let end = position_in_lines(&lines, range.end, line_height);
                if let (Some(start), Some(end)) = (start, end) {
                    if start.y == end.y {
                        selections.push(fill(
                            Bounds::from_corners(
                                bounds.origin + start,
                                bounds.origin + point(end.x, end.y + line_height),
                            ),
                            palette.selection,
                        ));
                    } else {
                        // ponytail: la rangée de départ court jusqu'au bord ; assez
                        // vrai visuellement, exact quand quelqu'un le remarquera
                        selections.push(fill(
                            Bounds::from_corners(
                                bounds.origin + start,
                                point(bounds.right(), bounds.top() + start.y + line_height),
                            ),
                            palette.selection,
                        ));
                        if end.y > start.y + line_height {
                            selections.push(fill(
                                Bounds::from_corners(
                                    point(bounds.left(), bounds.top() + start.y + line_height),
                                    point(bounds.right(), bounds.top() + end.y),
                                ),
                                palette.selection,
                            ));
                        }
                        selections.push(fill(
                            Bounds::from_corners(
                                point(bounds.left(), bounds.top() + end.y),
                                bounds.origin + point(end.x, end.y + line_height),
                            ),
                            palette.selection,
                        ));
                    }
                }
            }
        }

        BlockPrepaint { lines, line_height, selections, cursor }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut (),
        prepaint: &mut BlockPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (entry_id, active, focus_handle) = {
            let editor = self.editor.read(cx);
            let entry = &editor.entries[self.ix];
            (entry.id.clone(), entry.id == editor.active_id, editor.focus_handle.clone())
        };

        // l'IME du système parle au bloc actif, par ces bounds
        if active {
            window.handle_input(
                &focus_handle,
                ElementInputHandler::new(bounds, self.editor.clone()),
                cx,
            );
        }

        for quad in prepaint.selections.drain(..) {
            window.paint_quad(quad);
        }

        let mut y = px(0.);
        for line in &prepaint.lines {
            let _ = line.paint(
                bounds.origin + point(px(0.), y),
                prepaint.line_height,
                TextAlign::Left,
                None,
                window,
                cx,
            );
            y += line.size(prepaint.line_height).height;
        }

        let caret = prepaint.cursor.take();
        let lit = self.editor.read(cx).blink_on;
        if active && lit && focus_handle.is_focused(window) {
            if let Some(caret) = caret.clone() {
                window.paint_quad(caret);
            }
        }

        // le scroll suit le caret : si la frappe l'a poussé hors de la
        // fenêtre, on ramène `scroll_y` dessus au prochain rendu
        if active && self.editor.read(cx).follow_caret {
            let caret_bounds = caret
                .map(|quad| quad.bounds)
                .unwrap_or(Bounds::new(bounds.origin, size(px(2.), prepaint.line_height)));
            let viewport = window.viewport_size().height;
            let margin = px(48.);
            let mut delta = px(0.);
            if caret_bounds.bottom() > viewport - margin {
                delta = caret_bounds.bottom() - (viewport - margin);
            }
            if caret_bounds.top() < margin {
                delta = caret_bounds.top() - margin;
            }
            self.editor.update(cx, |editor, cx| {
                editor.follow_caret = false;
                if delta != px(0.) {
                    editor.scroll_y = (editor.scroll_y + delta).max(px(0.));
                }
                cx.notify();
            });
        }

        let lines = std::mem::take(&mut prepaint.lines);
        let line_height = prepaint.line_height;
        self.editor.update(cx, |editor, _| {
            editor.layouts.insert(entry_id, BlockLayout { lines, bounds, line_height });
        });
    }
}

/// La position d'un offset (octets) dans des lignes façonnées, en local.
pub fn position_in_lines(
    lines: &[WrappedLine],
    offset: usize,
    line_height: Pixels,
) -> Option<Point<Pixels>> {
    let mut line_start = 0usize;
    let mut y = px(0.);
    for line in lines {
        let line_end = line_start + line.text.len();
        if offset <= line_end {
            let local = line.position_for_index(offset - line_start, line_height)?;
            return Some(point(local.x, local.y + y));
        }
        y += line.size(line_height).height;
        line_start = line_end + 1; // le '\n' que shape_text a mangé
    }
    // un bloc vide n'a pas de ligne : le caret se pose au coin
    Some(point(px(0.), px(0.)))
}
