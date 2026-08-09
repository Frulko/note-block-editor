//! Fabrique un document d'essai couvrant chaque type de bloc :
//! `cargo run -p carnet-model --example seed -- demo.loro`

use carnet_model::store::Document;
use loro::LoroValue;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "demo.loro".into());
    let doc = Document::new(None).unwrap();
    doc.create_page("page", "Carnet, rendu par GPUI").unwrap();

    let blocks: &[(&str, &str, &[(&str, LoroValue)])] = &[
        ("h1", "Un éditeur de blocs, sans webview", &[("level", LoroValue::I64(2))]),
        ("p1", "Chaque glyphe, caret et sélection est peint par GPUI — le même document que le web, via Loro.", &[]),
        ("b1", "Entrée continue une liste", &[]),
        ("b2", "Tab l'indente, Shift-Tab la ressort", &[]),
        ("n1", "Les listes numérotées comptent leurs frères", &[]),
        ("n2", "et repartent après un intrus", &[]),
        ("t1", "Une case à cocher cliquable", &[("checked", LoroValue::Bool(true))]),
        ("t2", "Une autre, encore à faire", &[]),
        ("g1", "Un dépliant, comme sur Notion", &[]),
        ("q1", "Une citation, déclenchée par \" et l'espace.", &[]),
        ("c1", "fn main() {\n    println!(\"du code, en Menlo\");\n}", &[]),
        ("d1", "", &[]),
        ("k1", "Une note avec icône et fond teinté — le plugin callout, en natif.", &[]),
        ("p2", "Tapez # , - , [] , > ou ``` en début de paragraphe : la même table d'autoformat que le web décide.", &[]),
    ];
    for (id, text, _) in blocks {
        doc.append_paragraph(text, "page", id).unwrap();
    }
    doc.turn_into("h1", "heading", &[("level", LoroValue::I64(2))]).unwrap();
    for id in ["b1", "b2"] {
        doc.turn_into(id, "bulleted_list_item", &[]).unwrap();
    }
    for id in ["n1", "n2"] {
        doc.turn_into(id, "numbered_list_item", &[]).unwrap();
    }
    doc.turn_into("t1", "to_do", &[("checked", LoroValue::Bool(true))]).unwrap();
    doc.turn_into("t2", "to_do", &[("checked", LoroValue::Bool(false))]).unwrap();
    doc.turn_into("g1", "toggle", &[]).unwrap();
    doc.turn_into("q1", "quote", &[]).unwrap();
    doc.turn_into("c1", "code", &[]).unwrap();
    doc.turn_into("d1", "divider", &[]).unwrap();
    doc.turn_into("k1", "callout", &[("variant", LoroValue::from("warning"))]).unwrap();
    doc.indent("b2").unwrap();
    doc.mark("p1", 46, 49, "bold", true).unwrap();

    // une image par chemin, si fournie : cargo run --example seed -- doc.loro photo.png
    if let Some(image) = std::env::args().nth(2) {
        doc.append_paragraph("", "page", "i1").unwrap();
        doc.turn_into("i1", "image", &[
            ("src", LoroValue::from(image.as_str())),
            ("caption", LoroValue::from("déposée par chemin")),
            ("width", LoroValue::I64(60)),
        ]).unwrap();
    }
    // du volume, pour éprouver le scroll
    for n in 0..30 {
        let id = format!("fill-{n}");
        doc.append_paragraph(&format!("Paragraphe {n} — du volume pour faire défiler la page et vérifier que le caret reste visible."), "page", &id).unwrap();
    }

    std::fs::write(&path, doc.snapshot().unwrap()).unwrap();
    println!("écrit : {path}");
}
