//! L'entité `Editor` : l'état (document, bloc actif, caret, sélection, menu
//! slash) et ce que chaque commande *fait*. Le sens des frappes vient des
//! tables de `carnet-model` ; le dessin vit dans `block.rs` et `rows.rs`.

use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, EntityInputHandler, ExternalPaths,
    FocusHandle, Focusable, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    Point, ScrollWheelEvent, UTF16Selection, Window, div, point, prelude::*, px, rgb,
};
use loro::LoroValue;
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

use carnet_model::model;
use carnet_model::store::{Document, Entry, Run};

use crate::block::BlockLayout;
use crate::slash::{self, SlashState};
use crate::{rows, theme};

use crate::{
    Backspace, Bold, Cancel, Copy, Cut, DeleteForward, Down, End, Enter, Home, Indent, InlineCode,
    Italic, Left, Outdent, Paste, Redo, Right, Save, SelectAll, SelectLeft, SelectRight,
    ShowCharacterPalette, Strike, Underline, Undo, Up,
};

pub struct Editor {
    pub(crate) doc: Document,
    path: PathBuf,
    pub(crate) entries: Vec<Entry>,
    /// Le bloc qui tient le caret. Un seul à la fois, comme un doigt.
    pub(crate) active_id: String,
    /// Miroir du texte du bloc actif ; les offsets ci-dessous sont des octets
    /// UTF-8 dedans, convertis en points de code à la frontière du store.
    pub(crate) content: String,
    pub(crate) selected_range: Range<usize>,
    pub(crate) selection_reversed: bool,
    pub(crate) marked_range: Option<Range<usize>>,
    pub(crate) layouts: HashMap<String, BlockLayout>,
    is_selecting: bool,
    pub(crate) slash: Option<SlashState>,
    /// Levé quand le caret vient de bouger : le prochain `paint` du bloc
    /// actif ramène le scroll dessus, puis le rabaisse.
    pub(crate) follow_caret: bool,
    /// Défilement manuel, en pixels depuis le haut. GPUI fournit la molette
    /// et le clip ; la position est à nous, comme le caret — le scroll natif
    /// de `div` ne voit pas nos layouts mesurés.
    pub(crate) scroll_y: Pixels,
    pub(crate) focus_handle: FocusHandle,
}

impl Editor {
    pub fn open(path: PathBuf, cx: &mut Context<Self>) -> Self {
        let doc = match std::fs::read(&path) {
            Ok(bytes) => Document::new(Some(&bytes)).expect("snapshot lisible"),
            Err(_) => Document::new(None).expect("document neuf"),
        };
        if doc.entries().is_empty() {
            let page = Uuid::now_v7().to_string();
            doc.create_page(&page, "Sans titre").expect("page");
            doc.append_paragraph("", &page, &Uuid::now_v7().to_string()).expect("paragraphe");
        }
        let entries = doc.entries();
        let first = entries.iter().find(|entry| editable(entry));
        let (active_id, content) = match first {
            Some(entry) => (entry.id.clone(), entry.text.clone().unwrap_or_default()),
            None => (String::new(), String::new()),
        };
        Self {
            doc,
            path,
            entries,
            active_id,
            content,
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            layouts: HashMap::new(),
            is_selecting: false,
            slash: None,
            follow_caret: false,
            scroll_y: px(0.),
            focus_handle: cx.focus_handle(),
        }
    }

    /// Jusqu'où on peut descendre : le bas du dernier bloc peint, plus la
    /// marge, moins la fenêtre. Les layouts sont en coordonnées fenêtre et
    /// portent déjà `scroll_y`, qu'on retire pour raisonner depuis le haut.
    fn max_scroll(&self, viewport_height: Pixels) -> Pixels {
        let bottom = self
            .layouts
            .values()
            .map(|layout| layout.bounds.bottom())
            .fold(px(0.), |a, b| if b > a { b } else { a });
        let content = bottom + self.scroll_y + px(120.);
        (content - viewport_height).max(px(0.))
    }

    pub(crate) fn scroll_by(&mut self, delta: Pixels, viewport_height: Pixels, cx: &mut Context<Self>) {
        let max = self.max_scroll(viewport_height);
        let next = (self.scroll_y - delta).max(px(0.)).min(max);
        if next != self.scroll_y {
            self.scroll_y = next;
            cx.notify();
        }
    }

