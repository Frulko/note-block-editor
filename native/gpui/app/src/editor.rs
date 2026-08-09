//! L'entité `Editor` : l'état d'un document ouvert (caret, sélection de
//! texte, sélection de blocs, glissé, menus) et ce que chaque commande
//! *fait*. Le sens des frappes vient des tables de `carnet-model` ; le
//! dessin vit dans `block.rs` (le texte) et `rows.rs` (l'habillage).

use std::collections::HashMap;
use std::ops::Range;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, EventEmitter, ExternalPaths, FocusHandle,
    Focusable, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    ScrollWheelEvent, Task, UTF16Selection, Window, div, point, prelude::*, px,
};
use gpui::EntityInputHandler;
use loro::LoroValue;
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

use carnet_model::blocks::DropEdge;
use carnet_model::model;
use carnet_model::store::{Document, Entry, Run};

use crate::block::BlockLayout;
use crate::scrollbar::Scrollbar;
use crate::slash::{self, SlashState};
use crate::theme::theme;
use crate::{rows, ui};

use crate::{
    Backspace, Bold, Cancel, Copy, Cut, DeleteForward, Down, Duplicate, End, Enter, Home, Indent,
    InlineCode, Italic, Left, MoveBlockDown, MoveBlockUp, Outdent, Paste, Redo, Right, SelectAll,
    SelectLeft, SelectRight, ShowCharacterPalette, Strike, Underline, Undo, Up,
};

/// Le document a changé : le workspace l'entend pour sauvegarder.
pub enum EditorEvent {
    Changed,
}

impl EventEmitter<EditorEvent> for Editor {}

/// Une sélection de blocs : deux extrémités, résolues en liste par le modèle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSelection {
    pub anchor: String,
    pub head: String,
}

/// Ce qu'on traîne. Le type sert de clé au système de glissé de GPUI :
/// seule une rangée qui écoute `DraggedBlocks` réagira.
#[derive(Debug, Clone)]
pub struct DraggedBlocks(pub Vec<String>);

/// Un menu de bloc ouvert (la poignée ⋮⋮).
pub struct BlockMenu {
    /// Le bloc dont la poignée a ouvert le menu — les actions portent sur la
    /// sélection, qu'`open_block_menu` a posée dessus.
    #[allow(dead_code)]
    pub block_id: String,
    pub at: Point<Pixels>,
    pub selected: usize,
}

pub struct Editor {
    pub doc: Document,
    pub entries: Vec<Entry>,
    /// Le bloc qui tient le caret. Un seul à la fois, comme un doigt.
    pub active_id: String,
    /// Miroir du texte du bloc actif ; les offsets ci-dessous sont des octets
    /// UTF-8 dedans, convertis en points de code à la frontière du store.
    pub content: String,
    pub selected_range: Range<usize>,
    pub selection_reversed: bool,
    pub marked_range: Option<Range<usize>>,
    /// Non vide quand on est en **mode bloc** : le caret disparaît, les
    /// touches changent de sens.
    pub block_selection: Option<BlockSelection>,
    pub layouts: HashMap<String, BlockLayout>,
    is_selecting: bool,
    pub slash: Option<SlashState>,
    pub block_menu: Option<BlockMenu>,
    pub drop_target: Option<(String, DropEdge)>,
    /// Les blocs actuellement traînés. GPUI ne nous livre pas son `on_drop`
    /// dans cette disposition (la rangée n'est jamais « survolée » au sens du
    /// hit-test au moment du relâchement), alors on valide nous-mêmes au
    /// relâchement, depuis la cible que `on_drag_move` tient à jour.
    pub dragging: Option<Vec<String>>,
    /// Levé quand le caret vient de bouger : le prochain `paint` du bloc
    /// actif ramène le défilement dessus, puis le rabaisse.
    pub follow_caret: bool,
    /// Défilement manuel, en pixels depuis le haut : la scrollbar native de
    /// `div` ne voit pas nos blocs, dont la hauteur est mesurée à la main.
    pub scroll_y: Pixels,
    pub content_height: Pixels,
    /// La hauteur réellement visible du document — mesurée par la scrollbar,
    /// qui la connaît au pixel ; la fenêtre entière compterait en trop la
    /// barre du haut et celle du bas, et les derniers blocs resteraient
    /// inatteignables.
    pub viewport_height: Pixels,
    pub scroll_drag: Option<Pixels>,
    /// Le caret est-il allumé à cet instant ?
    pub blink_on: bool,
    last_input: Instant,
    _blink: Option<Task<()>>,
    pub focus_handle: FocusHandle,
}

