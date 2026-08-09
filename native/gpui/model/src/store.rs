//! Le document, tel que Loro le tient — miroir de `packages/collab/src/store.ts`
//! et frère de `native/swift/Sources/NbeSync/DocumentWriter.swift`.
//!
//! Les deux règles gagnées de haute lutte côté TypeScript valent ici aussi :
//!
//! - **L'arbre possède la structure.** `children` et `parentId` sont dérivés de
//!   `LoroTree`, jamais stockés — le même fait à deux endroits finit par se
//!   contredire.
//! - **Le texte est un conteneur, pas une valeur.** Stocké en valeur, deux
//!   personnes qui tapent dans un paragraphe entrent en conflit sur le
//!   paragraphe entier, et une phrase disparaît.

use std::cell::RefCell;
use std::collections::HashMap;

use loro::{
    Container, ExpandType, ExportMode, LoroDoc, LoroMap, LoroResult, LoroText, LoroTree,
    LoroValue, StyleConfig, StyleConfigMap, TextDelta, TreeID, TreeParentId, UpdateOptions,
    ValueOrContainer,
};

use crate::model;

/// Un segment de texte et les marques qu'il porte — l'unité de rendu.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub text: String,
    pub marks: Vec<(String, LoroValue)>,
}

impl Run {
    pub fn has(&self, mark: &str) -> bool {
        self.marks.iter().any(|(kind, value)| {
            kind == mark && !matches!(value, LoroValue::Null | LoroValue::Bool(false))
        })
    }
}

/// Un bloc aplati, en ordre de lecture — ce qu'un rendu consomme.
/// Miroir de `DocumentOrder.Entry` côté Swift.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    /// La version de schéma du bloc. Recopiée telle quelle : §4 promet
    /// qu'une version inconnue survit à l'aller-retour au lieu d'être
    /// ramenée à 1 par un client plus ancien.
    pub version: i64,
    pub text: Option<String>,
    pub runs: Vec<Run>,
    /// Profondeur sous la racine ; les enfants de la page sont à 1.
    pub depth: usize,
    pub parent_id: Option<String>,
    /// Position parmi ses frères.
    pub index: usize,
    pub child_count: usize,
    pub props: HashMap<String, LoroValue>,
}

impl Entry {
    /// `heading` seulement, borné à 1..=3 — un niveau inconnu se lit comme le
    /// plus grand titre, pas comme aucun.
    pub fn heading_level(&self) -> i64 {
        match self.props.get("level") {
            Some(LoroValue::I64(level)) => (*level).clamp(1, 3),
            Some(LoroValue::Double(level)) => (*level as i64).clamp(1, 3),
            _ => 1,
        }
    }

    /// `to_do` seulement.
    pub fn is_checked(&self) -> bool {
        matches!(self.props.get("checked"), Some(LoroValue::Bool(true)))
    }

    /// `toggle` seulement : un dépliant replié cache sa descendance.
    pub fn is_collapsed(&self) -> bool {
        matches!(self.props.get("collapsed"), Some(LoroValue::Bool(true)))
    }
}

/// Éditer un document Carnet depuis Rust. Un **pair**, pas un visualiseur :
/// une édition faite ici fusionne dans le document de l'éditeur TypeScript
/// comme celle de n'importe quel client.
pub struct Document {
    pub doc: LoroDoc,
    tree: LoroTree,
    undo: loro::UndoManager,
    /// Nos ids de blocs vers ceux de l'arbre. Vérifié contre `tree.contains`
    /// avant usage, pour qu'un nœud supprimé par un pair ne revienne pas vivant.
    index: RefCell<HashMap<String, TreeID>>,
}

