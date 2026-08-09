//! Les commandes qui agissent sur des **blocs** plutôt que sur du texte —
//! miroir de la seconde moitié de `packages/core/src/commands.ts`.
//!
//! Toutes prennent une liste d'ids **déjà normalisée** par
//! [`Document::selected_blocks`] : un bloc sélectionné implique tout son
//! sous-arbre, donc lister aussi ses descendants les supprimerait ou les
//! dupliquerait deux fois.

use loro::{LoroResult, LoroValue, TreeID, TreeParentId};

use crate::model;
use crate::store::{Document, Entry};

/// Où déposer, relativement à un bloc cible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropEdge {
    Before,
    After,
}

impl Document {
    /// Les blocs dans l'ordre où un lecteur les rencontre, **sans** ce que
    /// cache un bloc replié.
    ///
    /// `props.collapsed == true` masque tout le sous-arbre, quel que soit le
    /// type du bloc — ce n'est pas réservé au `toggle` (`visibleBlocks`).
    pub fn visible_entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let mut hidden_under: Option<usize> = None;
        for entry in self.entries() {
            if let Some(depth) = hidden_under {
                if entry.depth > depth {
                    continue;
                }
                hidden_under = None;
            }
            if entry.is_collapsed() {
                hidden_under = Some(entry.depth);
            }
            out.push(entry);
        }
        out
    }

    /// D'une sélection ancre→tête à la liste des blocs de plus haut niveau.
    ///
    /// Trois règles, toutes tenues par `selectedBlocks` côté TypeScript :
    /// l'ancre et la tête ne sont pas orientées (on prend min et max) ; un
    /// point hors des blocs visibles rend une liste vide ; et un bloc dont un
    /// **ancêtre est dans la tranche** est retiré, parce qu'il part déjà avec
    /// lui.
    pub fn selected_blocks(&self, anchor: &str, head: &str) -> Vec<String> {
        let order: Vec<Entry> = self.visible_entries();
        let ids: Vec<&str> = order.iter().map(|entry| entry.id.as_str()).collect();
        let (Some(a), Some(h)) = (
            ids.iter().position(|id| *id == anchor),
            ids.iter().position(|id| *id == head),
        ) else {
            return Vec::new();
        };
        let (from, to) = if a <= h { (a, h) } else { (h, a) };
        let slice = &order[from..=to];
        let inside: std::collections::HashSet<&str> =
            slice.iter().map(|entry| entry.id.as_str()).collect();
        slice
            .iter()
            .filter(|entry| {
                !self.ancestors(&entry.id).iter().any(|parent| inside.contains(parent.as_str()))
            })
            .map(|entry| entry.id.clone())
            .collect()
    }

    /// Les ids des ancêtres d'un bloc, du plus proche à la racine.
    pub fn ancestors(&self, id: &str) -> Vec<String> {
        let Some(target) = self.node_of(id) else { return Vec::new() };
        let mut out = Vec::new();
        let mut walking = self.tree().parent(target);
        // borne défensive : un arbre cyclique ne doit pas boucler à l'infini
        for _ in 0..200 {
            match walking {
                Some(TreeParentId::Node(parent)) => {
                    if let Some(parent_id) = self.id_of(parent) {
                        out.push(parent_id);
                    }
                    walking = self.tree().parent(parent);
                }
                _ => break,
            }
        }
        out
    }

    fn id_of(&self, target: TreeID) -> Option<String> {
        let meta = self.tree().get_meta(target).ok()?;
        match meta.get("id")? {
            loro::ValueOrContainer::Value(LoroValue::String(id)) => Some(id.to_string()),
            _ => None,
        }
    }

    /// Supprimer des blocs, sous-arbres compris.
    ///
    /// Retourne où poser le caret ensuite, calculé **avant** toute mutation :
    /// la fin du bloc de texte précédent, sinon le début du suivant, sinon
    /// rien — un séparateur ne peut pas recevoir le caret, donc il n'est
    /// jamais candidat.
    pub fn delete_blocks(&self, ids: &[String]) -> LoroResult<Option<(String, usize)>> {
        if ids.is_empty() {
            return Ok(None);
        }
        let order = self.visible_entries();
        let doomed: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let is_candidate = |entry: &Entry| {
            model::is_inline(&entry.kind)
                && !doomed.contains(entry.id.as_str())
                && !self.ancestors(&entry.id).iter().any(|parent| doomed.contains(parent.as_str()))
        };
        let here = order.iter().position(|entry| entry.id == ids[0]);
        let target = match here {
            Some(here) => {
                let previous =
                    order[..here].iter().rev().find(|entry| is_candidate(entry)).map(|entry| {
                        (entry.id.clone(), entry.text.as_deref().unwrap_or("").chars().count())
                    });
                previous.or_else(|| {
                    order[here + 1..]
                        .iter()
                        .find(|entry| is_candidate(entry))
                        .map(|entry| (entry.id.clone(), 0))
                })
            }
            // le bloc n'était pas visible (replié) : le premier texte fera l'affaire
            None => order.iter().find(|entry| is_candidate(entry)).map(|entry| (entry.id.clone(), 0)),
        };

        for id in ids {
            if let Some(node) = self.node_of(id) {
                // Loro masque toute la descendance d'un nœud supprimé : pas
                // besoin de descendre, contrairement au TypeScript dont le
                // `delete_block` exige une feuille
                self.tree().delete(node)?;
                self.forget(id);
            }
        }
        self.doc.commit();
        Ok(target)
    }

    /// Dupliquer des blocs, sous-arbres compris.
    ///
    /// Les copies se posent **après le dernier bloc sélectionné**, dans
    /// l'ordre, et deviennent ses frères — même si les sources avaient des
    /// parents différents. `new_id` fournit les identifiants : le modèle
    /// n'embarque pas de générateur, comme le `newId` du port Swift.
    pub fn duplicate_blocks(
        &self,
        ids: &[String],
        mut new_id: impl FnMut() -> String,
    ) -> LoroResult<Vec<String>> {
        let Some(last) = ids.last() else { return Ok(Vec::new()) };
        let Some(last_node) = self.node_of(last) else { return Ok(Vec::new()) };
        let (parent, mut at) = self.place_of(last_node);

        let mut created = Vec::new();
        for id in ids {
            let Some(source) = self.node_of(id) else { continue };
            at += 1;
            let root = self.clone_subtree(source, parent.clone(), at, &mut new_id)?;
            created.push(root);
        }
        self.doc.commit();
        Ok(created)
    }

    fn clone_subtree(
        &self,
        source: TreeID,
        parent: TreeParentId,
        index: usize,
        new_id: &mut impl FnMut() -> String,
    ) -> LoroResult<String> {
        let id = new_id();
        let copy = self.copy_node(source, parent, index, &id)?;
        for (position, child) in
            self.tree().children(source).unwrap_or_default().into_iter().enumerate()
        {
            self.clone_subtree(child, TreeParentId::Node(copy), position, new_id)?;
        }
        Ok(id)
    }

    /// Monter ou descendre un groupe de frères d'un cran.
    ///
    /// Retourne `false` quand rien ne peut bouger — tous les blocs n'ont pas
    /// le même parent, ou le groupe touche déjà le bord. Comme le web, c'est
    /// la **plage contiguë** qui se déplace : une sélection à trous emporte
    /// ce qui la sépare.
    pub fn move_blocks_vertical(&self, ids: &[String], up: bool) -> LoroResult<bool> {
        let Some(first) = ids.first().and_then(|id| self.node_of(id)) else { return Ok(false) };
        let (parent, _) = self.place_of(first);
        let siblings = self.tree().children(parent.clone()).unwrap_or_default();
        let mut positions = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(node) = self.node_of(id) else { return Ok(false) };
            let Some(at) = siblings.iter().position(|sibling| *sibling == node) else {
                return Ok(false); // pas le même parent : le web refuse aussi
            };
            positions.push(at);
        }
        positions.sort_unstable();
        let (lo, hi) = (positions[0], positions[positions.len() - 1]);
        if up && lo == 0 {
            return Ok(false);
        }
        if !up && hi + 1 >= siblings.len() {
            return Ok(false);
        }

        let group: Vec<TreeID> = siblings[lo..=hi].to_vec();
        let mut after: Option<TreeID> =
            if up { (lo >= 2).then(|| siblings[lo - 2]) } else { Some(siblings[hi + 1]) };
        for node in group {
            match after {
                Some(anchor) => self.tree().mov_after(node, anchor)?,
                None => self.tree().mov_to(node, parent.clone(), 0)?,
            }
            after = Some(node);
        }
        self.doc.commit();
        Ok(true)
    }

    /// Déposer des blocs sur le bord d'un autre — la primitive du drag & drop.
    ///
    /// Le dépôt vise toujours **le parent de la cible**, jamais la cible :
    /// on ne devient pas l'enfant d'un bloc en le survolant, l'imbrication
    /// passe par Tab.
    pub fn drop_blocks(&self, ids: &[String], target_id: &str, edge: DropEdge) -> LoroResult<()> {
        let Some(target) = self.node_of(target_id) else { return Ok(()) };
        if ids.iter().any(|id| id == target_id) {
            return Ok(());
        }
        // déplacer un bloc dans son propre sous-arbre le détacherait du
        // document : Loro refuse, alors on demande d'abord
        let target_ancestors = self.ancestors(target_id);
        if ids.iter().any(|id| target_ancestors.contains(id)) {
            return Ok(());
        }

        let (parent, at) = self.place_of(target);
        let siblings = self.tree().children(parent.clone()).unwrap_or_default();
        let dragged: Vec<TreeID> = ids.iter().filter_map(|id| self.node_of(id)).collect();

        // l'ancre : le frère précédent pour un dépôt « avant », la cible pour
        // un dépôt « après » — en remontant tant que l'ancre est elle-même
        // déplacée, sinon on s'ancrerait à un bloc qui vient de bouger
        let mut anchor: Option<TreeID> = match edge {
            DropEdge::Before => (at > 0).then(|| siblings[at - 1]),
            DropEdge::After => Some(target),
        };
        while let Some(candidate) = anchor {
            if !dragged.contains(&candidate) {
                break;
            }
            let position = siblings.iter().position(|sibling| *sibling == candidate).unwrap_or(0);
            anchor = (position > 0).then(|| siblings[position - 1]);
        }

        for node in dragged {
            match anchor {
                Some(after) => self.tree().mov_after(node, after)?,
                None => self.tree().mov_to(node, parent.clone(), 0)?,
            }
            anchor = Some(node);
        }
        self.doc.commit();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Document {
        let doc = Document::new(None).unwrap();
        doc.create_page("page", "Test").unwrap();
        for id in ["a", "b", "c"] {
            doc.append_paragraph(id, "page", id).unwrap();
        }
        doc
    }

    fn ids(doc: &Document) -> Vec<String> {
        doc.entries().into_iter().skip(1).map(|entry| entry.id).collect()
    }

    #[test]
    fn a_selected_parent_absorbs_its_children() {
        let doc = seeded();
        doc.append_paragraph("a1", "page", "a1").unwrap();
        doc.drop_blocks(&["a1".into()], "a", DropEdge::After).unwrap();
        doc.indent("a1").unwrap();
        // la tranche a..b contient a1, qui est retiré : il part déjà avec `a`
        assert_eq!(doc.selected_blocks("a", "b"), vec!["a".to_string(), "b".to_string()]);
        // mais une tranche qui commence à l'enfant garde l'enfant
        assert_eq!(doc.selected_blocks("a1", "b"), vec!["a1".to_string(), "b".to_string()]);
    }

    #[test]
    fn an_invisible_endpoint_selects_nothing() {
        let doc = seeded();
        assert!(doc.selected_blocks("a", "jamais-vu").is_empty());
    }

    #[test]
    fn a_collapsed_block_hides_its_subtree() {
        let doc = seeded();
        doc.append_paragraph("b1", "page", "b1").unwrap();
        doc.drop_blocks(&["b1".into()], "b", DropEdge::After).unwrap();
        doc.indent("b1").unwrap();
        assert!(doc.visible_entries().iter().any(|entry| entry.id == "b1"));
        doc.set_prop("b", "collapsed", LoroValue::Bool(true)).unwrap();
        assert!(!doc.visible_entries().iter().any(|entry| entry.id == "b1"));
        // le bloc replié lui-même reste visible
        assert!(doc.visible_entries().iter().any(|entry| entry.id == "b"));
    }

    #[test]
    fn deleting_takes_the_subtree_and_lands_the_caret_before() {
        let doc = seeded();
        doc.append_paragraph("b1", "page", "b1").unwrap();
        doc.drop_blocks(&["b1".into()], "b", DropEdge::After).unwrap();
        doc.indent("b1").unwrap();
        let caret = doc.delete_blocks(&["b".into()]).unwrap();
        assert_eq!(caret, Some(("a".to_string(), 1))); // fin de « a »
        let remaining = ids(&doc);
        assert!(!remaining.contains(&"b".to_string()));
        assert!(!remaining.contains(&"b1".to_string()), "le sous-arbre part avec");
    }

    #[test]
    fn deleting_the_first_block_lands_the_caret_on_the_next() {
        let doc = seeded();
        assert_eq!(doc.delete_blocks(&["a".into()]).unwrap(), Some(("b".to_string(), 0)));
    }

    #[test]
    fn duplicating_copies_the_subtree_after_the_last_selected() {
        let doc = seeded();
        doc.append_paragraph("a1", "page", "a1").unwrap();
        doc.drop_blocks(&["a1".into()], "a", DropEdge::After).unwrap();
        doc.indent("a1").unwrap();

        let mut counter = 0;
        let created = doc
            .duplicate_blocks(&["a".into()], || {
                counter += 1;
                format!("copie-{counter}")
            })
            .unwrap();
        assert_eq!(created, vec!["copie-1".to_string()]);
        let entries = doc.entries();
        let copy = entries.iter().find(|entry| entry.id == "copie-1").unwrap();
        assert_eq!(copy.text.as_deref(), Some("a"));
        assert_eq!(copy.child_count, 1, "la copie emporte le sous-arbre");
        // posée juste après la source, pas à la fin du document
        let order = ids(&doc);
        let source = order.iter().position(|id| id == "a").unwrap();
        assert_eq!(order[source + 2], "copie-1"); // a, a1, copie-1
    }

    #[test]
    fn moving_up_and_down_is_a_round_trip() {
        let doc = seeded();
        assert!(doc.move_blocks_vertical(&["b".into()], true).unwrap());
        assert_eq!(ids(&doc), ["b", "a", "c"]);
        // déjà en tête : la commande refuse, comme `moveBlocksVertical` côté web
        assert!(!doc.move_blocks_vertical(&["b".into()], true).unwrap());
        assert_eq!(ids(&doc), ["b", "a", "c"]);
        assert!(doc.move_blocks_vertical(&["b".into()], false).unwrap());
        assert_eq!(ids(&doc), ["a", "b", "c"]);
        assert!(!doc.move_blocks_vertical(&["c".into()], false).unwrap());
    }

    #[test]
    fn a_group_keeps_its_internal_order() {
        let doc = seeded();
        assert!(doc.move_blocks_vertical(&["b".into(), "c".into()], true).unwrap());
        assert_eq!(ids(&doc), ["b", "c", "a"]);
    }

    #[test]
    fn dropping_before_and_after_a_target() {
        let doc = seeded();
        doc.drop_blocks(&["c".into()], "a", DropEdge::Before).unwrap();
        assert_eq!(ids(&doc), ["c", "a", "b"]);
        doc.drop_blocks(&["c".into()], "b", DropEdge::After).unwrap();
        assert_eq!(ids(&doc), ["a", "b", "c"]);
    }

    #[test]
    fn dropping_a_block_into_its_own_subtree_is_refused() {
        let doc = seeded();
        doc.indent("b").unwrap(); // b devient enfant de a
        doc.drop_blocks(&["a".into()], "b", DropEdge::After).unwrap();
        // rien n'a bougé : a est toujours le parent de b
        let entries = doc.entries();
        let b = entries.iter().find(|entry| entry.id == "b").unwrap();
        assert_eq!(b.parent_id.as_deref(), Some("a"));
    }

    #[test]
    fn dropping_a_group_keeps_its_order() {
        let doc = seeded();
        doc.drop_blocks(&["a".into(), "b".into()], "c", DropEdge::After).unwrap();
        assert_eq!(ids(&doc), ["c", "a", "b"]);
    }
}
