//! Le vault : un dossier ordinaire, lu et écrit comme les autres apps.
//!
//! ```text
//! <racine>/.nbe/<pageId>.json        ← la vérité, portable
//! <racine>/.nbe/rooms/<pageId>.loro  ← l'identité de fusion
//! ```
//!
//! Les deux sont écrits depuis le *même* document et à chaque sauvegarde :
//! le JSON seul ne suffit pas (deux pairs qui reconstruisent un `LoroDoc`
//! depuis le même JSON **ne convergent pas**, ils doublent chaque bloc), et
//! l'instantané seul n'est pas portable. Perdre un instantané se rattrape en
//! resemant depuis le JSON ; perdre le JSON, non.
//!
//! L'arbre des pages n'est stocké nulle part : il est *dérivé* des blocs
//! `sub_page`, comme `Workspace.reindex()` côté TypeScript.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use carnet_model::json::{BlockJson, new_page, page_title};
use carnet_model::store::Document;

/// Une page telle que la barre latérale la montre.
#[derive(Debug, Clone)]
pub struct PageRef {
    pub id: String,
    pub title: String,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

pub struct Vault {
    pub root: PathBuf,
    pages: HashMap<String, BlockJson>,
    nodes: HashMap<String, PageRef>,
    roots: Vec<String>,
}

/// Un identifiant qui deviendra un nom de fichier. La règle est copiée de
/// `safeName()` côté TypeScript, où elle est dupliquée exprès entre les deux
/// runtimes et vérifiée par un test : un `..` accepté ici écrirait hors du
/// vault.
fn safe(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

impl Vault {
    pub fn nbe_dir(root: &Path) -> PathBuf {
        root.join(".nbe")
    }

    pub fn rooms_dir(root: &Path) -> PathBuf {
        Self::nbe_dir(root).join("rooms")
    }

    /// Ouvrir un dossier — le créer au besoin. Un dossier vide est un vault
    /// vide, pas une erreur.
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(Self::rooms_dir(&root))?;
        let mut vault = Self { root, pages: HashMap::new(), nodes: HashMap::new(), roots: Vec::new() };
        vault.reload();
        Ok(vault)
    }

    /// Relire le dossier. Un JSON illisible est signalé et sauté : ce n'est
    /// pas une page absente, et l'écraser en silence amputerait le vault.
    pub fn reload(&mut self) {
        self.pages.clear();
        let Ok(entries) = std::fs::read_dir(Self::nbe_dir(&self.root)) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
            // `collections.json` porte les schémas de bases de données, pas
            // une page — le desktop l'affiche par erreur comme « Sans titre »
            if id == "collections" || !safe(id) {
                continue;
            }
            match std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str(&raw).ok())
            {
                Some(page) => {
                    self.pages.insert(id.to_string(), page);
                }
                None => eprintln!("carnet: page illisible, ignorée : {}", path.display()),
            }
        }
        self.reindex();
    }

    /// Reconstruire l'arbre depuis les blocs `sub_page`.
    ///
    /// Défenses reprises du web : le **premier** parent qui réclame une page
    /// l'obtient, une référence vers une page absente est ignorée, et une
    /// page qui n'atteint aucune racine (cycle) est remise à la racine.
    fn reindex(&mut self) {
        self.nodes = self
            .pages
            .iter()
            .map(|(id, page)| {
                (
                    id.clone(),
                    PageRef {
                        id: id.clone(),
                        title: page_title(page),
                        parent: None,
                        children: Vec::new(),
                    },
                )
            })
            .collect();

        let mut claimed: HashSet<String> = HashSet::new();
        let parents: Vec<(String, Vec<String>)> = self
            .pages
            .iter()
            .map(|(id, page)| (id.clone(), sub_pages(page)))
            .collect();
        for (parent_id, referenced) in parents {
            for child_id in referenced {
                if child_id == parent_id
                    || claimed.contains(&child_id)
                    || !self.nodes.contains_key(&child_id)
                {
                    continue;
                }
                claimed.insert(child_id.clone());
                if let Some(child) = self.nodes.get_mut(&child_id) {
                    child.parent = Some(parent_id.clone());
                }
                if let Some(parent) = self.nodes.get_mut(&parent_id) {
                    parent.children.push(child_id);
                }
            }
        }

        // une page dont la chaîne de parents ne remonte à rien est orpheline
        // d'un cycle : elle redevient une racine plutôt que de disparaître
        let orphans: Vec<String> = self
            .nodes
            .keys()
            .filter(|id| !self.reaches_root(id))
            .cloned()
            .collect();
        for id in orphans {
            if let Some(node) = self.nodes.get_mut(&id) {
                node.parent = None;
            }
        }

        self.roots = {
            let mut roots: Vec<String> = self
                .nodes
                .values()
                .filter(|node| node.parent.is_none())
                .map(|node| node.id.clone())
                .collect();
            roots.sort(); // par id, donc par ordre de création (UUIDv7)
            roots
        };
    }

    fn reaches_root(&self, id: &str) -> bool {
        let mut current = id.to_string();
        for _ in 0..100 {
            match self.nodes.get(&current).and_then(|node| node.parent.clone()) {
                Some(parent) => current = parent,
                None => return true,
            }
        }
        false
    }

    pub fn roots(&self) -> &[String] {
        &self.roots
    }

    pub fn page(&self, id: &str) -> Option<&PageRef> {
        self.nodes.get(id)
    }

    pub fn title(&self, id: &str) -> String {
        self.nodes.get(id).map(|node| node.title.clone()).unwrap_or_else(|| "Sans titre".into())
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    /// Toutes les pages, à plat, dans l'ordre où la barre latérale les
    /// montre — profondeur d'abord depuis les racines.
    pub fn flattened(&self) -> Vec<(String, usize)> {
        let mut out = Vec::new();
        for root in &self.roots {
            self.walk(root, 0, &mut out);
        }
        out
    }

    fn walk(&self, id: &str, depth: usize, out: &mut Vec<(String, usize)>) {
        if depth > 20 {
            return;
        }
        out.push((id.to_string(), depth));
        if let Some(node) = self.nodes.get(id) {
            for child in &node.children {
                self.walk(child, depth + 1, out);
            }
        }
    }

    fn json_path(&self, id: &str) -> PathBuf {
        Self::nbe_dir(&self.root).join(format!("{id}.json"))
    }

    fn loro_path(&self, id: &str) -> PathBuf {
        Self::rooms_dir(&self.root).join(format!("{id}.loro"))
    }

    /// Ouvrir une page pour l'édition.
    ///
    /// L'instantané est la source d'édition ; s'il manque, on resème depuis
    /// le JSON — le seul cas où c'est légitime, parce qu'il n'y a pas encore
    /// de réplique avec qui converger.
    pub fn load(&self, id: &str) -> Option<Document> {
        if !safe(id) {
            return None;
        }
        if let Ok(bytes) = std::fs::read(self.loro_path(id)) {
            if let Ok(document) = Document::new(Some(&bytes)) {
                return Some(document);
            }
            eprintln!("carnet: instantané illisible, on repart du JSON : {id}");
        }
        let page = self.pages.get(id)?;
        let document = Document::new(None).ok()?;
        document.seed_from_json(page).ok()?;
        Some(document)
    }

    /// Écrire les deux fichiers, depuis le même document.
    ///
    /// Écriture atomique : fichier temporaire puis `rename`, sinon une
    /// coupure de courant au mauvais moment laisse un JSON tronqué à la
    /// place d'une page.
    pub fn save(&mut self, id: &str, document: &Document) -> std::io::Result<()> {
        if !safe(id) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "identifiant"));
        }
        if let Some(page) = document.to_json() {
            let json = serde_json::to_string_pretty(&page)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            write_atomic(&self.json_path(id), format!("{json}\n").as_bytes())?;
            self.pages.insert(id.to_string(), page);
            self.reindex();
        }
        if let Ok(snapshot) = document.snapshot() {
            write_atomic(&self.loro_path(id), &snapshot)?;
        }
        Ok(())
    }

    /// Créer une page — l'enfant d'abord, la référence chez le parent
    /// ensuite. Dans cet ordre, une coupure entre les deux laisse une page
    /// non référencée, que la prochaine lecture montre comme racine : rien
    /// n'est perdu. L'ordre inverse laisserait un parent qui pointe vers
    /// une page inexistante.
    pub fn create_page(
        &mut self,
        title: &str,
        parent: Option<&str>,
        mut new_id: impl FnMut() -> String,
    ) -> std::io::Result<String> {
        let id = new_id();
        let page = new_page(id.clone(), new_id(), new_id(), title);
        let json = serde_json::to_string_pretty(&page)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        write_atomic(&self.json_path(&id), format!("{json}\n").as_bytes())?;
        self.pages.insert(id.clone(), page);

        if let Some(parent_id) = parent {
            if let Some(parent_page) = self.pages.get(parent_id).cloned() {
                let mut updated = parent_page;
                let mut props = serde_json::Map::new();
                props.insert("pageId".into(), serde_json::Value::String(id.clone()));
                props.insert("title".into(), serde_json::Value::String(title.to_string()));
                updated.children.get_or_insert_with(Vec::new).push(BlockJson {
                    id: new_id(),
                    kind: "sub_page".into(),
                    version: 1,
                    props: Some(props),
                    text: None,
                    children: None,
                });
                let json = serde_json::to_string_pretty(&updated).unwrap_or_default();
                write_atomic(&self.json_path(parent_id), format!("{json}\n").as_bytes())?;
                self.pages.insert(parent_id.to_string(), updated);
                // l'instantané du parent devient périmé : il sera réécrit à
                // sa prochaine sauvegarde, et le JSON reste la vérité
            }
        }
        self.reindex();
        Ok(id)
    }

    /// Supprimer une page et sa descendance — les deux fichiers, du plus
    /// profond vers la racine. Le desktop oublie le `.loro` et laisse un
    /// orphelin par page supprimée ; on ne reproduit pas ça.
    pub fn delete_page(&mut self, id: &str) -> std::io::Result<()> {
        let mut doomed = Vec::new();
        self.walk(id, 0, &mut doomed);
        for (page_id, _) in doomed.into_iter().rev() {
            let _ = std::fs::remove_file(self.json_path(&page_id));
            let _ = std::fs::remove_file(self.loro_path(&page_id));
            self.pages.remove(&page_id);
        }
        // retirer la référence chez le parent, sinon il pointe dans le vide
        if let Some(parent_id) = self.nodes.get(id).and_then(|node| node.parent.clone()) {
            if let Some(mut parent) = self.pages.get(&parent_id).cloned() {
                strip_ref(&mut parent, id);
                let json = serde_json::to_string_pretty(&parent).unwrap_or_default();
                write_atomic(&self.json_path(&parent_id), format!("{json}\n").as_bytes())?;
                self.pages.insert(parent_id, parent);
            }
        }
        self.reindex();
        Ok(())
    }
}