impl Document {
    pub fn new(snapshot: Option<&[u8]>) -> LoroResult<Self> {
        let doc = LoroDoc::new();
        // L'expansion des marques, depuis le registre unique que core déclare
        // (`packages/core/src/marks.ts`) : l'emphase s'étend en tapant après,
        // un lien, un code, une mention et un commentaire non.
        let mut styles = StyleConfigMap::new();
        for kind in ["bold", "italic", "underline", "strike", "color", "background"] {
            styles.insert(kind.into(), StyleConfig { expand: ExpandType::After });
        }
        for kind in ["code", "link", "mention", "comment"] {
            styles.insert(kind.into(), StyleConfig { expand: ExpandType::None });
        }
        doc.config_text_style(styles);
        if let Some(bytes) = snapshot {
            doc.import(bytes)?;
        }
        let tree = doc.get_tree("blocks");
        tree.enable_fractional_index(0);
        let undo = loro::UndoManager::new(&doc);
        Ok(Self { doc, tree, undo, index: RefCell::new(HashMap::new()) })
    }

    /// Annuler la dernière édition **locale** — celles des pairs restent.
    pub fn undo(&mut self) -> bool {
        self.undo.undo().unwrap_or(false)
    }

    pub fn redo(&mut self) -> bool {
        self.undo.redo().unwrap_or(false)
    }

    /// Le nœud d'arbre qui porte cet id de bloc, s'il existe.
    fn node(&self, id: &str) -> Option<TreeID> {
        if let Some(&cached) = self.index.borrow().get(id) {
            if self.tree.contains(cached) && !self.tree.is_node_deleted(&cached).unwrap_or(true) {
                return Some(cached);
            }
        }
        let mut found = None;
        for target in self.tree.nodes() {
            if let Some(node_id) = self.meta_string(target, "id") {
                self.index.borrow_mut().insert(node_id.clone(), target);
                if node_id == id {
                    found = Some(target);
                }
            }
        }
        found
    }

    fn meta(&self, target: TreeID) -> Option<LoroMap> {
        self.tree.get_meta(target).ok()
    }

    fn meta_string(&self, target: TreeID, key: &str) -> Option<String> {
        match self.meta(target)?.get(key)? {
            ValueOrContainer::Value(LoroValue::String(text)) => Some(text.to_string()),
            _ => None,
        }
    }

    fn text_of(&self, target: TreeID) -> Option<LoroText> {
        match self.meta(target)?.get("text")? {
            ValueOrContainer::Container(Container::Text(text)) => Some(text),
            _ => None,
        }
    }

    fn kind_of(&self, target: TreeID) -> String {
        self.meta_string(target, "type").unwrap_or_default()
    }

    fn version_of(&self, target: TreeID) -> i64 {
        match self.meta(target).and_then(|meta| meta.get("version")) {
            Some(ValueOrContainer::Value(LoroValue::I64(version))) => version,
            Some(ValueOrContainer::Value(LoroValue::Double(version))) => version as i64,
            _ => 1,
        }
    }

    /// L'arbre des blocs — `json.rs` et `blocks.rs` en ont besoin pour créer
    /// et déplacer des nœuds.
    pub(crate) fn tree(&self) -> &LoroTree {
        &self.tree
    }

    /// Vider le cache d'identifiants, après un import ou un ensemencement.
    pub(crate) fn reindex(&self) {
        self.index.borrow_mut().clear();
    }

    /// Le nœud d'arbre d'un bloc — visible dans le crate pour `blocks.rs`.
    pub(crate) fn node_of(&self, id: &str) -> Option<TreeID> {
        self.node(id)
    }

    /// Où se trouve un bloc : son parent, et sa position parmi ses frères.
    fn place(&self, target: TreeID) -> (TreeParentId, usize) {
        let parent = self.tree.parent(target).unwrap_or(TreeParentId::Root);
        let siblings = self.tree.children(parent.clone()).unwrap_or_default();
        let at = siblings.iter().position(|&sibling| sibling == target).unwrap_or(0);
        (parent, at)
    }

    /// Écrire `props` sur un nœud, en remplaçant la map entière — le
    /// changement de type d'un bloc *est* un nouveau jeu de props. Une
    /// **valeur**, pas un conteneur, comme `store.ts` l'écrit.
    fn write_props(&self, meta: &LoroMap, props: &[(&str, LoroValue)]) -> LoroResult<()> {
        let map: HashMap<String, LoroValue> =
            props.iter().map(|(key, value)| (key.to_string(), value.clone())).collect();
        meta.insert("props", LoroValue::from(map))
    }