impl Editor {
    pub fn new(doc: Document, cx: &mut Context<Self>) -> Self {
        let entries = doc.visible_entries();
        let first = entries.iter().find(|entry| editable(entry));
        let (active_id, content) = match first {
            Some(entry) => (entry.id.clone(), entry.text.clone().unwrap_or_default()),
            None => (String::new(), String::new()),
        };
        let mut editor = Self {
            doc,
            entries,
            active_id,
            content,
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            block_selection: None,
            layouts: HashMap::new(),
            is_selecting: false,
            slash: None,
            block_menu: None,
            drop_target: None,
            dragging: None,
            follow_caret: false,
            scroll_y: px(0.),
            content_height: px(0.),
            viewport_height: px(0.),
            scroll_drag: None,
            blink_on: true,
            last_input: Instant::now(),
            _blink: None,
            focus_handle: cx.focus_handle(),
        };
        editor.start_blinking(cx);
        editor
    }

    /// Le caret clignote une fois la frappe finie, et reste plein pendant
    /// qu'on tape : un caret qui disparaît sous les doigts se cherche.
    fn start_blinking(&mut self, cx: &mut Context<Self>) {
        self._blink = Some(cx.spawn(async move |editor, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(265)).await;
                let updated = editor.update(cx, |editor, cx| {
                    let idle = editor.last_input.elapsed() > Duration::from_millis(530);
                    let next = if idle { !editor.blink_on } else { true };
                    if next != editor.blink_on {
                        editor.blink_on = next;
                        cx.notify();
                    }
                });
                if updated.is_err() {
                    break; // l'éditeur a disparu : le fil s'arrête avec lui
                }
            }
        }));
    }

    /// Rallumer le caret : appelé à chaque frappe et à chaque déplacement.
    fn wake_caret(&mut self) {
        self.last_input = Instant::now();
        self.blink_on = true;
        self.follow_caret = true;
    }

    // --- état ---

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.entries = self.doc.visible_entries();
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
        cx.emit(EditorEvent::Changed);
        cx.notify();
    }

    /// Relire le document après une modification venue d'ailleurs (un pair).
    pub fn reload_from_peer(&mut self, cx: &mut Context<Self>) {
        self.entries = self.doc.visible_entries();
        if let Some(entry) = self.entries.iter().find(|entry| entry.id == self.active_id) {
            let text = entry.text.clone().unwrap_or_default();
            if text != self.content {
                // le caret garde sa place tant que le texte le permet
                self.content = text;
                let len = self.content.len();
                self.selected_range = snap(&self.content, self.selected_range.start.min(len))
                    ..snap(&self.content, self.selected_range.end.min(len));
            }
        }
        cx.notify();
    }

    pub fn active_entry(&self) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == self.active_id)
    }

    fn active_index(&self) -> Option<usize> {
        self.entries.iter().position(|entry| entry.id == self.active_id)
    }

    /// Les blocs de la sélection courante, normalisés par le modèle.
    pub fn selected_ids(&self) -> Vec<String> {
        match &self.block_selection {
            Some(selection) => self.doc.selected_blocks(&selection.anchor, &selection.head),
            None => Vec::new(),
        }
    }

    pub fn is_selected(&self, id: &str) -> bool {
        match &self.block_selection {
            Some(_) => {
                let ids = self.selected_ids();
                ids.iter().any(|selected| {
                    selected == id || self.doc.ancestors(id).contains(selected)
                })
            }
            None => false,
        }
    }

    fn focus_block(&mut self, id: &str, caret: usize, cx: &mut Context<Self>) {
        self.active_id = id.to_string();
        self.block_selection = None;
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
        self.wake_caret();
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
        self.wake_caret();
    }

    // --- ce qu'une frappe veut dire ---

    fn enter(&mut self, _: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if self.block_menu.is_some() {
            self.pick_block_menu(cx);
            return;
        }
        if self.slash.is_some() {
            self.select_slash(cx);
            return;
        }
        // en mode bloc, Entrée revient au texte, caret en fin du bloc tête
        if let Some(selection) = self.block_selection.clone() {
            let head = selection.head.clone();
            let len = self
                .entries
                .iter()
                .find(|entry| entry.id == head)
                .and_then(|entry| entry.text.as_ref())
                .map(|text| text.len())
                .unwrap_or(0);
            self.focus_block(&head, len, cx);
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
        if self.block_selection.is_some() {
            self.delete_selected_blocks(cx);
            return;
        }
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
        if self.block_selection.is_some() {
            self.delete_selected_blocks(cx);
            return;
        }
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
        let Some(here) = self.active_index() else { return };
        let caret = self.selected_range.start;
        let next = self.entries.iter().skip(here + 1).find(|entry| entry.kind != "page");
        match next {
            // un bloc sans caret ne se fusionne pas : le web le sélectionne,
            // ce qu'on fait aussi maintenant qu'il y a un mode bloc
            Some(entry) if !editable(entry) => {
                let id = entry.id.clone();
                self.block_selection = Some(BlockSelection { anchor: id.clone(), head: id });
                cx.notify();
            }
            Some(entry) => {
                let id = entry.id.clone();
                let _ = self.doc.merge_backward(&id);
                let active = self.active_id.clone();
                self.refresh(cx);
                self.focus_block(&active, caret, cx);
            }
            _ => {}
        }
    }

    fn delete_selected_blocks(&mut self, cx: &mut Context<Self>) {
        let ids = self.selected_ids();
        if ids.is_empty() {
            return;
        }
        let caret = self.doc.delete_blocks(&ids).ok().flatten();
        self.block_selection = None;
        self.refresh(cx);
        match caret {
            Some((id, offset)) => {
                let bytes = self
                    .entries
                    .iter()
                    .find(|entry| entry.id == id)
                    .and_then(|entry| entry.text.as_deref())
                    .map(|text| model::byte_of_char(text, offset))
                    .unwrap_or(0);
                self.focus_block(&id.clone(), bytes, cx);
            }
            None => cx.notify(),
        }
    }

    fn duplicate(&mut self, _: &Duplicate, _window: &mut Window, cx: &mut Context<Self>) {
        // en mode texte, ⌘D duplique le bloc du caret ; en mode bloc, la
        // sélection entière — comme le web
        let ids = match self.block_selection {
            Some(_) => self.selected_ids(),
            None => vec![self.active_id.clone()],
        };
        if ids.is_empty() {
            return;
        }
        let created = self.doc.duplicate_blocks(&ids, || Uuid::now_v7().to_string()).unwrap_or_default();
        self.refresh(cx);
        if let (Some(first), Some(last)) = (created.first(), created.last()) {
            if self.block_selection.is_some() {
                self.block_selection =
                    Some(BlockSelection { anchor: first.clone(), head: last.clone() });
            }
        }
        cx.notify();
    }

    fn move_block_up(&mut self, _: &MoveBlockUp, _window: &mut Window, cx: &mut Context<Self>) {
        self.move_blocks(true, cx);
    }

    fn move_block_down(&mut self, _: &MoveBlockDown, _window: &mut Window, cx: &mut Context<Self>) {
        self.move_blocks(false, cx);
    }

    fn move_blocks(&mut self, up: bool, cx: &mut Context<Self>) {
        let ids = match self.block_selection {
            Some(_) => self.selected_ids(),
            None => vec![self.active_id.clone()],
        };
        if ids.is_empty() {
            return;
        }
        if self.doc.move_blocks_vertical(&ids, up).unwrap_or(false) {
            let (active, caret, selection) =
                (self.active_id.clone(), self.selected_range.clone(), self.block_selection.clone());
            self.refresh(cx);
            self.active_id = active;
            self.selected_range = caret;
            self.block_selection = selection;
            self.follow_caret = true;
        }
    }

    fn indent(&mut self, _: &Indent, _window: &mut Window, cx: &mut Context<Self>) {
        // en mode bloc, le web n'indente que si un seul bloc est sélectionné
        let id = match &self.block_selection {
            Some(_) => {
                let ids = self.selected_ids();
                if ids.len() != 1 {
                    return;
                }
                ids[0].clone()
            }
            None => self.active_id.clone(),
        };
        if self.doc.indent(&id).unwrap_or(false) {
            self.keep_place(cx);
        }
    }

    fn outdent(&mut self, _: &Outdent, _window: &mut Window, cx: &mut Context<Self>) {
        let id = match &self.block_selection {
            Some(_) => {
                let ids = self.selected_ids();
                if ids.len() != 1 {
                    return;
                }
                ids[0].clone()
            }
            None => self.active_id.clone(),
        };
        if self.doc.outdent(&id).unwrap_or(false) {
            self.keep_place(cx);
        }
    }

    /// Rafraîchir sans perdre où on était — après un déplacement structurel.
    fn keep_place(&mut self, cx: &mut Context<Self>) {
        let (active, caret, selection) =
            (self.active_id.clone(), self.selected_range.clone(), self.block_selection.clone());
        self.refresh(cx);
        self.active_id = active;
        self.selected_range = caret;
        self.block_selection = selection;
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

    // --- caret, sélection de texte, sélection de blocs ---

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed { self.selected_range.start } else { self.selected_range.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = snap(&self.content, offset.min(self.content.len()));
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.wake_caret();
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
        self.wake_caret();
        cx.notify();
    }

    /// L'entrée éditable la plus proche dans une direction.
    fn neighbor(&self, direction: isize) -> Option<&Entry> {
        let here = self.active_index()?;
        let mut ix = here as isize + direction;
        while ix >= 0 && (ix as usize) < self.entries.len() {
            let entry = &self.entries[ix as usize];
            if editable(entry) {
                return Some(entry);
            }
            ix += direction;
        }
        None
    }

    fn left(&mut self, _: &Left, _window: &mut Window, cx: &mut Context<Self>) {
        if self.block_selection.is_some() {
            return;
        }
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
        if self.block_selection.is_some() {
            return;
        }
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

    fn up(&mut self, _: &Up, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(menu) = self.block_menu.as_mut() {
            menu.selected = menu.selected.saturating_sub(1);
            cx.notify();
            return;
        }
        if self.slash.is_some() {
            let count = self.slash_filtered().len();
            if let Some(state) = self.slash.as_mut() {
                state.selected = if state.selected == 0 { count - 1 } else { state.selected - 1 };
            }
            cx.notify();
            return;
        }
        if self.block_selection.is_some() {
            self.move_block_head(-1, false, cx);
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
        if let Some(menu) = self.block_menu.as_mut() {
            menu.selected = (menu.selected + 1).min(rows::BLOCK_MENU.len() - 1);
            cx.notify();
            return;
        }
        if self.slash.is_some() {
            let count = self.slash_filtered().len();
            if let Some(state) = self.slash.as_mut() {
                state.selected = (state.selected + 1) % count;
            }
            cx.notify();
            return;
        }
        if self.block_selection.is_some() {
            self.move_block_head(1, false, cx);
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

    /// Déplacer la tête d'une sélection de blocs. Avec `extend`, l'ancre
    /// reste : c'est Maj+flèche.
    fn move_block_head(&mut self, direction: isize, extend: bool, cx: &mut Context<Self>) {
        let Some(selection) = self.block_selection.clone() else { return };
        let Some(here) = self.entries.iter().position(|entry| entry.id == selection.head) else {
            return;
        };
        let next = here as isize + direction;
        if next < 0 || next as usize >= self.entries.len() {
            return;
        }
        let head = self.entries[next as usize].id.clone();
        self.block_selection = Some(BlockSelection {
            anchor: if extend { selection.anchor } else { head.clone() },
            head,
        });
        cx.notify();
    }

    fn select_left(&mut self, _: &SelectLeft, _window: &mut Window, cx: &mut Context<Self>) {
        if self.block_selection.is_some() {
            self.move_block_head(-1, true, cx);
            return;
        }
        self.select_to(previous_boundary(&self.content, self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _window: &mut Window, cx: &mut Context<Self>) {
        if self.block_selection.is_some() {
            self.move_block_head(1, true, cx);
            return;
        }
        self.select_to(next_boundary(&self.content, self.cursor_offset()), cx);
    }

    /// ⌘A, en escalade : tout le texte du bloc, puis le bloc, puis le
    /// document — la progression de Notion.
    fn select_all(&mut self, _: &SelectAll, _window: &mut Window, cx: &mut Context<Self>) {
        if self.block_selection.is_some() {
            let (Some(first), Some(last)) = (self.entries.first(), self.entries.last()) else {
                return;
            };
            self.block_selection =
                Some(BlockSelection { anchor: first.id.clone(), head: last.id.clone() });
            cx.notify();
            return;
        }
        let whole = self.selected_range.start == 0 && self.selected_range.end == self.content.len();
        if whole && !self.content.is_empty() || self.content.is_empty() {
            self.block_selection = Some(BlockSelection {
                anchor: self.active_id.clone(),
                head: self.active_id.clone(),
            });
            cx.notify();
            return;
        }
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

    /// Échap : ferme ce qui est ouvert, puis passe en mode bloc, puis en
    /// sort. C'est la chaîne documentée dans `keymap.ts`.
    fn cancel(&mut self, _: &Cancel, _window: &mut Window, cx: &mut Context<Self>) {
        if self.block_menu.take().is_some() || self.slash.take().is_some() {
            cx.notify();
            return;
        }
        match self.block_selection.take() {
            Some(_) => {}
            None if !self.active_id.is_empty() => {
                self.block_selection = Some(BlockSelection {
                    anchor: self.active_id.clone(),
                    head: self.active_id.clone(),
                });
            }
            None => {}
        }
        self.marked_range = None;
        cx.notify();
    }

    // --- marques ---

    fn toggle_mark(&mut self, mark: &str, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            return;
        }
        let from = model::char_of_byte(&self.content, self.selected_range.start);
        let to = model::char_of_byte(&self.content, self.selected_range.end);
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
        let text = match self.block_selection {
            Some(_) => self
                .selected_ids()
                .iter()
                .filter_map(|id| self.entries.iter().find(|entry| &entry.id == id))
                .filter_map(|entry| entry.text.clone())
                .collect::<Vec<_>>()
                .join("\n"),
            None if !self.selected_range.is_empty() => {
                self.content[self.selected_range.clone()].to_string()
            }
            None => return,
        };
        if !text.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        self.copy(&Copy, window, cx);
        if self.block_selection.is_some() {
            self.delete_selected_blocks(cx);
        } else if !self.selected_range.is_empty() {
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let kind = self.active_entry().map(|entry| entry.kind.clone()).unwrap_or_default();
            // ponytail: coller du multi-ligne devrait scinder en blocs comme le
            // web ; ici il s'aplatit (sauf dans un bloc de code)
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

    pub fn click_block(&mut self, ix: usize, event: &MouseDownEvent, cx: &mut Context<Self>) {
        self.block_menu = None;
        let Some(entry) = self.entries.get(ix) else { return };
        if !editable(entry) {
            // un bloc sans caret se sélectionne au clic
            let id = entry.id.clone();
            self.block_selection = Some(BlockSelection { anchor: id.clone(), head: id });
            cx.notify();
            return;
        }
        let id = entry.id.clone();
        if id != self.active_id {
            self.focus_block(&id, 0, cx);
        }
        self.block_selection = None;
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

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.is_selecting = false;
        self.commit_drop(cx);
    }

    pub fn toggle_todo(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        let (id, checked) = (entry.id.clone(), entry.is_checked());
        let _ = self.doc.set_prop(&id, "checked", LoroValue::Bool(!checked));
        self.refresh(cx);
    }

    pub fn toggle_fold(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        let (id, collapsed) = (entry.id.clone(), entry.is_collapsed());
        let _ = self.doc.set_prop(&id, "collapsed", LoroValue::Bool(!collapsed));
        self.refresh(cx);
    }

    /// Le « + » de la gouttière : un paragraphe en dessous, puis le menu
    /// slash — le geste exact du web.
    pub fn add_block_below(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.entries.get(ix) else { return };
        let sibling = entry.id.clone();
        let fresh = Uuid::now_v7().to_string();
        if self.doc.insert_paragraph_after(&sibling, &fresh).is_ok() {
            self.refresh(cx);
            self.focus_block(&fresh, 0, cx);
            self.content.push('/');
            self.selected_range = 1..1;
            self.sync_text(cx);
            self.slash = Some(SlashState { block_id: fresh, trigger: 0, selected: 0 });
            cx.notify();
        }
    }

    /// Ce que la poignée saisit : la sélection entière si le bloc en fait
    /// partie, sinon ce seul bloc.
    pub fn drag_targets(&self, id: &str) -> Vec<String> {
        let selected = self.selected_ids();
        if selected.iter().any(|selected| selected == id) {
            selected
        } else {
            vec![id.to_string()]
        }
    }

    pub fn set_drop_target(&mut self, id: &str, edge: DropEdge, dragged: &[String], cx: &mut Context<Self>) {
        if self.dragging.as_deref() != Some(dragged) {
            self.dragging = Some(dragged.to_vec());
        }
        let next = Some((id.to_string(), edge));
        if self.drop_target != next {
            self.drop_target = next;
            cx.notify();
        }
    }

    /// Valider le dépôt : appelé au relâchement de la souris.
    pub fn commit_drop(&mut self, cx: &mut Context<Self>) {
        let Some(dragged) = self.dragging.take() else { return };
        if let Some((target, edge)) = self.drop_target.take() {
            let _ = self.doc.drop_blocks(&dragged, &target, edge);
            self.refresh(cx);
        }
        cx.notify();
    }

    pub fn open_block_menu(&mut self, id: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.slash = None; // un seul menu à la fois
        // ouvrir le menu sélectionne le bloc : les actions portent dessus
        if !self.is_selected(id) {
            self.block_selection =
                Some(BlockSelection { anchor: id.to_string(), head: id.to_string() });
        }
        self.block_menu =
            Some(BlockMenu { block_id: id.to_string(), at, selected: 0 });
        cx.notify();
    }

    pub fn pick_block_menu(&mut self, cx: &mut Context<Self>) {
        let Some(menu) = self.block_menu.take() else { return };
        let Some(action) = rows::BLOCK_MENU.get(menu.selected) else { return };
        self.run_block_action(action.action, cx);
    }

    pub fn run_block_action(&mut self, action: rows::BlockAction, cx: &mut Context<Self>) {
        self.block_menu = None;
        let ids = self.selected_ids();
        let ids = if ids.is_empty() { vec![self.active_id.clone()] } else { ids };
        match action {
            rows::BlockAction::Delete => {
                let caret = self.doc.delete_blocks(&ids).ok().flatten();
                self.block_selection = None;
                self.refresh(cx);
                if let Some((id, offset)) = caret {
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
            rows::BlockAction::Duplicate => {
                let _ = self.doc.duplicate_blocks(&ids, || Uuid::now_v7().to_string());
                self.refresh(cx);
            }
            rows::BlockAction::MoveUp => {
                let _ = self.doc.move_blocks_vertical(&ids, true);
                self.keep_place(cx);
            }
            rows::BlockAction::MoveDown => {
                let _ = self.doc.move_blocks_vertical(&ids, false);
                self.keep_place(cx);
            }
            rows::BlockAction::TurnInto(kind) => {
                for id in &ids {
                    let _ = self.doc.turn_into(id, kind, &[]);
                }
                self.keep_place(cx);
            }
        }
        cx.notify();
    }

    /// Des fichiers déposés sur la fenêtre : chaque image devient un bloc
    /// image après le bloc actif, `src` en data-URL — la forme que le web
    /// écrit et lit sans magasin d'assets.
    fn drop_files(&mut self, paths: &[std::path::PathBuf], cx: &mut Context<Self>) {
        let mut after = self.active_id.clone();
        if after.is_empty() {
            return;
        }
        let mut inserted = false;
        for path in paths {
            if !crate::assets::is_image_file(path) {
                eprintln!("carnet: pas une image, ignoré : {}", path.display());
                continue;
            }
            let Some(url) = crate::assets::data_url_from_file(path) else { continue };
            let id = Uuid::now_v7().to_string();
            let caption =
                path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
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
            line_start += line.text.len() + 1; // le '\n' que shape_text a mangé
        }
        self.content.len()
    }

    /// La position (coordonnées fenêtre) d'un offset dans un bloc.
    pub fn position_of(&self, id: &str, offset: usize) -> Option<Point<Pixels>> {
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

    // --- défilement ---

    fn max_scroll(&self, fallback: Pixels) -> Pixels {
        let viewport = if self.viewport_height > px(0.) { self.viewport_height } else { fallback };
        (self.content_height - viewport).max(px(0.))
    }

    pub fn scroll_by(&mut self, delta: Pixels, viewport: Pixels, cx: &mut Context<Self>) {
        let next = (self.scroll_y - delta).max(px(0.)).min(self.max_scroll(viewport));
        if next != self.scroll_y {
            self.scroll_y = next;
            cx.notify();
        }
    }

    // --- le menu slash ---

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

    pub fn slash_filtered(&self) -> Vec<usize> {
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

    pub fn select_slash(&mut self, cx: &mut Context<Self>) {
        let filtered = self.slash_filtered();
        let Some(state) = self.slash.take() else { return };
        let Some(&picked) = filtered.get(state.selected) else { return };
        let item = &slash::ITEMS[picked];

        let caret = self.selected_range.start;
        self.content.replace_range(state.trigger..caret, "");
        self.selected_range = state.trigger..state.trigger;
        self.sync_text(cx);

        let id = self.active_id.clone();
        let kind = self.active_entry().map(|entry| entry.kind.clone()).unwrap_or_default();
        let convert_in_place = self.content.is_empty() && kind == "paragraph";
        let props: Vec<(&str, LoroValue)> =
            item.props.iter().map(|(key, prop)| (*key, prop.to_loro())).collect();

        // un bloc sans texte prend un paragraphe frais derrière lui, et c'est
        // lui qui reçoit le caret
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

    // --- autoformat ---

    fn autoformat(&mut self, cx: &mut Context<Self>) {
        let Some(entry) = self.active_entry() else { return };
        if entry.kind != "paragraph" {
            return;
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

pub fn editable(entry: &Entry) -> bool {
    entry.text.is_some() && model::is_inline(&entry.kind)
}

/// Reculer `offset` jusqu'à une frontière de caractère.
fn snap(text: &str, mut offset: usize) -> usize {
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// Une pression, un caractère perçu : les frontières sont des graphèmes, pour
/// qu'un emoji famille sorte entier au lieu de se défaire en débris.
fn previous_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .rev()
        .find_map(|(ix, _)| (ix < offset).then_some(ix))
        .unwrap_or(0)
}

fn next_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true).find_map(|(ix, _)| (ix > offset).then_some(ix)).unwrap_or(text.len())
}

/// Chaque point de code de `[from, to)` porte-t-il la marque ?
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
        // en mode bloc, une touche non listée ne fait rien — elle ne doit
        // surtout pas retomber en frappe et écraser la sélection
        if self.block_selection.is_some() {
            return;
        }
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
        if self.block_selection.is_some() {
            return;
        }
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
        let theme = theme(cx).clone();
        let rows: Vec<_> = self
            .entries
            .iter()
            .enumerate()
            .skip(1)
            .map(|(ix, entry)| rows::row(self, ix, entry, cx))
            .collect();

        let menu = slash::menu(self, cx);
        let block_menu = self.block_menu.as_ref().map(|menu| {
            let items: Vec<ui::MenuItem> = rows::BLOCK_MENU.iter().map(rows::menu_item).collect();
            ui::menu(
                "block-menu",
                &items,
                menu.selected,
                menu.at,
                |editor: &mut Editor, ix, _window, cx| match rows::BLOCK_MENU.get(ix) {
                    Some(action) => editor.run_block_action(action.action, cx),
                    // hors des entrées : c'est le fond, on referme
                    None => {
                        editor.block_menu = None;
                        cx.notify();
                    }
                },
                cx,
            )
        });

        div()
            .size_full()
            .relative()
            .bg(theme.bg)
            .key_context("Editor")
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .font_family(crate::theme::FONT_SANS)
            .text_size(px(16.) * theme.font_scale)
            .text_color(theme.text)
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
            .on_action(cx.listener(Self::duplicate))
            .on_action(cx.listener(Self::move_block_up))
            .on_action(cx.listener(Self::move_block_down))
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
                div().size_full().overflow_hidden().flex().justify_center().child(
                    div()
                        .w(theme.page_width + rows::GUTTER * 2.)
                        .py(px(56.))
                        .relative()
                        .top(-self.scroll_y)
                        .child(rows::title(self, cx))
                        .children(rows)
                        // mesure exacte de la fin du contenu : un élément de
                        // hauteur nulle en dernier, dont l'ordonnée *est* le
                        // bas du document
                        .child(rows::content_ruler(cx)),
                ),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .w(px(12.))
                    .child(Scrollbar { editor: cx.entity() }),
            )
            .children(menu)
            .children(block_menu)
    }
}

impl Focusable for Editor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
