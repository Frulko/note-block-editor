//! Le pont entre le JSON canonique d'un vault et le CRDT.
//!
//! Un vault Carnet garde **deux** copies du même document : `.nbe/<id>.json`
//! (le format portable, la vérité) et `.nbe/rooms/<id>.loro` (l'identité de
//! fusion, que le JSON ne sait pas écrire). Les deux sont écrits depuis le
//! même document, et l'instantané manquant se resème depuis le JSON — jamais
//! l'inverse : *perdre un instantané se rattrape, perdre le JSON non*
//! (`apps/desktop/src/storage.ts`).
//!
//! §4 promet qu'un type ou une prop inconnus font l'aller-retour intacts :
//! `props` est donc un `serde_json::Value` et pas une structure typée, et
//! `version` est recopiée telle quelle plutôt que remise à 1.

use loro::{Container, LoroResult, LoroText, LoroValue, TreeID, TreeParentId, ValueOrContainer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::store::{Document, Run};

/// Un bloc tel que le JSON le porte — l'arbre est imbriqué, à la différence
/// du modèle plat que le CRDT tient.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockJson {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<Vec<RunJson>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BlockJson>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunJson {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<MarkJson>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarkJson {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Map<String, Value>>,
}

/// Le titre affiché d'une page : le premier texte non vide, tronqué à 80 —
/// donc on retitre en éditant son H1, exactement comme `pageTitle()` côté
/// TypeScript. `props.title` n'est que le repli.
pub fn page_title(page: &BlockJson) -> String {
    for child in page.children.iter().flatten() {
        let text: String =
            child.text.iter().flatten().map(|run| run.text.as_str()).collect::<String>();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(80).collect();
        }
    }
    let fallback = page
        .props
        .as_ref()
        .and_then(|props| props.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if fallback.is_empty() { "Sans titre".to_string() } else { fallback.to_string() }
}

/// Une page neuve : un titre de niveau 1 et un paragraphe vide, comme
/// `newPage()` côté workspace.
pub fn new_page(id: String, heading_id: String, paragraph_id: String, title: &str) -> BlockJson {
    let mut props = Map::new();
    props.insert("title".into(), Value::String(title.to_string()));
    let mut level = Map::new();
    level.insert("level".into(), Value::Number(1.into()));
    BlockJson {
        id,
        kind: "page".into(),
        version: 1,
        props: Some(props),
        text: None,
        children: Some(vec![
            BlockJson {
                id: heading_id,
                kind: "heading".into(),
                version: 1,
                props: Some(level),
                text: Some(if title.is_empty() {
                    vec![]
                } else {
                    vec![RunJson { text: title.to_string(), marks: None }]
                }),
                children: None,
            },
            BlockJson {
                id: paragraph_id,
                kind: "paragraph".into(),
                version: 1,
                props: None,
                text: Some(vec![]),
                children: None,
            },
        ]),
    }
}

// --- conversions de valeurs ---

/// JSON → Loro. Le cas entier est celui qui compte : `level: 1` stocké en
/// `Double` ressort en `1.0`, que §4 compte comme un autre document.
pub fn to_loro(value: &Value) -> LoroValue {
    match value {
        Value::Null => LoroValue::Null,
        Value::Bool(flag) => LoroValue::Bool(*flag),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                LoroValue::I64(int)
            } else {
                LoroValue::Double(number.as_f64().unwrap_or(0.))
            }
        }
        Value::String(text) => LoroValue::String(text.clone().into()),
        Value::Array(items) => LoroValue::List(items.iter().map(to_loro).collect::<Vec<_>>().into()),
        Value::Object(fields) => LoroValue::Map(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), to_loro(value)))
                .collect::<std::collections::HashMap<_, _>>()
                .into(),
        ),
    }
}

/// Loro → JSON.
pub fn to_json(value: &LoroValue) -> Value {
    match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(flag) => Value::Bool(*flag),
        LoroValue::I64(int) => Value::Number((*int).into()),
        LoroValue::Double(float) => serde_json::Number::from_f64(*float)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        LoroValue::String(text) => Value::String(text.to_string()),
        LoroValue::List(items) => Value::Array(items.iter().map(to_json).collect()),
        LoroValue::Map(fields) => Value::Object(
            fields.iter().map(|(key, value)| (key.to_string(), to_json(value))).collect(),
        ),
        // ni les octets ni un conteneur n'ont d'écriture JSON ; les props
        // n'en portent pas, et inventer une forme serait pire que de le dire
        LoroValue::Binary(_) | LoroValue::Container(_) => Value::Null,
    }
}