    // --- lecture ---

    /// Tous les blocs, en profondeur d'abord — l'ordre dans lequel un lecteur
    /// les rencontre. `LoroTree::nodes()` a son propre ordre, qui n'est **pas**
    /// celui du document ; les deux implémentations s'y sont prises les pieds.
    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        for (index, root) in self.tree.roots().into_iter().enumerate() {
            self.walk(root, 0, None, index, &mut out);
        }
        out
    }

    fn walk(&self, target: TreeID, depth: usize, parent_id: Option<&str>, index: usize, out: &mut Vec<Entry>) {
        let Some(id) = self.meta_string(target, "id") else { return };
        let children = self.tree.children(target).unwrap_or_default();
        let text = self.text_of(target);
        let props = match self.meta(target).and_then(|meta| meta.get("props")) {
            Some(ValueOrContainer::Value(LoroValue::Map(map))) => {
                map.iter().map(|(key, value)| (key.to_string(), value.clone())).collect()
            }
            _ => HashMap::new(),
        };
        out.push(Entry {
            id: id.clone(),
            kind: self.kind_of(target),
            version: self.version_of(target),
            text: text.as_ref().map(|t| t.to_string()),
            runs: text.as_ref().map(runs_of).unwrap_or_default(),
            depth,
            parent_id: parent_id.map(str::to_string),
            index,
            child_count: children.len(),
            props,
        });
        for (position, child) in children.into_iter().enumerate() {
            self.walk(child, depth + 1, Some(&id), position, out);
        }
    }

    /// Le texte brut du document, un bloc par ligne — ce qu'un aperçu montre,
    /// et ce qui rend un écart entre implémentations lisible dans un test.
    pub fn plain_text(&self) -> String {
        self.entries().into_iter().filter_map(|entry| entry.text).collect::<Vec<_>>().join("\n")
    }

    // --- écriture : ce qu'une frappe veut dire ---
    //
    // Miroir de `packages/core/src/commands.ts` ; là où les deux pourraient
    // différer, le TypeScript est la spécification et ceci le portage.

    /// Démarrer un document avec un bloc page, comme l'éditeur le fait.
    pub fn create_page(&self, id: &str, title: &str) -> LoroResult<()> {
        let target = self.tree.create(TreeParentId::Root)?;
        let meta = self.tree.get_meta(target)?;
        meta.insert("id", id)?;
        meta.insert("type", "page")?;
        meta.insert("version", 1i64)?;
        self.write_props(&meta, &[("title", LoroValue::from(title))])?;
        self.doc.commit();
        Ok(())
    }

    /// Ajouter un paragraphe sous `parent_id`, à la fin.
    pub fn append_paragraph(&self, text: &str, parent_id: &str, id: &str) -> LoroResult<()> {
        let parent = self.node(parent_id).ok_or_else(|| missing(parent_id))?;
        let count = self.tree.children_num(parent).unwrap_or(0);
        let target = self.tree.create_at(parent, count)?;
        let meta = self.tree.get_meta(target)?;
        meta.insert("id", id)?;
        meta.insert("type", "paragraph")?;
        meta.insert("version", 1i64)?;
        let container = meta.insert_container("text", LoroText::new())?;
        if !text.is_empty() {
            container.insert(0, text)?;
        }
        self.index.borrow_mut().insert(id.to_string(), target);
        self.doc.commit();
        Ok(())
    }

    /// Remplacer le texte d'un bloc. **Diffé, pas réécrit** : `update` calcule
    /// l'édition minimale, pour que deux personnes tapant dans un paragraphe
    /// fusionnent au lieu de s'écraser.
    pub fn set_text(&self, id: &str, text: &str) -> LoroResult<()> {
        let target = self.node(id).ok_or_else(|| missing(id))?;
        let meta = self.tree.get_meta(target)?;
        let container = match meta.get("text") {
            Some(ValueOrContainer::Container(Container::Text(existing))) => existing,
            _ => meta.insert_container("text", LoroText::new())?,
        };
        container
            .update(text, UpdateOptions { timeout_ms: None, use_refined_diff: true })
            .map_err(|_| loro::LoroError::EditWhenDetached)?;
        self.doc.commit();
        Ok(())
    }

    /// Marquer `[from, to)` (offsets en points de code) — gras, italique…
    pub fn mark(&self, id: &str, from: usize, to: usize, mark: &str, add: bool) -> LoroResult<()> {
        let target = self.node(id).ok_or_else(|| missing(id))?;
        let Some(container) = self.text_of(target) else { return Ok(()) };
        if add {
            container.mark(from..to, mark, true)?;
        } else {
            container.unmark(from..to, mark)?;
        }
        self.doc.commit();
        Ok(())
    }

    /// Créer un bloc à côté de `sibling`, `offset` places après lui.
    fn create_besides(
        &self,
        id: &str,
        kind: &str,
        props: &[(&str, LoroValue)],
        sibling: TreeID,
        offset: usize,
    ) -> LoroResult<TreeID> {
        let (parent, at) = self.place(sibling);
        let target = self.tree.create_at(parent, at + offset)?;
        let meta = self.tree.get_meta(target)?;
        meta.insert("id", id)?;
        meta.insert("type", kind)?;
        meta.insert("version", 1i64)?;
        self.write_props(&meta, props)?;
        meta.insert_container("text", LoroText::new())?;
        self.index.borrow_mut().insert(id.to_string(), target);
        Ok(target)
    }

    /// **Entrée.** Scinder le bloc à `offset` (points de code), ou transformer
    /// un non-paragraphe vide en paragraphe.
    ///
    /// Retourne le bloc où va le caret, et où dedans.
    pub fn split_block(&self, id: &str, offset: usize, new_id: &str) -> LoroResult<(String, usize)> {
        let Some(target) = self.node(id) else { return Ok((id.to_string(), offset)) };
        let kind = self.kind_of(target);
        let Some(container) = self.text_of(target) else { return Ok((id.to_string(), offset)) };
        let whole = container.to_string();

        // une puce vide est la façon de *cesser* d'être une liste — le seul
        // Entrée qui ne crée rien
        if whole.is_empty() && kind != "paragraph" {
            self.turn_into(id, "paragraph", &[])?;
            return Ok((id.to_string(), 0));
        }

        let length = container.len_unicode();
        let cut = offset.min(length);
        let tail = tail_of(&container, cut);
        let continues = model::is_continuing(&kind);

        if cut < length {
            container.delete(cut, length - cut)?;
        }
        let props: &[(&str, LoroValue)] =
            if continues && kind == "to_do" { &[("checked", LoroValue::Bool(false))] } else { &[] };
        let created = self.create_besides(
            new_id,
            if continues { &kind } else { "paragraph" },
            props,
            target,
            1,
        )?;
        // la queue est ré-appliquée plutôt que retapée : une demi-phrase en
        // gras reste en gras quand on presse Entrée au milieu
        if let Some(into) = self.text_of(created) {
            apply_runs(&tail, &into, 0)?;
        }
        self.doc.commit();
        Ok((new_id.to_string(), 0))
    }

    /// **Retour arrière à l'offset 0.** Un non-paragraphe devient un
    /// paragraphe ; un paragraphe fusionne dans le bloc d'avant.
    ///
    /// Retourne où va le caret (en points de code), ou `None` quand il n'y a
    /// rien où fusionner.
    pub fn merge_backward(&self, id: &str) -> LoroResult<Option<(String, usize)>> {
        let Some(target) = self.node(id) else { return Ok(None) };
        if self.kind_of(target) != "paragraph" {
            self.turn_into(id, "paragraph", &[])?;
            return Ok(Some((id.to_string(), 0)));
        }

        let entries = self.entries();
        let Some(here) = entries.iter().position(|entry| entry.id == id) else { return Ok(None) };
        let Some(previous) = entries[..here].iter().rev().find(|entry| entry.text.is_some()) else {
            return Ok(None);
        };
        let Some(into) = self.node(&previous.id) else { return Ok(None) };
        let Some(container) = self.text_of(into) else { return Ok(None) };

        let landing = container.len_unicode();
        if let Some(source) = self.text_of(target) {
            // les marques voyagent avec le texte : une fusion qui collerait la
            // chaîne brute arracherait un lien de la phrase où il vit
            apply_runs(&tail_of(&source, 0), &container, landing)?;
        }
        // les enfants avant la suppression : les emporter supprimerait du
        // texte que personne n'a demandé de supprimer
        for child in self.tree.children(target).unwrap_or_default() {
            self.tree.mov_after(child, target)?;
        }
        self.index.borrow_mut().remove(id);
        self.tree.delete(target)?;
        self.doc.commit();
        Ok(Some((previous.id.clone(), landing)))
    }

    /// Insérer un bloc frais après `sibling_id` — ce que choisit le menu slash
    /// quand le bloc courant n'est pas convertible sur place.
    pub fn insert_block_after(
        &self,
        sibling_id: &str,
        new_id: &str,
        kind: &str,
        props: &[(&str, LoroValue)],
    ) -> LoroResult<()> {
        let target = self.node(sibling_id).ok_or_else(|| missing(sibling_id))?;
        self.create_besides(new_id, kind, props, target, 1)?;
        self.doc.commit();
        Ok(())
    }

    /// `---` : le bloc devient un séparateur, avec un paragraphe frais après
    /// lui — la seule règle d'autoformat qui n'est pas un préfixe.
    pub fn insert_paragraph_after(&self, sibling_id: &str, new_id: &str) -> LoroResult<()> {
        self.insert_block_after(sibling_id, new_id, "paragraph", &[])
    }

    /// **Le menu slash, et l'autoformat.** Changer ce qu'un bloc *est*.
    pub fn turn_into(&self, id: &str, kind: &str, props: &[(&str, LoroValue)]) -> LoroResult<()> {
        let Some(target) = self.node(id) else { return Ok(()) };
        let meta = self.tree.get_meta(target)?;
        meta.insert("type", kind)?;
        self.write_props(&meta, props)?;
        self.doc.commit();
        Ok(())
    }

    /// Poser une prop en gardant les autres — la case d'un to-do, un niveau.
    pub fn set_prop(&self, id: &str, key: &str, value: LoroValue) -> LoroResult<()> {
        let Some(target) = self.node(id) else { return Ok(()) };
        let meta = self.tree.get_meta(target)?;
        let mut props: Vec<(String, LoroValue)> = match meta.get("props") {
            Some(ValueOrContainer::Value(LoroValue::Map(map))) => {
                map.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
            }
            _ => Vec::new(),
        };
        props.retain(|(existing, _)| existing != key);
        props.push((key.to_string(), value));
        let borrowed: Vec<(&str, LoroValue)> =
            props.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        self.write_props(&meta, &borrowed)?;
        self.doc.commit();
        Ok(())
    }

    /// **Tab.** Devenir l'enfant du frère du dessus. Le premier enfant n'a
    /// rien sous quoi s'indenter, et refuser est la bonne réponse.
    pub fn indent(&self, id: &str) -> LoroResult<bool> {
        let Some(target) = self.node(id) else { return Ok(false) };
        let (parent, at) = self.place(target);
        if at == 0 {
            return Ok(false);
        }
        let siblings = self.tree.children(parent).unwrap_or_default();
        let above = siblings[at - 1];
        let adopted = self.tree.children_num(above).unwrap_or(0);
        self.tree.mov_to(target, above, adopted)?;
        self.doc.commit();
        Ok(true)
    }

    /// **Shift-Tab.** Sortir juste après le parent. La page est le niveau
    /// zéro : un bloc directement sous elle n'a nulle part plus haut.
    pub fn outdent(&self, id: &str) -> LoroResult<bool> {
        let Some(target) = self.node(id) else { return Ok(false) };
        let Some(TreeParentId::Node(parent)) = self.tree.parent(target) else { return Ok(false) };
        let Some(TreeParentId::Node(_)) = self.tree.parent(parent) else { return Ok(false) };
        self.tree.mov_after(target, parent)?;
        self.doc.commit();
        Ok(true)
    }

    /// Retirer un bloc en promouvant ses enfants plutôt qu'en les emportant.
    pub fn remove(&self, id: &str) -> LoroResult<()> {
        let Some(target) = self.node(id) else { return Ok(()) };
        for child in self.tree.children(target).unwrap_or_default() {
            self.tree.mov_after(child, target)?;
        }
        self.index.borrow_mut().remove(id);
        self.tree.delete(target)?;
        self.doc.commit();
        Ok(())
    }

    /// Les octets qu'un pair — ou un fichier — veut.
    pub fn snapshot(&self) -> LoroResult<Vec<u8>> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }
}

