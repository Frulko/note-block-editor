# Carnet × GPUI

L'éditeur en natif, à la manière de Zed : **GPUI en Rust, pas de webview** —
chaque glyphe, caret, rectangle de sélection et ascenseur est peint par nous,
sur le GPU.

```bash
cd native/gpui
cargo test --workspace        # 44 tests, sans écran
cargo run -p carnet-gpui      # l'app : ouvre le dernier dossier, sinon ~/Carnet
```

> Premier build sur macOS : gpui compile ses shaders Metal, ce qui demande le
> Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`).

## Ce que ça prouve

Le port Swift a prouvé que le *format* voyage. Celui-ci va deux crans plus
loin : **l'éditeur entier tient sans plateforme web**, et **il parle aux
autres**. Vérifié de bout en bout, pas déduit :

```
app GPUI (Rust) ──frappe──▶ relais TypeScript ──▶ pair TypeScript ──▶ disque
```

Le fichier `.loro` écrit par le pair TypeScript contient ce qui a été tapé
dans l'app native — relu ensuite par `carnet-model`. Loro 1.13.9 des deux
côtés, un octet d'en-tête, le même `VersionVector` : les octets sont
identiques par construction.

## Les trois crates

- **`model/`** (`carnet-model`) — le format, sans dépendance d'interface.
  `model.rs` porte les tables qui donnent leur *sens* aux frappes (autoformat,
  types continués, types qui portent du texte) ; `store.rs` est le miroir de
  `packages/collab/src/store.ts` ; `blocks.rs` celui des commandes de bloc de
  `packages/core/src/commands.ts` (sélection normalisée, supprimer, dupliquer,
  déplacer, déposer) ; `json.rs` le pont vers le JSON canonique d'un vault.
- **`sync/`** (`carnet-sync`) — le protocole : `[kind][payload]` sur WebSocket,
  `Have`/`Update`/`Presence`/`Signal` aux mêmes valeurs qu'en TypeScript et en
  Swift. Le fil réseau partage le `LoroDoc` et ne fait **jamais** d'I/O dans le
  callback d'update local (il se déclenche pendant `commit()` — c'est le bug
  classique de cette forme).
- **`app/`** (`carnet-gpui`) — l'interface, un module par responsabilité :
  `workspace.rs` (vue racine, vault, sauvegarde différée, sync), `sidebar.rs`,
  `editor.rs` (l'état d'un document et ce que chaque touche fait), `block.rs`
  (l'`Element` texte : mesure, wrap, caret, sélection, IME), `rows.rs`
  (l'habillage par type, la gouttière, le glissé), `scrollbar.rs`, `ui.rs`
  (infobulles et menus), `theme.rs`, `settings.rs`, `icons.rs`, `vault.rs`,
  `slash.rs`, `assets.rs`.

`test/gpui-parity.test.ts` lit `model.rs` comme du texte et échoue au commit
qui fait dériver une table — le même contrat que `swift-parity.test.ts`,
désormais tenu par **trois** implémentations.

## Ce que l'app sait faire

**Le document** — frappe (IME compris), Entrée qui scinde et continue les
listes, Retour arrière qui convertit puis fusionne, Tab/Shift-Tab,
l'autoformat (`# `, `- `, `[] `, `> `, `" `, ` ``` `, `---`), le menu slash
(`/` puis filtrage, flèches, Entrée), les marques (`⌘B/I/U/E`, `⌘⇧X`), le
caret **qui clignote** (et reste plein sous les doigts), la sélection de
texte, la souris (clic + glisser), `⌘Z`/`⌘⇧Z`.

**Les blocs** — sélection de blocs (Échap y entre, Échap en sort, `⌘A` en
escalade texte → bloc → document, flèches et Maj+flèches), supprimer,
dupliquer (`⌘D`), déplacer (`⌘⇧↑/↓`), **glisser-déposer** par la poignée ⋮⋮
avec aperçu suivant le curseur et indicateur de dépôt de 2 px sur le bord
visé, menu de bloc (transformer, dupliquer, monter, descendre, supprimer),
cases à cocher, dépliants qui plient, notes (7 variantes), images (data-URL,
URL ou chemin) et **dépôt de fichiers** sur la fenêtre.

**L'app** — barre latérale avec l'arbre des pages d'un **vault** (le vrai :
`.nbe/<id>.json` + `.nbe/rooms/<id>.loro`, écrits atomiquement et
debouncés à 400 ms comme le desktop), création et suppression de page,
ouverture de dossier (`⌘O`), réglages (`⌘,` : thème clair/sombre, taille du
texte, largeur de page, relais), barre d'état avec le statut de
synchronisation, ascenseur qui suit le caret, icônes **Lucide** (les mêmes
SVG que le web), infobulles, et des menus qui se ferment au clic à côté.

## Les limites rencontrées (c'était le but)

- **Tout est à nous.** GPUI donne `shape_text` et des quads. Caret, sélection,
  mapping position↔offset, IME, ascenseur, menus, infobulles : tout se
  réécrit. C'est le prix affiché, Zed l'a payé aussi.
- **Le scroll natif ne voit pas un contenu mesuré à la main.**
  `overflow_y_scroll` + `track_scroll` gardaient `content_size` à zéro et
  reclampaient l'offset à 0 à chaque frame. Le défilement est donc manuel
  (`scroll_y`, `on_scroll_wheel`, `overflow_hidden`) — ce qui rend le suivi du
  caret trivial, puisque tout est chez nous.
- **Un SVG ne peint que si `text_color` est posé sur lui.** GPUI fait
  `self.path.as_ref().zip(style.text.color)` : une icône dans un parent coloré
  n'hérite de rien et disparaît en silence. `Icon::sized` exige donc la
  couleur, et un test vérifie que chaque icône déclarée existe vraiment.
- **La gouttière doit vivre *dans* la rangée.** Posée à sa gauche, aller la
  chercher quittait le survol et la faisait disparaître avant qu'on
  l'atteigne. Le web réserve la même place dans son padding (58 px).
- **`on_drag_move` se déclenche sur *toutes* les rangées**, pas seulement
  celle sous le curseur : GPUI passe `bounds` pour qu'on tranche soi-même.
  Sans ce test, la dernière rangée rendue gagnait et un bloc traîné
  atterrissait toujours en fin de document.
- **`on_drop` ne se déclenche pas dans cette disposition** (il exige que la
  rangée soit « survolée » au sens du hit-test au moment du relâchement, ce
  qui n'arrive pas ici). Le dépôt est donc validé au `mouse_up` de l'éditeur,
  depuis la cible que `on_drag_move` tient à jour — un chemin de moins, et
  plus simple à suivre.
- Restent en dehors : la sélection de texte multi-blocs, le collage
  multi-ligne, les colonnes (désactivées par défaut sur le web aussi), les
  tables et les bases de données, le miroir Markdown, la présence, et la
  liaison **WebRTC directe** — le transport relais est là, la signalisation
  est reçue et ignorée, ce qui garde les pairs web sur le relais plutôt que de
  les perdre. Les `ponytail:` dans la source marquent chaque plafond.

## Tester la synchronisation

```bash
# 1. le relais
pnpm --filter @nbe/cli exec tsx src/bin.ts relay

# 2. un pair TypeScript qui garde le document sur disque
pnpm --filter @nbe/cli exec tsx src/bin.ts peer --room <pageId> --root /tmp/pair

# 3. dans l'app : ⌘⇧S active la sync (le salon est l'id de la page)
#    ou, sans interface :
cargo run -p carnet-sync --example interop -- <pageId> ws://127.0.0.1:8787
```
