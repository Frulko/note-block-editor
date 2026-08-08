# Carnet, sur iOS

Le troisième client sur le même document : SwiftUI, `native/swift`, et un vrai
`RTCPeerConnection`.

```bash
brew install xcodegen                 # une fois
cd apps/ios && xcodegen generate      # le .xcodeproj est généré, pas versionné
open Carnet.xcodeproj                 # puis ⌘R sur un simulateur iPhone
```

En ligne de commande, sans ouvrir Xcode :

```bash
# 1. le relais, sur la machine hôte — depuis le simulateur, « localhost » c'est elle
pnpm --filter @nbe/cli exec tsx src/bin.ts relay --port 8787

# 2. l'app
xcodegen generate
xcodebuild -project Carnet.xcodeproj -scheme Carnet \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build build
xcrun simctl boot "iPhone 17"; open -a Simulator
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Carnet.app
SIMCTL_CHILD_CARNET_ROOM=salon SIMCTL_CHILD_CARNET_RELAY=ws://localhost:8787 \
  xcrun simctl launch booted fr.myrole.carnet
```

Les deux variables d'environnement remplissent le formulaire et rejoignent le
salon tout seuls — c'est la seule chose qu'un script ne peut pas faire à cette
app. Sans elles, l'app se comporte exactement comme elle en a l'air.

Puis, dans un navigateur et dans un terminal, sur le même salon :

```bash
pnpm --filter demo-collab dev --port 5175
# http://localhost:5175/?room=salon&relay=ws://localhost:8787
pnpm --filter @nbe/cli exec tsx src/bin.ts peer --room salon --relay ws://localhost:8787
```

Les trois affichent « pair-à-pair » et le relais ne voit plus passer le
document. Ce qui est écrit dans le navigateur apparaît sur l'iPhone, et
l'inverse.

## Ce que ça prouve, et ce que ce n'est pas

Le protocole vit dans `native/swift` — `SyncSession`, `P2PTransport`,
`RelayTransport` — et il est testé par `swift test` sans télécharger WebRTC,
parce que `P2PTransport` reçoit son `PeerLink` au lieu de l'importer. Cette app
n'ajoute que deux choses : `WebRTCLink.swift`, la vraie implémentation, et un
écran. Le seul fichier qui importe `WebRTC` est donc celui-là.

**C'est un éditeur de blocs**, avec un `UITextView` par bloc (D1 sur iOS) :

- Entrée scinde le bloc au curseur, continue une liste, et sort d'une puce vide.
- Retour arrière au début fusionne avec le bloc précédent — après avoir d'abord
  ramené un titre ou une puce à un paragraphe, comme Notion.
- `/` ouvre le menu des types ; le champ de filtre prend le clavier parce qu'une
  feuille le lui prend de toute façon.
- Les préfixes markdown (`# `, `- `, `1. `, `[] `, `" `, ```` ``` ````, `---`)
  convertissent le bloc, y compris quand ils arrivent en lot ou par un collage.
- Cases à cocher, citations, code, bascules repliables, imbrication, poignée de
  glissement et flèches monter/descendre dans la barre au-dessus du clavier.

Les commandes vivent dans `native/swift` (`DocumentWriter`) et sont un miroir de
`packages/core/src/commands.ts` : `swift test` les vérifie sans simulateur, et
`test/swift-parity.test.ts` échoue si les deux tables de préfixes divergent.

**Ce qui reste ouvert.** L'édition par bloc sur mobile est la question que la
matrice d'appareils doit trancher
(`docs/research/per-block-contenteditable-evidence.md`), et deux vérifications
d'interface échouent en série complète pour une raison qui vient du clavier iOS
et non de l'éditeur — `docs/TESTING.md` le détaille. Pas de marques (gras,
liens) à l'écran : elles traversent une scission intactes, mais rien ne les
affiche encore.

**Le simulateur ne dit pas tout.** Il partage la pile réseau du Mac : le
pair-à-pair y est trivialement local. Ce qu'il ne peut pas montrer, c'est le
NAT d'un opérateur mobile — le cas où le canal direct échoue et où le relais
redevient le chemin. C'est justement pour ça que le repli n'est pas un mode
dégradé mais le transport d'origine (`docs/research/p2p-any-sync.md`).
