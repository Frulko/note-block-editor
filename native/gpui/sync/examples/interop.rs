//! Preuve d'interopérabilité, sans interface :
//!
//! ```bash
//! # dans un terminal : le relais TypeScript
//! pnpm --filter @nbe/cli exec tsx src/bin.ts relay
//! # dans un autre : un pair TypeScript qui garde le document sur disque
//! pnpm --filter @nbe/cli exec tsx src/bin.ts peer --room salon --root /tmp/pair
//! # puis, ici :
//! cargo run -p carnet-sync --example interop -- salon ws://127.0.0.1:8787
//! ```
//!
//! Ce que ça écrit doit apparaître dans `/tmp/pair/.nbe/rooms/salon.loro`.

use std::time::Duration;

use carnet_model::store::Document;
use carnet_sync::{Session, Status};

fn main() {
    let room = std::env::args().nth(1).unwrap_or_else(|| "salon".into());
    let relay = std::env::args().nth(2).unwrap_or_else(|| "ws://127.0.0.1:8787".into());

    let document = Document::new(None).expect("document neuf");
    let session = Session::connect(&document.doc, &relay, &room);

    // laisser le document du salon arriver avant de décider qu'il est vide :
    // semer une page dans un salon peuplé duplique tout au lieu de converger
    std::thread::sleep(Duration::from_millis(1500));
    println!("statut : {}", session.status().label());
    let arrived = document.entries().len();
    println!("blocs reçus du salon : {arrived}");

    let page = match document.entries().first() {
        Some(page) => page.id.clone(),
        None => {
            document.create_page("page-rust", "Depuis Rust").expect("page");
            "page-rust".to_string()
        }
    };
    let marker = format!("écrit par Rust à {} µs", std::process::id());
    document.append_paragraph(&marker, &page, &format!("rust-{}", std::process::id())).expect("bloc");

    // laisser partir l'update, puis lire ce que le salon nous a renvoyé
    std::thread::sleep(Duration::from_millis(1500));
    println!("statut : {}", session.status().label());
    println!("révisions reçues : {}", session.revision());
    println!("--- document ---\n{}", document.plain_text());
    println!("--- marqueur écrit ---\n{marker}");

    if matches!(session.status(), Status::Error(_)) {
        std::process::exit(1);
    }
}