fn runs_to_json(runs: &[Run]) -> Vec<RunJson> {
    runs.iter()
        .map(|run| RunJson {
            text: run.text.clone(),
            marks: if run.marks.is_empty() {
                None
            } else {
                Some(
                    run.marks
                        .iter()
                        .map(|(kind, value)| MarkJson {
                            kind: kind.clone(),
                            attrs: match to_json(value) {
                                Value::Object(attrs) => Some(attrs),
                                // `true` est la forme courte d'une marque sans attributs
                                _ => None,
                            },
                        })
                        .collect(),
                )
            },
        })
        .collect()
}

impl Document {
    /// Semer un document vide depuis son JSON canonique.
    ///
    /// Deux pairs qui construisent chacun un `LoroDoc` à partir du même JSON
    /// **ne convergent pas** — ils fusionnent en doublant chaque bloc. Ceci
    /// n'est donc à appeler que quand l'instantané manque, pas à chaque
    /// ouverture.
    pub fn seed_from_json(&self, page: &BlockJson) -> LoroResult<()> {
        self.write_json(page, TreeParentId::Root, 0)?;
        self.doc.commit();
        self.reindex();
        Ok(())
    }

    fn write_json(&self, block: &BlockJson, parent: TreeParentId, index: usize) -> LoroResult<TreeID> {
        let target = self.tree().create_at(parent, index)?;
        let meta = self.tree().get_meta(target)?;
        meta.insert("id", block.id.as_str())?;
        meta.insert("type", block.kind.as_str())?;
        meta.insert("version", block.version)?;
        if let Some(props) = &block.props {
            let map: std::collections::HashMap<String, LoroValue> =
                props.iter().map(|(key, value)| (key.clone(), to_loro(value))).collect();
            meta.insert("props", LoroValue::from(map))?;
        }
        if let Some(runs) = &block.text {
            let container = meta.insert_container("text", LoroText::new())?;
            let mut at = 0usize;
            for run in runs {
                container.insert(at, &run.text)?;
                let width = run.text.chars().count();
                for mark in run.marks.iter().flatten() {
                    let value = match &mark.attrs {
                        Some(attrs) => to_loro(&Value::Object(attrs.clone())),
                        None => LoroValue::Bool(true),
                    };
                    container.mark(at..at + width, &mark.kind, value)?;
                }
                at += width;
            }
        }
        for (position, child) in block.children.iter().flatten().enumerate() {
            self.write_json(child, TreeParentId::Node(target), position)?;
        }
        Ok(target)
    }

    /// Le document, en JSON canonique — ce qu'on écrit dans `.nbe/<id>.json`.
    pub fn to_json(&self) -> Option<BlockJson> {
        let entries = self.entries();
        // les entrées arrivent en profondeur d'abord, préfixe : une pile
        // suffit à re-nicher sans chercher un parent par identifiant
        let mut stack: Vec<BlockJson> = Vec::new();
        let mut roots: Vec<BlockJson> = Vec::new();

        fn attach(stack: &mut Vec<BlockJson>, roots: &mut Vec<BlockJson>, block: BlockJson) {
            match stack.last_mut() {
                Some(parent) => parent.children.get_or_insert_with(Vec::new).push(block),
                None => roots.push(block),
            }
        }

        for entry in entries {
            while stack.len() > entry.depth {
                let done = stack.pop().expect("la pile suit la profondeur");
                attach(&mut stack, &mut roots, done);
            }
            let props: Map<String, Value> = entry
                .props
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect();
            stack.push(BlockJson {
                id: entry.id,
                kind: entry.kind,
                version: entry.version,
                props: (!props.is_empty()).then_some(props),
                text: entry.text.is_some().then(|| runs_to_json(&entry.runs)),
                children: None,
            });
        }
        while let Some(done) = stack.pop() {
            attach(&mut stack, &mut roots, done);
        }
        roots.into_iter().next()
    }
}