    // --- état ---

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.entries = self.doc.entries();
        match self.entries.iter().find(|entry| entry.id == self.active_id) {
            Some(entry) if editable(entry) => {
                self.content = entry.text.clone().unwrap_or_default();
            }
            _ => {
                let fallback = self.entries.iter().find(|entry| editable(entry));
                self.active_id = fallback.map(|entry| entry.id.clone()).unwrap_or_default();
                self.content = fallback.and_then(|entry| entry.text.clone()).unwrap_or_default();
            }
        }
        let len = self.content.len();
        self.selected_range = snap(&self.content, self.selected_range.start.min(len))
            ..snap(&self.content, self.selected_range.end.min(len));
        self.marked_range = None;
        cx.notify();
    }

    pub(crate) fn active_entry(&self) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == self.active_id)
    }

    fn active_index(&self) -> Option<usize> {
        self.entries.iter().position(|entry| entry.id == self.active_id)
    }

    /// Un bloc caché par un dépliant replié ne se rend pas et ne se
    /// navigue pas — `visibleBlocks` côté web.
    pub(crate) fn is_visible(&self, ix: usize) -> bool {
        let mut hidden_below: Option<usize> = None;
        for (i, entry) in self.entries.iter().enumerate() {
            if let Some(depth) = hidden_below {
                if entry.depth > depth {
                    if i == ix {
                        return false;
                    }
                    continue;
                }
                hidden_below = None;
            }
            if i == ix {
                return true;
            }
            if entry.kind == "toggle" && entry.is_collapsed() {
                hidden_below = Some(entry.depth);
            }
        }
        true
    }

    fn focus_block(&mut self, id: &str, caret: usize, cx: &mut Context<Self>) {
        self.active_id = id.to_string();
        self.content = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.text.clone())
            .unwrap_or_default();
        let caret = snap(&self.content, caret.min(self.content.len()));
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        self.follow_caret = true;
        self.update_slash();
        cx.notify();
    }

    /// Pousser `content` dans le CRDT — diffé côté store, une frappe reste
    /// une frappe pour un pair.
    fn sync_text(&mut self, cx: &mut Context<Self>) {
        if !self.active_id.is_empty() {
            let _ = self.doc.set_text(&self.active_id, &self.content);
        }
        let sel = self.selected_range.clone();
        let marked = self.marked_range.clone();
        self.refresh(cx);
        self.selected_range = sel;
        self.marked_range = marked;
        self.follow_caret = true;
    }

    fn save(&mut self, _: &Save, _window: &mut Window, _cx: &mut Context<Self>) {
        if let Ok(bytes) = self.doc.snapshot() {
            if let Err(error) = std::fs::write(&self.path, bytes) {
                eprintln!("carnet-gpui: échec d'écriture {}: {error}", self.path.display());
            }
        }
    }

    // --- ce qu'une frappe veut dire (les tables de carnet-model décident) ---

    fn enter(&mut self, _: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if self.slash.is_some() {
            self.select_slash(cx);
            return;
        }
        let kind = self.active_entry().map(|entry| entry.kind.clone()).unwrap_or_default();
        // un bloc de code tient du texte littéral : Entrée y insère une ligne
        if kind == "code" {
            self.replace_text_in_range(None, "\n", window, cx);
            return;
        }
        if !self.selected_range.is_empty() {
            self.replace_text_in_range(None, "", window, cx);
        }
        let caret = model::char_of_byte(&self.content, self.selected_range.start);
        let new_id = Uuid::now_v7().to_string();
        if let Ok((id, offset)) = self.doc.split_block(&self.active_id, caret, &new_id) {
            self.refresh(cx);
            let bytes = self
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .and_then(|entry| entry.text.as_deref())
                .map(|text| model::byte_of_char(text, offset))
                .unwrap_or(0);
            self.focus_block(&id.clone(), bytes, cx);
        }
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            self.replace_text_in_range(None, "", window, cx);
            return;
        }
        if self.selected_range.start > 0 {
            let from = previous_boundary(&self.content, self.selected_range.start);
            self.selected_range = from..self.selected_range.end;
            self.replace_text_in_range(None, "", window, cx);
            return;
        }
        // au bord : un non-paragraphe redevient paragraphe, un paragraphe
        // fusionne dans le bloc d'avant — le store applique la table
        if let Ok(Some((id, offset))) = self.doc.merge_backward(&self.active_id) {
            self.refresh(cx);
            let bytes = self
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .and_then(|entry| entry.text.as_deref())
                .map(|text| model::byte_of_char(text, offset))
                .unwrap_or(0);
            self.focus_block(&id.clone(), bytes, cx);
        }
    }

    fn delete_forward(&mut self, _: &DeleteForward, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            self.replace_text_in_range(None, "", window, cx);
            return;
        }
        if self.selected_range.end < self.content.len() {
            let to = next_boundary(&self.content, self.selected_range.end);
            self.selected_range = self.selected_range.start..to;
            self.replace_text_in_range(None, "", window, cx);
            return;
        }
        // en fin de bloc : tirer le bloc suivant dans celui-ci
        let Some(here) = self.active_index() else { return };
        let caret = self.selected_range.start;
        let next = self.entries.iter().skip(here + 1).find(|entry| entry.kind != "page");
        match next {
            // ponytail: le web sélectionne le bloc vide (divider) au lieu de le
            // supprimer ; sans sélection de bloc ici, Suppr le retire directement
            Some(entry) if entry.kind == "divider" || entry.kind == "image" => {
                let id = entry.id.clone();
                let _ = self.doc.remove(&id);
                self.refresh(cx);
            }
            Some(entry) if editable(entry) => {
                let id = entry.id.clone();
                let _ = self.doc.merge_backward(&id);
                let active = self.active_id.clone();
                self.refresh(cx);
                self.focus_block(&active, caret, cx);
            }
            _ => {}
        }
    }

    fn indent(&mut self, _: &Indent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.doc.indent(&self.active_id).unwrap_or(false) {
            let (active, caret) = (self.active_id.clone(), self.selected_range.clone());
            self.refresh(cx);
            self.active_id = active;
            self.selected_range = caret;
        }
    }

    fn outdent(&mut self, _: &Outdent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.doc.outdent(&self.active_id).unwrap_or(false) {
            let (active, caret) = (self.active_id.clone(), self.selected_range.clone());
            self.refresh(cx);
            self.active_id = active;
            self.selected_range = caret;
        }
    }

    fn undo(&mut self, _: &Undo, _window: &mut Window, cx: &mut Context<Self>) {
        if self.doc.undo() {
            self.refresh(cx);
        }
    }

    fn redo(&mut self, _: &Redo, _window: &mut Window, cx: &mut Context<Self>) {
        if self.doc.redo() {
            self.refresh(cx);
        }
    }

    // --- caret et sélection, dans le bloc et entre les blocs ---

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed { self.selected_range.start } else { self.selected_range.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = snap(&self.content, offset.min(self.content.len()));
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.follow_caret = true;
        self.update_slash();
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = snap(&self.content, offset.min(self.content.len()));
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify();
    }

    /// L'entrée éditable — et visible — la plus proche dans une direction.
    fn neighbor(&self, direction: isize) -> Option<&Entry> {
        let here = self.active_index()?;
        let mut ix = here as isize + direction;
        while ix >= 0 && (ix as usize) < self.entries.len() {
            let entry = &self.entries[ix as usize];
            if editable(entry) && self.is_visible(ix as usize) {
                return Some(entry);
            }
            ix += direction;
        }
        None
    }

    fn left(&mut self, _: &Left, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            let start = self.selected_range.start;
            self.move_to(start, cx);
        } else if self.selected_range.start > 0 {
            let prev = previous_boundary(&self.content, self.cursor_offset());
            self.move_to(prev, cx);
        } else if let Some(entry) = self.neighbor(-1) {
            let (id, len) = (entry.id.clone(), entry.text.as_deref().map_or(0, str::len));
            self.focus_block(&id, len, cx);
        }
    }

    fn right(&mut self, _: &Right, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            let end = self.selected_range.end;
            self.move_to(end, cx);
        } else if self.selected_range.end < self.content.len() {
            let next = next_boundary(&self.content, self.cursor_offset());
            self.move_to(next, cx);
        } else if let Some(entry) = self.neighbor(1) {
            let id = entry.id.clone();
            self.focus_block(&id, 0, cx);
        }
    }

    // ponytail: Haut/Bas changent de bloc en gardant l'offset ; pas de mémoire
    // de colonne ni de navigation dans les lignes repliées — à ajouter quand ça
    // manquera sous les doigts
    fn up(&mut self, _: &Up, _window: &mut Window, cx: &mut Context<Self>) {
        if self.slash.is_some() {
            let count = self.slash_filtered().len();
            if let Some(state) = self.slash.as_mut() {
                state.selected = if state.selected == 0 { count - 1 } else { state.selected - 1 };
            }
            cx.notify();
            return;
        }
        if let Some(entry) = self.neighbor(-1) {
            let (id, caret) = (entry.id.clone(), self.selected_range.start);
            self.focus_block(&id, caret, cx);
        } else {
            self.move_to(0, cx);
        }
    }

    fn down(&mut self, _: &Down, _window: &mut Window, cx: &mut Context<Self>) {
        if self.slash.is_some() {
            let count = self.slash_filtered().len();
            if let Some(state) = self.slash.as_mut() {
                state.selected = (state.selected + 1) % count;
            }
            cx.notify();
            return;
        }
        if let Some(entry) = self.neighbor(1) {
            let (id, caret) = (entry.id.clone(), self.selected_range.start);
            self.focus_block(&id, caret, cx);
        } else {
            let len = self.content.len();
            self.move_to(len, cx);
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(previous_boundary(&self.content, self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_boundary(&self.content, self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx);
    }

    fn home(&mut self, _: &Home, _window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _window: &mut Window, cx: &mut Context<Self>) {
        let len = self.content.len();
        self.move_to(len, cx);
    }

    // --- marques ---

    fn toggle_mark(&mut self, mark: &str, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            return;
        }
        let from = model::char_of_byte(&self.content, self.selected_range.start);
        let to = model::char_of_byte(&self.content, self.selected_range.end);
        // « déjà formaté » = chaque tronçon couvert porte la marque
        let covered = self
            .active_entry()
            .map(|entry| range_has_mark(&entry.runs, from, to, mark))
            .unwrap_or(false);
        let (sel, reversed) = (self.selected_range.clone(), self.selection_reversed);
        let _ = self.doc.mark(&self.active_id, from, to, mark, !covered);
        self.refresh(cx);
        self.selected_range = sel;
        self.selection_reversed = reversed;
    }

    fn bold(&mut self, _: &Bold, _w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mark("bold", cx);
    }
    fn italic(&mut self, _: &Italic, _w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mark("italic", cx);
    }
    fn underline(&mut self, _: &Underline, _w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mark("underline", cx);
    }
    fn strike(&mut self, _: &Strike, _w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mark("strike", cx);
    }
    fn inline_code(&mut self, _: &InlineCode, _w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mark("code", cx);
    }

    // --- presse-papier ---

    fn copy(&mut self, _: &Copy, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let kind = self.active_entry().map(|entry| entry.kind.clone()).unwrap_or_default();
            // ponytail: coller du multi-ligne devrait scinder en blocs comme le
            // web ; ici il s'aplatit (sauf dans un bloc de code) — à faire quand
            // le presse-papier de blocs arrivera
            let text = if kind == "code" { text.to_string() } else { text.replace('\n', " ") };
            self.replace_text_in_range(None, &text, window, cx);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    // --- souris et gestes de bloc ---

    pub(crate) fn click_block(&mut self, ix: usize, event: &MouseDownEvent, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        if !editable(entry) {
            return;
        }
        let id = entry.id.clone();
        if id != self.active_id {
            self.focus_block(&id, 0, cx);
        }
        let offset = self.offset_at(&id, event.position);
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(offset, cx);
        } else {
            self.move_to(offset, cx);
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            let id = self.active_id.clone();
            let offset = self.offset_at(&id, event.position);
            self.select_to(offset, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    pub(crate) fn toggle_todo(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        let (id, checked) = (entry.id.clone(), entry.is_checked());
        let _ = self.doc.set_prop(&id, "checked", LoroValue::Bool(!checked));
        self.refresh(cx);
    }

    pub(crate) fn toggle_fold(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        let (id, collapsed) = (entry.id.clone(), entry.is_collapsed());
        let _ = self.doc.set_prop(&id, "collapsed", LoroValue::Bool(!collapsed));
        self.refresh(cx);
    }

    /// Des fichiers déposés sur la fenêtre : chaque image devient un bloc
    /// image après le bloc actif, `src` en data-URL — la forme que le web
    /// écrit et lit sans magasin d'assets.
    fn drop_files(&mut self, paths: &[PathBuf], cx: &mut Context<Self>) {
        let mut after = self.active_id.clone();
        if after.is_empty() {
            return;
        }
        let mut inserted = false;
        for path in paths {
            if !crate::assets::is_image_file(path) {
                eprintln!("carnet-gpui: pas une image, ignoré : {}", path.display());
                continue;
            }
            let Some(url) = crate::assets::data_url_from_file(path) else { continue };
            let id = Uuid::now_v7().to_string();
            let caption = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let _ = self.doc.insert_block_after(
                &after,
                &id,
                "image",
                &[("src", LoroValue::from(url)), ("caption", LoroValue::from(caption))],
            );
            after = id;
            inserted = true;
        }
        if inserted {
            self.refresh(cx);
        }
    }

    /// L'offset (octets) sous un point en coordonnées fenêtre, dans un bloc.
    fn offset_at(&self, id: &str, position: Point<Pixels>) -> usize {
        let Some(layout) = self.layouts.get(id) else { return 0 };
        let local = position - layout.bounds.origin;
        if local.y < px(0.) {
            return 0;
        }
        let mut line_start = 0usize;
        let mut y = px(0.);
        for line in &layout.lines {
            let height = line.size(layout.line_height).height;
            if local.y < y + height {
                let in_line = point(local.x, local.y - y);
                return match line.closest_index_for_position(in_line, layout.line_height) {
                    Ok(ix) | Err(ix) => line_start + ix,
                };
            }
            y += height;
            line_start += line.text.len() + 1; // +1 : le '\n' que shape_text a mangé
        }
        self.content.len()
    }

    /// La position (coordonnées fenêtre) d'un offset dans un bloc.
    pub(crate) fn position_of(&self, id: &str, offset: usize) -> Option<Point<Pixels>> {
        let layout = self.layouts.get(id)?;
        let mut line_start = 0usize;
        let mut y = px(0.);
        for line in &layout.lines {
            let line_end = line_start + line.text.len();
            if offset <= line_end {
                let local = line.position_for_index(offset - line_start, layout.line_height)?;
                return Some(layout.bounds.origin + point(local.x, local.y + y));
            }
            y += line.size(layout.line_height).height;
            line_start = line_end + 1;
        }
        None
    }

    // --- le menu slash (la table vit dans `slash.rs`) ---

    /// Ce qui est tapé après le `/`, ou `None` si le menu doit se fermer —
    /// les mêmes conditions de fermeture que `attachSlashMenu` côté web.
    fn slash_query(&self) -> Option<String> {
        let state = self.slash.as_ref()?;
        if state.block_id != self.active_id || !self.selected_range.is_empty() {
            return None;
        }
        let caret = self.selected_range.start;
        if caret <= state.trigger {
            return None;
        }
        if self.content.get(state.trigger..state.trigger + 1) != Some("/") {
            return None;
        }
        let query = self.content.get(state.trigger + 1..caret)?;
        if query.chars().count() > 12 {
            return None;
        }
        Some(query.to_string())
    }

    pub(crate) fn slash_filtered(&self) -> Vec<usize> {
        match self.slash_query() {
            Some(query) => slash::filter(&query),
            None => Vec::new(),
        }
    }

    fn update_slash(&mut self) {
        if self.slash.is_none() {
            return;
        }
        let filtered = self.slash_filtered();
        if filtered.is_empty() {
            self.slash = None;
            return;
        }
        if let Some(state) = self.slash.as_mut() {
            state.selected = state.selected.min(filtered.len() - 1);
        }
    }

    pub(crate) fn select_slash(&mut self, cx: &mut Context<Self>) {
        let filtered = self.slash_filtered();
        let Some(state) = self.slash.take() else { return };
        let Some(&picked) = filtered.get(state.selected) else { return };
        let item = &slash::ITEMS[picked];

        // retirer « /requête » du texte, comme le web avant conversion
        let caret = self.selected_range.start;
        self.content.replace_range(state.trigger..caret, "");
        self.selected_range = state.trigger..state.trigger;
        self.sync_text(cx);

        let id = self.active_id.clone();
        let kind = self.active_entry().map(|entry| entry.kind.clone()).unwrap_or_default();
        let convert_in_place = self.content.is_empty() && kind == "paragraph";
        let props: Vec<(&str, LoroValue)> =
            item.props.iter().map(|(key, prop)| (*key, prop.to_loro())).collect();

        // un bloc sans texte (séparateur, image) prend un paragraphe frais
        // derrière lui, et c'est lui qui reçoit le caret
        if item.kind == "divider" || item.kind == "image" {
            let fresh = Uuid::now_v7().to_string();
            if convert_in_place {
                let _ = self.doc.turn_into(&id, item.kind, &props);
                let _ = self.doc.insert_paragraph_after(&id, &fresh);
            } else {
                let void = Uuid::now_v7().to_string();
                let _ = self.doc.insert_block_after(&id, &void, item.kind, &props);
                let _ = self.doc.insert_paragraph_after(&void, &fresh);
            }
            self.refresh(cx);
            self.focus_block(&fresh, 0, cx);
            return;
        }

        if convert_in_place {
            let _ = self.doc.turn_into(&id, item.kind, &props);
            self.refresh(cx);
            self.focus_block(&id, 0, cx);
        } else {
            let fresh = Uuid::now_v7().to_string();
            let _ = self.doc.insert_block_after(&id, &fresh, item.kind, &props);
            self.refresh(cx);
            self.focus_block(&fresh, 0, cx);
        }
    }

    fn cancel(&mut self, _: &Cancel, _window: &mut Window, cx: &mut Context<Self>) {
        self.slash = None;
        self.marked_range = None;
        cx.notify();
    }

    // --- autoformat : la table de carnet-model, déclenchée à la frappe ---

    fn autoformat(&mut self, cx: &mut Context<Self>) {
        let Some(entry) = self.active_entry() else { return };
        if entry.kind != "paragraph" {
            return; // un bloc de code tient du texte littéral, les autres sont déjà convertis
        }
        let before = &self.content[..self.selected_range.start];

        if before == model::DIVIDER_TEXT && self.content == model::DIVIDER_TEXT {
            let id = self.active_id.clone();
            let fresh = Uuid::now_v7().to_string();
            let _ = self.doc.set_text(&id, "");
            let _ = self.doc.turn_into(&id, "divider", &[]);
            let _ = self.doc.insert_paragraph_after(&id, &fresh);
            self.refresh(cx);
            self.focus_block(&fresh, 0, cx);
            return;
        }

        let Some(rule) = model::match_autoformat(before) else { return };
        let id = self.active_id.clone();
        let rest = self.content[rule.prefix.len()..].to_string();
        let props: Vec<(&str, LoroValue)> = rule
            .props
            .iter()
            .map(|(key, prop)| {
                (*key, match prop {
                    model::Prop::Num(number) => LoroValue::I64(*number),
                    model::Prop::Bool(flag) => LoroValue::Bool(*flag),
                })
            })
            .collect();
        let _ = self.doc.set_text(&id, &rest);
        let _ = self.doc.turn_into(&id, rule.kind, &props);
        self.refresh(cx);
        self.focus_block(&id, 0, cx);
    }

    // --- conversions UTF-16 (ce que l'IME parle) ---

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        let start =
            model::byte_of_char(&self.content, model::char_of_utf16(&self.content, range.start));
        let end =
            model::byte_of_char(&self.content, model::char_of_utf16(&self.content, range.end));
        start..end
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        let start =
            model::utf16_of_char(&self.content, model::char_of_byte(&self.content, range.start));
        let end =
            model::utf16_of_char(&self.content, model::char_of_byte(&self.content, range.end));
        start..end
    }
}

pub(crate) fn editable(entry: &Entry) -> bool {
    entry.text.is_some() && !matches!(entry.kind.as_str(), "page" | "divider" | "image")
}

/// Reculer `offset` jusqu'à une frontière de caractère.
fn snap(text: &str, mut offset: usize) -> usize {
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// Une pression, un caractère perçu : les frontières sont des graphèmes, pour
/// qu'un emoji famille sorte entier au lieu de se défaire en débris (AQ#4).
fn previous_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .rev()
        .find_map(|(ix, _)| (ix < offset).then_some(ix))
        .unwrap_or(0)
}

fn next_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .find_map(|(ix, _)| (ix > offset).then_some(ix))
        .unwrap_or(text.len())
}

/// Chaque point de code de `[from, to)` (en points de code) porte-t-il la marque ?
fn range_has_mark(runs: &[Run], from: usize, to: usize, mark: &str) -> bool {
    let mut seen = 0usize;
    let mut covered = true;
    for run in runs {
        let width = run.text.chars().count();
        let (start, end) = (seen, seen + width);
        if end > from && start < to && !run.has(mark) {
            covered = false;
        }
        seen = end;
    }
    covered && to > from && to <= seen.max(to)
}

impl EntityInputHandler for Editor {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        adjusted_range.replace(self.range_to_utf16(&range));
        Some(self.content.get(range)?.to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        let caret = range.start + new_text.len();
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        self.sync_text(cx);
        if !new_text.is_empty() {
            self.autoformat(cx);
        }
        // taper `/` ouvre le menu ; tout le reste ne fait que le refiltrer
        if new_text == "/" && self.slash.is_none() {
            self.slash = Some(SlashState {
                block_id: self.active_id.clone(),
                trigger: self.selected_range.start.saturating_sub(1),
                selected: 0,
            });
        }
        self.update_slash();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        self.marked_range = if new_text.is_empty() {
            None
        } else {
            Some(range.start..range.start + new_text.len())
        };
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|selected| {
                let inner = self.range_from_utf16(selected);
                range.start + inner.start..range.start + inner.end
            })
            .unwrap_or_else(|| {
                let caret = range.start + new_text.len();
                caret..caret
            });
        self.sync_text(cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        let layout = self.layouts.get(&self.active_id)?;
        let start = self.position_of(&self.active_id, range.start)?;
        let end = self
            .position_of(&self.active_id, range.end)
            .unwrap_or_else(|| start + point(px(0.), px(0.)));
        Some(Bounds::from_corners(start, point(end.x, end.y + layout.line_height)))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let offset = self.offset_at(&self.active_id.clone(), position);
        Some(self.range_to_utf16(&(offset..offset)).start)
    }
}

impl Render for Editor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows: Vec<_> = self
            .entries
            .iter()
            .enumerate()
            .skip(1)
            .filter(|(ix, _)| self.is_visible(*ix))
            .map(|(ix, entry)| rows::row(self, ix, entry, cx))
            .collect();

        let menu = slash::menu(self, cx);

        div()
            .size_full()
            .bg(gpui::white())
            .key_context("Editor")
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .font_family(theme::FONT_SANS)
            .text_size(px(16.))
            .text_color(rgb(theme::TEXT))
            .on_action(cx.listener(Self::enter))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete_forward))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::indent))
            .on_action(cx.listener(Self::outdent))
            .on_action(cx.listener(Self::bold))
            .on_action(cx.listener(Self::italic))
            .on_action(cx.listener(Self::underline))
            .on_action(cx.listener(Self::strike))
            .on_action(cx.listener(Self::inline_code))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::save))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::show_character_palette))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_drop(cx.listener(|editor, paths: &ExternalPaths, _window, cx| {
                editor.drop_files(paths.paths(), cx);
            }))
            .on_scroll_wheel(cx.listener(|editor, event: &ScrollWheelEvent, window, cx| {
                let delta = event.delta.pixel_delta(window.line_height()).y;
                let viewport = window.viewport_size().height;
                editor.scroll_by(delta, viewport, cx);
            }))
            .child(
                div()
                    .size_full()
                    .overflow_hidden()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .w(px(680.))
                            .py(px(56.))
                            .relative()
                            .top(-self.scroll_y)
                            .child(rows::title(self))
                            .children(rows),
                    ),
            )
            .children(menu)
    }
}

impl Focusable for Editor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