fn missing(id: &str) -> loro::LoroError {
    loro::LoroError::NotFoundError(format!("bloc introuvable : {id}").into())
}

/// Les morceaux d'un conteneur à partir de `from` (points de code), marques
/// comprises. Scinder en relisant la chaîne brute perdrait chaque marque de la
/// queue au premier Entrée dans une phrase formatée.
fn tail_of(container: &LoroText, from: usize) -> Vec<Run> {
    let mut out = Vec::new();
    let mut seen = 0usize;
    for piece in container.to_delta() {
        let TextDelta::Insert { insert, attributes } = piece else { continue };
        let width = insert.chars().count();
        let end = seen + width;
        if end > from {
            let start = from.saturating_sub(seen);
            let kept: String = insert.chars().skip(start).collect();
            if !kept.is_empty() {
                out.push(Run {
                    text: kept,
                    marks: attributes
                        .as_ref()
                        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default(),
                });
            }
        }
        seen = end;
    }
    out
}

fn apply_runs(runs: &[Run], container: &LoroText, start: usize) -> LoroResult<()> {
    let mut at = start;
    for run in runs {
        container.insert(at, &run.text)?;
        let width = run.text.chars().count();
        for (key, value) in &run.marks {
            container.mark(at..at + width, key, value.clone())?;
        }
        at += width;
    }
    Ok(())
}