/// Les pages qu'un document réclame comme siennes.
fn sub_pages(page: &BlockJson) -> Vec<String> {
    let mut out = Vec::new();
    collect_sub_pages(page, &mut out);
    out
}

fn collect_sub_pages(block: &BlockJson, out: &mut Vec<String>) {
    if block.kind == "sub_page" {
        if let Some(id) = block.props.as_ref().and_then(|props| props.get("pageId")).and_then(|v| v.as_str())
        {
            out.push(id.to_string());
        }
    }
    for child in block.children.iter().flatten() {
        collect_sub_pages(child, out);
    }
}

fn strip_ref(block: &mut BlockJson, child_id: &str) {
    if let Some(children) = block.children.as_mut() {
        children.retain(|child| {
            !(child.kind == "sub_page"
                && child
                    .props
                    .as_ref()
                    .and_then(|props| props.get("pageId"))
                    .and_then(|value| value.as_str())
                    == Some(child_id))
        });
        for child in children.iter_mut() {
            strip_ref(child, child_id);
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // le temporaire porte le pid : deux processus qui écrivent le même vault
    // ne doivent pas se marcher sur le fichier intermédiaire
    let temp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("carnet-vault-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn ids(prefix: &str) -> impl FnMut() -> String {
        let prefix = prefix.to_string();
        let mut counter = 0;
        move || {
            counter += 1;
            format!("{prefix}{counter}")
        }
    }

    #[test]
    fn creates_lists_and_reopens() {
        let root = scratch("basique");
        let mut vault = Vault::open(root.clone()).unwrap();
        assert!(vault.is_empty());

        let id = vault.create_page("Projets", None, ids("p")).unwrap();
        assert_eq!(vault.roots(), [id.clone()]);
        assert_eq!(vault.title(&id), "Projets");

        // le fichier est bien là, et un second ouvreur le retrouve
        assert!(Vault::nbe_dir(&root).join(format!("{id}.json")).exists());
        let reopened = Vault::open(root.clone()).unwrap();
        assert_eq!(reopened.roots(), [id.clone()]);
        assert_eq!(reopened.title(&id), "Projets");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sub_page_becomes_a_child() {
        let root = scratch("arbre");
        let mut vault = Vault::open(root.clone()).unwrap();
        let parent = vault.create_page("Parent", None, ids("a")).unwrap();
        let child = vault.create_page("Enfant", Some(&parent), ids("b")).unwrap();

        let reopened = Vault::open(root.clone()).unwrap();
        assert_eq!(reopened.roots(), [parent.clone()], "l'enfant n'est pas une racine");
        assert_eq!(reopened.page(&child).unwrap().parent.as_deref(), Some(parent.as_str()));
        assert_eq!(reopened.flattened(), vec![(parent, 0), (child, 1)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn editing_writes_both_files_and_the_title_follows_the_heading() {
        let root = scratch("ecriture");
        let mut vault = Vault::open(root.clone()).unwrap();
        let id = vault.create_page("Brouillon", None, ids("c")).unwrap();

        let document = vault.load(&id).expect("la page s'ouvre");
        // retitrer en éditant le H1, comme sur le web
        let heading = document.entries()[1].id.clone();
        document.set_text(&heading, "Titre réel").unwrap();
        vault.save(&id, &document).unwrap();

        assert!(Vault::rooms_dir(&root).join(format!("{id}.loro")).exists());
        let reopened = Vault::open(root.clone()).unwrap();
        assert_eq!(reopened.title(&id), "Titre réel");
        // et le document rouvre par l'instantané, avec le même texte
        assert!(reopened.load(&id).unwrap().plain_text().contains("Titre réel"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_snapshot_is_reseeded_from_the_json() {
        let root = scratch("reseme");
        let mut vault = Vault::open(root.clone()).unwrap();
        let id = vault.create_page("Semée", None, ids("d")).unwrap();
        assert!(!Vault::rooms_dir(&root).join(format!("{id}.loro")).exists());
        let document = vault.load(&id).expect("resemée depuis le JSON");
        assert!(document.plain_text().contains("Semée"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_takes_the_subtree_and_the_snapshots() {
        let root = scratch("suppression");
        let mut vault = Vault::open(root.clone()).unwrap();
        let parent = vault.create_page("Parent", None, ids("e")).unwrap();
        let child = vault.create_page("Enfant", Some(&parent), ids("f")).unwrap();
        let document = vault.load(&child).unwrap();
        vault.save(&child, &document).unwrap();

        vault.delete_page(&parent).unwrap();
        assert!(vault.is_empty());
        assert!(!Vault::rooms_dir(&root).join(format!("{child}.loro")).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_traversal_id_never_becomes_a_path() {
        let root = scratch("evasion");
        let vault = Vault::open(root.clone()).unwrap();
        assert!(vault.load("../../etc/passwd").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `collections.json` n'est pas une page — le desktop l'affiche comme
    /// une racine « Sans titre » dès qu'une base existe.
    #[test]
    fn collections_json_is_not_a_page() {
        let root = scratch("collections");
        let vault = Vault::open(root.clone()).unwrap();
        std::fs::write(Vault::nbe_dir(&root).join("collections.json"), "[]").unwrap();
        let mut vault = vault;
        vault.reload();
        assert!(vault.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
