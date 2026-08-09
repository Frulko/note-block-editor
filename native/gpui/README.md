# Carnet × GPUI

L'éditeur en natif, à la manière de Zed : **GPUI en Rust, pas de webview** —
chaque glyphe, caret et rectangle de sélection est peint par nous, sur le GPU.

```bash
cd native/gpui
cargo test -p carnet-model            # le format, sans interface
cargo run -p carnet-gpui              # l'éditeur (ouvre ./carnet.loro)
cargo run -p carnet-gpui -- doc.loro  # ou un document donné

# un document d'essai couvrant chaque type de bloc :
cargo run -p carnet-model --example seed -- demo.loro
cargo run -p carnet-gpui -- demo.loro
```

> Premier build sur macOS : gpui compile ses shaders Metal, ce qui demande le
> Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`).

## Ce que ça prouve

Le port Swift a prouvé que le *format* voyage (`native/swift`). Celui-ci va un
cran plus loin : **l'éditeur entier tient sans plateforme web** — et le
document reste le même octet pour octet, puisque Loro est du Rust natif, le
même moteur CRDT que `loro-crdt` côté web. Un `.loro` écrit par Chrome s'ouvre
ici, s'édite, se sauve, et rouvre dans Chrome.

Deux crates, même découpe que le port Swift :

- **`model/`** (`carnet-model`) — le format et les tables qui donnent leur
  *sens* aux frappes. `model.rs` est le miroir de `AUTOFORMAT_RULES` et
  `CONTINUING_TYPES` (`packages/core/src/commands.ts`) ; `store.rs` celui de
  `packages/collab/src/store.ts` : l'arbre possède la structure, le texte est
  un conteneur, Entrée/Retour arrière/Tab reproduisent `DocumentWriter.swift`.
  Aucune dépendance d'interface — `cargo test` tourne sans écran, et un test
  ouvre la fixture `document.loro` partagée avec le port Swift.
- **`app/`** (`carnet-gpui`) — la vue, un module par responsabilité :
  `editor.rs` l'état et les commandes, `block.rs` l'`Element` texte custom
  (mesure, wrap, caret, sélection, IME via `EntityInputHandler`, suivi du
  scroll), `rows.rs` l'habillage par type de bloc, `theme.rs` la typo du web
  (Inter/système, 16 px, titres 30/24/20 en 600 — les valeurs de
  `tokens.css`/`blocks.css`), `slash.rs` le menu slash, `assets.rs` les
  images (data-URL ↔ octets).

`test/gpui-parity.test.ts` lit `model.rs` comme du texte et échoue au commit
qui fait dériver les tables — le même contrat que `swift-parity.test.ts`,
désormais tenu par **trois** implémentations.

## Ce qui marche

Frappe (IME compris), Entrée qui scinde et continue les listes, Retour arrière
qui convertit puis fusionne, Tab/Shift-Tab, l'autoformat (`# `, `- `, `[] `,
`> `, `" `, ` ``` `, `---`), le **menu slash** (`/` puis filtrage au clavier,
flèches + Entrée, Échap ferme — conversion sur place d'un paragraphe vide,
insertion après sinon, comme `packages/dom/src/slash.ts`), les marques
(gras/italique/souligné/barré/code, `cmd-b/i/u/shift-s/e`), les cases à cocher
cliquables, les **dépliants qui plient** (la flèche cache la descendance,
`props.collapsed` comme le web), les **notes** (callout, icône + fond teinté
par variante), les **images** (`src` en data-URL, URL http ou chemin ; largeur
en %, légende) avec **dépôt de fichier** sur la fenêtre — chaque image déposée
devient un bloc, encodée en data-URL comme `fileToDataUrl` côté web —, le
**scroll** (molette, et le caret reste visible en tapant ou en naviguant), la
souris (clic + glisser), `cmd-z`/`cmd-shift-z` (UndoManager de Loro, local
seulement), `cmd-s`. Les types que ce client ne rend pas encore (table,
colonnes, base) s'affichent nommés au lieu de disparaître — §4 promet qu'ils
survivent au aller-retour.

## Les limites rencontrées (c'était le but)

- **Tout est à nous.** GPUI donne `shape_text` et des quads ; caret, sélection,
  mapping position↔offset, IME — tout se réécrit. C'est le prix affiché, Zed
  l'a payé aussi.
- **Le scroll aussi.** `overflow_y_scroll` + `track_scroll` n'ont jamais vu
  notre contenu mesuré (`content_size` restait à zéro, l'offset se faisait
  reclamper à 0 à chaque frame). Le défilement est donc manuel : un
  `scroll_y` dans l'état, la molette par `on_scroll_wheel`, le clip par
  `overflow_hidden` — et le suivi du caret devient trivial puisque tout est
  chez nous. C'est ce que Zed fait aussi.
- Haut/Bas naviguent de bloc en bloc sans mémoire de colonne ni parcours des
  lignes repliées ; coller du multi-ligne s'aplatit ; la sélection reste dans
  un bloc (pas de sélection multi-blocs) ; table, colonnes et base ne sont pas
  rendues. Les `ponytail:` dans la source marquent chaque plafond.
- Pas de synchronisation ici : `carnet-model` est un pair complet côté format,
  mais le transport (relay/WebRTC) n'est pas branché. C'est la marche suivante
  naturelle si l'expérience continue.