/// La lecture d'un `props` sur un nœud — utilisée aussi par `store.rs`.
pub(crate) fn props_of(meta: &loro::LoroMap) -> std::collections::HashMap<String, LoroValue> {
    match meta.get("props") {
        Some(ValueOrContainer::Value(LoroValue::Map(map))) => {
            map.iter().map(|(key, value)| (key.to_string(), value.clone())).collect()
        }
        _ => std::collections::HashMap::new(),
    }
}

/// Le conteneur de texte d'un nœud, s'il en a un.
pub(crate) fn text_of(meta: &loro::LoroMap) -> Option<LoroText> {
    match meta.get("text")? {
        ValueOrContainer::Container(Container::Text(text)) => Some(text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La fixture est écrite par l'éditeur TypeScript lui-même : les deux
    /// implémentations sont confrontées l'une à l'autre, pas à l'idée qu'un
    /// auteur se fait du format.
    fn fixture() -> BlockJson {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../swift/Tests/NbeModelTests/document.json"
        ))
        .expect("fixture partagée avec le port Swift");
        serde_json::from_str(&raw).expect("le JSON du vault se lit")
    }

    #[test]
    fn seeds_the_typescript_json_and_gives_it_back() {
        let source = fixture();
        let doc = Document::new(None).unwrap();
        doc.seed_from_json(&source).unwrap();
        let back = doc.to_json().expect("un document semé a une racine");

        assert_eq!(back.id, source.id);
        assert_eq!(back.kind, "page");
        // le titre survit dans les props de la page
        assert_eq!(back.props.as_ref().unwrap().get("title"), source.props.as_ref().unwrap().get("title"));
        assert_eq!(
            back.children.as_ref().unwrap().len(),
            source.children.as_ref().unwrap().len()
        );
    }

    #[test]
    fn an_integer_prop_stays_an_integer() {
        let source = fixture();
        let doc = Document::new(None).unwrap();
        doc.seed_from_json(&source).unwrap();
        let back = doc.to_json().unwrap();
        let heading = back
            .children
            .as_ref()
            .unwrap()
            .iter()
            .find(|block| block.kind == "heading")
            .expect("la fixture a un titre");
        // `1`, pas `1.0` : §4 compte les deux comme des documents différents
        assert_eq!(heading.props.as_ref().unwrap().get("level"), Some(&Value::Number(1.into())));
    }

    #[test]
    fn marks_survive_the_round_trip() {
        let source = fixture();
        let doc = Document::new(None).unwrap();
        doc.seed_from_json(&source).unwrap();
        let back = doc.to_json().unwrap();
        let marked: Vec<&RunJson> = back
            .children
            .iter()
            .flatten()
            .flat_map(|block| block.text.iter().flatten())
            .filter(|run| run.marks.is_some())
            .collect();
        assert!(!marked.is_empty(), "la fixture porte au moins une marque");
        assert!(marked.iter().any(|run| run
            .marks
            .as_ref()
            .unwrap()
            .iter()
            .any(|mark| mark.kind == "bold")));
    }

    /// §4 : un type et une prop que ce build n'a jamais vus ressortent intacts.
    #[test]
    fn unknown_types_and_props_round_trip() {
        let mut props = Map::new();
        props.insert("venuDuFutur".into(), Value::String("intact".into()));
        props.insert("compte".into(), Value::Number(7.into()));
        let source = BlockJson {
            id: "page".into(),
            kind: "page".into(),
            version: 1,
            props: None,
            text: None,
            children: Some(vec![BlockJson {
                id: "inconnu".into(),
                kind: "widget_de_2027".into(),
                version: 9,
                props: Some(props.clone()),
                text: None,
                children: None,
            }]),
        };
        let doc = Document::new(None).unwrap();
        doc.seed_from_json(&source).unwrap();
        let back = doc.to_json().unwrap();
        let child = &back.children.as_ref().unwrap()[0];
        assert_eq!(child.kind, "widget_de_2027");
        assert_eq!(child.version, 9, "une version inconnue n'est pas ramenée à 1");
        assert_eq!(child.props.as_ref().unwrap(), &props);
    }

    #[test]
    fn page_title_prefers_the_first_written_line() {
        let page = new_page("p".into(), "h".into(), "b".into(), "Projets");
        assert_eq!(page_title(&page), "Projets");
        let untitled = new_page("p".into(), "h".into(), "b".into(), "");
        assert_eq!(page_title(&untitled), "Sans titre");
    }
}
