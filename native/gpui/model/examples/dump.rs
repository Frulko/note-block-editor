//! Affiche un document : `cargo run -p carnet-model --example dump -- fichier.loro`
fn main() {
    let path = std::env::args().nth(1).expect("chemin du .loro");
    let bytes = std::fs::read(&path).unwrap();
    let doc = carnet_model::store::Document::new(Some(&bytes)).unwrap();
    for entry in doc.entries() {
        println!("{}{} [{}] {:?}", "  ".repeat(entry.depth), entry.index, entry.kind, entry.text);
    }
}