/// Un conteneur relu comme runs, pour le rendu.
fn runs_of(container: &LoroText) -> Vec<Run> {
    let mut runs = Vec::new();
    for piece in container.to_delta() {
        let TextDelta::Insert { insert, attributes } = piece else { continue };
        runs.push(Run {
            text: insert,
            marks: attributes
                .map(|map| map.into_iter().collect())
                .unwrap_or_default(),
        });
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Document {
        let doc = Document::new(None).unwrap();
        doc.create_page("page", "Test").unwrap();
        doc
    }

    #[test]
    fn enter_splits_and_continues_lists() {
        let doc = page();
        doc.append_paragraph("une liste", "page", "b1").unwrap();
        doc.turn_into("b1", "bulleted_list_item", &[]).unwrap();
        let (new_id, offset) = doc.split_block("b1", 3, "b2").unwrap();
        assert_eq!((new_id.as_str(), offset), ("b2", 0));
        let entries = doc.entries();
        let b1 = entries.iter().find(|e| e.id == "b1").unwrap();
        let b2 = entries.iter().find(|e| e.id == "b2").unwrap();
        assert_eq!(b1.text.as_deref(), Some("une"));
        assert_eq!(b2.text.as_deref(), Some(" liste"));
        // Entrée continue la liste : une deuxième puce, pas un paragraphe
        assert_eq!(b2.kind, "bulleted_list_item");
    }

    #[test]
    fn enter_in_empty_list_item_turns_it_into_paragraph() {
        let doc = page();
        doc.append_paragraph("", "page", "b1").unwrap();
        doc.turn_into("b1", "to_do", &[]).unwrap();
        let (id, offset) = doc.split_block("b1", 0, "jamais-créé").unwrap();
        assert_eq!((id.as_str(), offset), ("b1", 0));
        assert_eq!(doc.entries().iter().find(|e| e.id == "b1").unwrap().kind, "paragraph");
    }

    #[test]
    fn backspace_converts_then_merges() {
        let doc = page();
        doc.append_paragraph("avant", "page", "b1").unwrap();
        doc.append_paragraph("après", "page", "b2").unwrap();
        doc.turn_into("b2", "quote", &[]).unwrap();

        // premier retour arrière : la citation redevient paragraphe
        assert_eq!(doc.merge_backward("b2").unwrap(), Some(("b2".to_string(), 0)));
        assert_eq!(doc.entries().iter().find(|e| e.id == "b2").unwrap().kind, "paragraph");

        // second : elle fusionne dans le bloc d'avant, caret à la couture
        assert_eq!(doc.merge_backward("b2").unwrap(), Some(("b1".to_string(), 5)));
        assert_eq!(doc.plain_text(), "avant\u{61}près".replace('\u{61}', "a"));
        assert!(doc.entries().iter().all(|e| e.id != "b2"));
    }

    #[test]
    fn split_keeps_marks_on_the_tail() {
        let doc = page();
        doc.append_paragraph("du texte en gras", "page", "b1").unwrap();
        doc.mark("b1", 9, 16, "bold", true).unwrap();
        doc.split_block("b1", 3, "b2").unwrap();
        let entries = doc.entries();
        let b2 = entries.iter().find(|e| e.id == "b2").unwrap();
        let bold: String =
            b2.runs.iter().filter(|run| run.has("bold")).map(|run| run.text.as_str()).collect();
        assert_eq!(bold, "en gras");
    }

    #[test]
    fn indent_outdent_roundtrip() {
        let doc = page();
        doc.append_paragraph("un", "page", "b1").unwrap();
        doc.append_paragraph("deux", "page", "b2").unwrap();
        assert!(doc.indent("b2").unwrap());
        let entries = doc.entries();
        let b2 = entries.iter().find(|e| e.id == "b2").unwrap();
        assert_eq!(b2.parent_id.as_deref(), Some("b1"));
        assert_eq!(b2.depth, 2);
        // le premier enfant de son parent n'a rien sous quoi s'indenter
        assert!(!doc.indent("b2").unwrap());
        assert!(doc.outdent("b2").unwrap());
        assert_eq!(doc.entries().iter().find(|e| e.id == "b2").unwrap().parent_id.as_deref(), Some("page"));
        // directement sous la page : nulle part plus haut
        assert!(!doc.outdent("b2").unwrap());
    }

    #[test]
    fn snapshot_roundtrips_through_bytes() {
        let doc = page();
        doc.append_paragraph("persisté", "page", "b1").unwrap();
        let bytes = doc.snapshot().unwrap();
        let reopened = Document::new(Some(&bytes)).unwrap();
        assert_eq!(reopened.plain_text(), "persisté");
        // et le document rouvert reste éditable
        reopened.split_block("b1", 4, "b2").unwrap();
        assert_eq!(reopened.plain_text(), "pers\nisté");
    }

    /// La fixture écrite par l'éditeur TypeScript s'ouvre ici, avec les mêmes
    /// blocs, le même arbre et le même texte — `PortabilityTests`, en Rust.
    #[test]
    fn reads_the_typescript_editors_snapshot() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../swift/Tests/NbeModelTests/document.loro"
        ))
        .expect("fixture partagée avec le port Swift");
        let doc = Document::new(Some(&bytes)).unwrap();
        let entries = doc.entries();
        assert_eq!(entries[0].kind, "page");
        let paragraph = entries.iter().find(|e| e.kind == "paragraph").expect("le paragraphe de la fixture");
        assert_eq!(paragraph.text.as_deref(), Some("écrit par TypeScript"));
        assert_eq!(paragraph.depth, 1);
        assert_eq!(paragraph.parent_id.as_deref(), Some(entries[0].id.as_str()));

        // et le pair Rust peut éditer ce document et le réexporter
        doc.split_block(&paragraph.id, 6, "depuis-rust").unwrap();
        let bytes = doc.snapshot().unwrap();
        let reopened = Document::new(Some(&bytes)).unwrap();
        assert_eq!(reopened.plain_text(), "écrit \npar TypeScript");
    }
}
