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

**Ce n'est pas un éditeur.** `NbeEditorKit` est derrière `#if canImport(AppKit)`
et la vue texte par bloc sur iOS est précisément la question ouverte que la
matrice d'appareils doit trancher
(`docs/research/per-block-contenteditable-evidence.md`). Ici, un `TextField` par
bloc : assez pour taper, pas assez pour prétendre. Ce que cette app démontre,
c'est la synchronisation entre trois implémentations, pas l'édition sur mobile.

**Le simulateur ne dit pas tout.** Il partage la pile réseau du Mac : le
pair-à-pair y est trivialement local. Ce qu'il ne peut pas montrer, c'est le
NAT d'un opérateur mobile — le cas où le canal direct échoue et où le relais
redevient le chemin. C'est justement pour ça que le repli n'est pas un mode
dégradé mais le transport d'origine (`docs/research/p2p-any-sync.md`).
