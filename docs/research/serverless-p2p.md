# Un p2p sans serveur à installer : ce qui est possible, et ce qui ne l'est pas

Recherché le 2026-08-09, à la question « on veut un vrai système de p2p sans
serveur à devoir installer, sans TURN/STUN à nous, il faut se baser sur de
l'existant ». La réponse courte : **« sans aucun serveur » n'existe pas, mais
« sans serveur que l'utilisateur doit installer » existe — et la forme qui le
donne est la plus ennuyeuse des six examinées : un dossier de fichiers
immuables à côté du vault, que Syncthing ou iCloud transportent sans rien
savoir, plus Trystero pour le rendez-vous temps réel sur l'infrastructure
publique de quelqu'un d'autre. Le relais maison ne disparaît pas ; il cesse
d'être obligatoire.**

## Le cadre qui règle le débat

Les quatre préoccupations de `sync-protocol.md` — transport, identité,
découverte, autorisation — sont ce qui empêche de comparer des choses
incomparables. « Sans serveur » n'est jamais une propriété du système : c'est
une propriété d'une colonne à la fois.

| Piste | Transport | Identité | Découverte | Autorisation |
| --- | --- | --- | --- | --- |
| Fichiers immuables (Rung 0) | le service de sync de l'utilisateur | aucune, c'est un dossier | aucune, c'est un dossier | celle du dossier |
| Trystero / Nostr | WebRTC, inchangé | clé jetable par processus | **résolue sans rien installer** | secret de salon symétrique |
| Relais entre pairs (flooding) | inchangé + réémission | — | — | — |
| iroh | QUIC natif seulement | clé publique = adresse | relais + DNS de n0 | connexion authentifiée |
| Notre relais WSS | WSS/443 si on met du TLS | — | URL tapée à la main | hook `authorize`, jamais appelé |

Deux lectures en tombent. **Aucune piste ne résout plus d'une colonne et
demie**, donc « laquelle choisir » est mal posé. Et la seule colonne où
l'utilisateur doit aujourd'hui installer quelque chose est *découverte* — celle
que Trystero supprime — pendant que *disponibilité*, deux pairs allumés en même
temps, n'est dans aucune colonne et reste le vrai problème, que seul un fichier
posé sur un disque résout.

## La décision

**Une architecture, trois chemins, un seul `LoroDoc`.**

1. **Le dossier est le chemin par défaut.** L'oplog Loro devient des fichiers
   immuables, un blob par fichier, jamais réécrits, dans
   `<vault>/.nbe/oplog/<pageId>/`. Ce que le service de sync de l'utilisateur
   fait de ce dossier ne nous regarde pas, et c'est le point.
2. **Trystero est le second `Transport`, pour le temps réel.** Il remplace la
   saisie d'une URL de relais, pas le relais.
3. **Le relais maison reste, comme repli qui traverse les pare-feux**, parce
   qu'il est le seul chemin qui porte le *document* sur une socket sortante.

Ce n'est pas trois options : `packages/collab/src/sync.ts:25` définit un
`Transport` de deux méthodes et `connect()` ne sait pas d'où viennent les
octets. Les trois chemins importent dans le même document et se doublonnent
sans dommage — un update Loro appliqué deux fois est idempotent. La raison de
préférer le dossier au réseau tient en une phrase : le réseau exige que les
deux appareils soient allumés en même temps, ce qu'un portable fermé lundi et
un téléphone ouvert vendredi ne feront jamais
(`docs/research/p2p-any-sync.md:53`). Un fichier n'a pas cette exigence.

## Ce qui rend le dossier correct, et ce n'est pas évident

Quatre propriétés de Loro, mesurées deux fois indépendamment le 2026-08-09 sur
`loro-crdt` 1.13.9, décident de tout le schéma :

- Deux updates **concaténés** dans un fichier sont refusés : « Decode error:
  Checksum mismatch ». L'append-only naïf ne marche pas sans cadrage maison.
- Un fichier **tronqué** est refusé par le même checksum et laisse le document
  intact. Une écriture partielle vue par un service de sync est un fichier à
  réessayer, jamais une perte.
- `importBatch` avale les blobs **dans le désordre, avec des trous, en
  double** : les changements orphelins restent `pending` et se résolvent à
  l'arrivée du reste ([loro.dev/llms-full.txt](https://loro.dev/llms-full.txt)).
- Un fichier que personne d'autre n'écrit ne peut pas produire de copie de
  conflit : Dropbox n'en crée que sur écriture concurrente du *même chemin*
  ([help.dropbox.com](https://help.dropbox.com/organize/conflicted-copy)),
  Syncthing n'écrit jamais directement au chemin final
  ([docs.syncthing.net](https://docs.syncthing.net/users/syncing.html)).

Donc : un blob par fichier, nommé `d<device>-<seq>.loro` (update) ou
`s<device>-<seq>.loro` (snapshot), lecture par `importBatch` de tout ce qui
matche `/^[ds][0-9a-f]{16}-\d+\.loro$/` — ce filtre écarte d'un coup
`.syncthing.*.tmp`, `*.sync-conflict-*` (que Syncthing propage comme des
fichiers ordinaires) et `* (conflicted copy)*`.

**Ce n'est pas une fonctionnalité neuve, c'est une réparation.**
`apps/desktop/src/storage.ts:228` écrit *aujourd'hui* un fichier mutable unique
par page, `.nbe/rooms/<id>.loro`, réécrit à chaque sauvegarde : deux appareils
visent le même chemin, donc un vault dans iCloud ou Dropbox produit déjà une
copie de conflit et une des deux histoires part dans un fichier que personne ne
lit. Le même défaut vaut pour `.nbe/collections.json`
(`apps/desktop/src/storage.ts:143`), un fichier unique pour tout l'espace de
travail — l'hygiène de stockage vaut pour tout `.nbe/`, pas pour le seul
`.loro`.

## L'échelle de repli, version sans relais maison obligatoire

Elle remplace celle de `p2p-any-sync.md:105`. Chaque barreau dit à qui on fait
confiance, ce qui est le seul critère qui compte ici.

| Barreau | Chemin | Confiance | Ce qu'il coûte |
| --- | --- | --- | --- |
| 0 | dossier synchronisé, ou clé USB | le service que l'utilisateur a déjà | rien à installer de notre fait ; **pas de temps réel** |
| 1 | WebRTC direct, rendez-vous Trystero | 5 relais Nostr épinglés | ~33 ko gz de dépendance ; échoue si l'UDP est bloqué |
| 2 | WebRTC via STUN public | Google, Cloudflare | 2 entrées, deux opérateurs ; inutile sans UDP |
| 3 | relais WSS maison (`nbe relay`) | soi-même, ou l'hôte du relais | **le seul barreau qui traverse un pare-feu strict** |
| 4 | TURN tiers sur 443 | un compte gratuit chez un tiers | non vérifié, voir plus bas |
| 5 | `nbe serve` | un pair qui ne part jamais | une machine allumée |

Le barreau 0 est le seul qui satisfait « transportable sur clé USB » par
construction. Sur les pare-feux, la formulation honnête n'est pas « gagné » :
un réseau qui bloque WebRTC bloque aussi, et plus systématiquement, Syncthing
et Dropbox. Le problème est délégué à un logiciel sur lequel on n'a aucune
prise, ce qui n'est pas la même promesse.

Le barreau 1 ne suffit pas seul, et son plus gros déploiement le dit :
Self-hosted LiveSync, qui dépend de `@trystero-p2p/nostr` 0.25.3 et tourne sur
Obsidian mobile
([registry.npmjs.org](https://registry.npmjs.org/@vrtmrz%2flivesync-commonlib)),
documente que « WebRTC may fail when UDP hole punching is blocked by
carrier-grade NAT, a firewall, a VPN policy, or an intermediary gateway » et
renvoie vers un TURN tiers qu'il n'héberge pas
([docs/tips/p2p-sync-tips.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/tips/p2p-sync-tips.md)).
**Trystero supprime le serveur de rendez-vous ; il ne supprime pas le pare-feu.**

## Trystero : ce qu'il faut savoir avant de l'écrire

`trystero` 0.25.3, publiée le 2026-07-13, dépôt poussé le 2026-07-22
([registry.npmjs.org](https://registry.npmjs.org/trystero)). Le paquet
`trystero` n'est plus qu'un alias de `@trystero-p2p/nostr` ; les sous-chemins
`/torrent`, `/mqtt` sont des stubs de dépréciation. Quatre pièges, tous
vérifiés dans le dist publié :

- **Le choix des relais est déterministe.** `getRelays` fait un Fisher-Yates
  semé par la somme des codes de caractères de l'`appId` et prend les 5
  premiers : tous les utilisateurs taperaient les 5 mêmes relais pour toujours,
  et l'`appId` « carnet » en tire deux morts (25 s avant le premier pair,
  mesuré). `relayConfig.urls` court-circuite la sélection : **épingler notre
  liste est obligatoire**. Sur les 47 défauts, 39 répondaient le 2026-08-09.
- **La dérivation de clé est un SHA-256 en une passe** sur
  `secret:appId:roomId`, sans PBKDF2 ni argon2
  ([crypto.ts](https://github.com/dmotz/trystero/blob/dfdba65702636496e9da2fe53ecca517f5195072/packages/core/src/crypto.ts)).
  Donc jamais de mot de passe humain : un secret de salon tiré à 128 bits,
  transporté par URI de configuration.
- **`onPeerJoin`/`onPeerLeave` sont des accesseurs** en 0.25.x, pas des
  fonctions d'abonnement. Tout exemple copié du web est silencieusement mort.
  Épingler la version exacte, comme le fait LiveSync.
- **`getPeers()` ne rend que les pairs connectés** : la propriété `members` de
  `packages/collab/src/webrtc.ts:111` — la seule chose qui empêche deux
  navigateurs de mailler et de laisser `nbe serve` muet — n'est pas
  reproductible par l'API publique. `onJoinError` la couvre partiellement.

En échange il apporte ce qu'on aurait fini par écrire : pool d'offres, backoff
des sockets, découpage en morceaux de 16 Kio avec contre-pression
`bufferedamountlow` (notre `webrtc.ts:316` envoie sans regarder
`bufferedAmount`), handshake défi/réponse, et le mode `passive` fait pour un
pair de secours toujours allumé
([issue #146](https://github.com/dmotz/trystero/issues/146)).

## Le chiffrement de bout en bout : où, avec quelle clé, et ce qui fuit quand même

Aujourd'hui il n'y en a aucun : `grep` sur `packages/collab/src/` ne trouve que
`getRandomValues` à `webrtc.ts:349`, pour tirer un identifiant. Le repli relais
transporte les deltas Loro **en clair** — tant que c'est vrai, on ne peut pas
proposer d'utiliser le relais d'un tiers. Le correctif est un `Transport` qui en
enveloppe un autre, fichier neuf `packages/collab/src/crypto.ts`, placé
**entre `connect()` et `p2pTransport`** :

```
connect(store, encrypted(p2pTransport(connectToRelay(url, room)), key))
```

- **Pourquoi cet ordre.** Chiffrer la signalisation rendrait indéchiffrable la
  trame `members` que le relais émet en clair (`packages/cli/src/relay.ts:87`),
  et `expected` resterait `undefined` pour toujours.
- **Le cadrage.** L'octet 0 (le kind) reste en clair : `webrtc.ts:287`,
  `presence.ts` et `SyncSession.swift:38` dispatchent tous dessus. Suivent
  4 octets d'identifiant de clé, puis un IV de 12 octets, puis AES-GCM.
- **La clé.** 32 octets aléatoires par espace de travail, affichés comme URI de
  configuration, jamais dérivés d'un mot de passe tapé. Ni rotation ni
  révocation : `sync-protocol.md:93` dit pourquoi c'est impossible sans
  re-chiffrement.
- **`send` est synchrone, `crypto.subtle` ne l'est pas** : une chaîne de
  promesses garde l'ordre, et le rejet s'attrape au lieu de flotter.
- **`crypto.subtle` est un global du runtime**, donc l'invariant CI
  (`test/packaging.test.ts:32`) tient sans effort ; `AES.GCM` est dans CryptoKit.
- **L'identifiant de clé n'est pas décoratif.** Sans lui, un pair sans la clé
  (`nbe serve`, un vieux client) envoie son `Have` en clair, les autres échouent
  au déchiffrement et l'ignorent ; `members` le compte toujours, les écrans
  affichent « Synchronisé, N pairs », rien ne converge. C'est la perte
  silencieuse que `webrtc.ts:111` existe pour empêcher, en pire. Le mismatch
  doit remonter dans `P2PState`.

Ce qu'un observateur de l'infrastructure publique voit **malgré** le
chiffrement : le hash du salon, l'identifiant de session de chaque pair en clair
sur le topic racine, son adresse IP, l'heure et le rythme de ses annonces. Le
SDP est chiffré, le graphe social et les horaires ne le sont pas — et comme
l'`appId` est public dans une app distribuée, la liste des relais à surveiller
se calcule en une ligne : la fuite est ciblable, pas diffuse. « Chiffré par
défaut » ne veut pas dire « anonyme », et ça s'écrit dans le README — c'est même
une condition de publication chez Obsidian, qui exige d'expliquer « which
remote services are used and why they're needed ».

## Le plan par surface, par valeur par ligne décroissante

| # | Surface | Fichiers | Lignes | Ce que ça achète |
| --- | --- | --- | --- | --- |
| 1 | oplog fichiers | `packages/collab/src/oplog.ts` (neuf), `apps/desktop/src/storage.ts:228` | ~110 + ~55 | la sync multi-appareils sans réseau, et la réparation d'un bug latent |
| 2 | rattrapage | `packages/collab/src/sync.ts`, `webrtc.ts:239` | ~8 | un pair qui rejoint ne reste plus muet |
| 3 | chiffrement | `packages/collab/src/crypto.ts` (neuf) | ~60 | le relais d'un tiers devient acceptable |
| 4 | Trystero | `packages/collab/src/trystero.ts` (neuf), `apps/desktop/src/main.ts:388` | ~45 + ~30 | plus d'URL de relais à taper |
| 5 | CLI | `packages/cli/src/peer.ts`, `node.ts` | ~35 | `nbe peer` sans `--relay`, mode `passive` |
| 6 | Swift | `EncryptedTransport.swift` (neuf), `apps/ios/Carnet/Room.swift:107` | ~45 + ~15 | parité de chiffrement |
| 7 | gpui | `native/gpui/app/src/settings.rs:43` | **−4** | trois réglages qui ne pilotent rien |

**Livrable 1 : l'oplog en fichiers, et rien d'autre.** Seul élément qui livre
de la synchronisation à un utilisateur qui n'installe rien, et dont le bénéfice
ne dépend d'aucune infrastructure tierce. Il corrige au passage
`packages/collab/src/store.ts:242`, où `export(from)` ignore son argument et
renvoie la version courante du document — 22 octets au lieu de 199, branche
morte parce que personne ne l'appelle avec un argument.

Le rattrapage (#2) est un vrai bug, mais plus étroit que d'abord annoncé : un
pair dont les opérations ne sont pas commitées pousse quand même, parce que
`encodeVersion(doc)` à `sync.ts:120` commite et déclenche l'abonnement local.
Le trou est le document **rechargé depuis le disque**, c'est-à-dire le cas
local-first. Le correctif paresseux est un `onPeerJoin?(cb)` optionnel sur
`Transport`, implémenté par `webrtc.ts` sur `hello`/`members` et par
l'adaptateur Trystero : tous les chemins d'un coup.

Une granularité à changer avec #4 : le salon devient l'espace de travail et non
`pageId` (`apps/desktop/src/main.ts:398`), sinon on annonce toutes les ~5 s par
page ouverte sur une infrastructure publique gratuite. Les documents, eux,
restent un par page — « syncing a whole workspace as one document would make
every peer download every page to read one » est déjà écrit au bon endroit.

**Plugin Obsidian : rien dans celui-ci, et c'est un deuxième plugin.** Le plugin
actuel régénère les ids de blocs à chaque chargement
(`apps/obsidian/src/main.ts:51`), donc Loro n'a aucune identité stable à faire
converger. Ce n'est pas un oubli : `docs/research/obsidian.md:148` pose que ce
plugin « ships the editor alone […] No comments, no presence, no CRDT, no
`.nbe/` », et que « the moment it wants sub-pages, backlinks or undo across
files, the original objection comes back in full ». Donner une identité stable
aux blocs, c'est franchir exactement cette ligne.

La conclusion n'est donc pas « on ne fait rien pour Obsidian », c'est **« pas
dans ce plugin-là »** — et c'est déjà ce que demande la note de tâche : « une
deuxième plugin obsidian capable de faire un sync ». Deux plugins, deux
contrats : l'éditeur reste l'éditeur, et Carnet-dans-Obsidian est un vault
Carnet qui se trouve vivre dans un dossier Obsidian, avec son L0, ses ids
persistés et son oplog. C'est la même application que le desktop, avec une autre
coquille — donc le barreau 0 lui vient gratuitement et le livrable 1 le sert
sans une ligne de plus.

Deux contraintes propres à cette coquille, à tenir dès le premier jour. **Le
dossier de l'oplog ne peut pas commencer par un point** : Obsidian Sync exclut
tout dossier caché sauf `.obsidian`
([obsidian.md/help/sync/settings](https://obsidian.md/help/sync/settings)), donc
`.nbe/` y est invisible et le barreau 0 tombe pour ceux qui paient Obsidian Sync
— un nom visible le règle, et c'est le seul endroit où le chemin diffère du
desktop. **Le WASM n'est pas le mur qu'on croyait** : `loro-crdt` expose une
entrée `./base64` qui charge le module de façon synchrone, sans top-level await
(vérifié dans `node_modules`, 1.13.9), et Chrome a supprimé la limite de taille
de `WebAssembly.Module` en version 114
([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/nJw2zwaiJ2s/m/EYPgC5D3LwAJ)).
C'est un arbitrage de poids (~4,5 Mo contre un `main.js` de 339 ko), pas un mur.

## Ce qu'on décide de NE PAS écrire

Aucun serveur de signalisation, aucun STUN, aucun TURN, aucun compte, aucune
paire de clés d'appareil, aucun appairage par QR code, aucune ACL signée,
aucune reconnexion/backoff, aucun keepalive. Aucune bibliothèque de
chiffrement : `crypto.subtle` et CryptoKit sont dans le runtime, donc pas de
`@noble/*` ni de libsodium, et l'invariant CI reste vert sans discuter. Aucun
cadrage binaire maison pour l'oplog — c'est ce que « un blob par fichier »
supprime. Aucune modification de l'interface `Transport`. Aucun code de
présence : `createPresence` est écrit, testé et déjà monté dans
`examples/collab/src/main.ts:168`. Et surtout on ne supprime ni `webrtc.ts`
(351 lignes) ni `relay.ts` : ils sont le barreau 3.

## Rejeté, avec les raisons

- **iroh** — couvre une surface sur cinq (Tauri), casse le plancher OS Swift
  (macOS 14.5/iOS 17.5 contre `native/swift/Package.swift:15`), n'a plus de
  prebuild Mac Intel, est relay-only dans le navigateur sans paquet npm WASM
  ([docs.iroh.computer](https://docs.iroh.computer/deployment/wasm-browser-support)),
  et sa FAQ dit que derrière un pare-feu TCP-only tout repasse par le relais.
- **Nostr comme transport de deltas** — 80 octets deviennent 528 (×6,6) et les
  relais strfry stockent les événements dits éphémères, donc un secret fuité
  déchiffre rétroactivement.
- **MQTT public** — les brokers ne servent rien sur 443 (8081/8084/8884, et 443
  renvoie un 301) : échec direct de l'exigence pare-feu.
- **Relais entre pairs par flooding dédupliqué** — l'en-tête de 12 octets sur
  les canaux de données est un changement de protocole de fil que
  `native/swift/Sources/NbeSync/P2PTransport.swift:237` ne décadre pas, et il
  double la bande passante dans le cas sain.
- **Faire syncer le plugin Obsidian actuel** — ses ids de blocs sont par
  session par décision, pas par accident ; la sync appartient au second plugin,
  qui est un vault Carnet et non un éditeur (voir plus haut).
- **bugout, simple-peer** (morts depuis 2022), **p2pt** (sous-ensemble strict de
  Trystero), **gun** (un second modèle de conflits à côté de Loro),
  **hyperswarm** (Node/Bare, zéro navigateur), **@waku/sdk** (0.0.36, API
  instable) — aucun ne bat Trystero sur le seul critère qui compte ici.
- **libp2p Circuit Relay v2** — code vivant, aucune infrastructure publique :
  on héberge le relais, donc c'est notre relais en plus lourd.

## Incertain, signalé plutôt que deviné

- **iCloud et les dossiers commençant par un point.** Non vérifié, et
  potentiellement fatal : le mode d'échec attesté ailleurs est qu'iCloud renomme
  un `.git` en « git 2 ». Si `.nbe/` subit ça, le barreau 0 tombe sur macOS et
  iOS. **À tester avant la première ligne d'`oplog.ts`.**
- **Le taux réel de connexion directe entre deux réseaux domestiques.** Jamais
  mesuré : les deux e2e Trystero tournaient sur la même machine, donc candidats
  ICE hôtes. C'est le seul chiffre qui décide si « p2p sans serveur » est vrai
  ou publicitaire. La FAQ iroh annonce « roughly 9 out of 10 connections go
  direct » ([docs.iroh.computer](https://docs.iroh.computer/about/faq)), sur une
  population qui n'est pas la nôtre.
- **TURN gratuit sur 443.** Ce qui est mort, c'est le TURN public *anonyme* ;
  Metered annonce toujours 20 Go/mois derrière un compte gratuit et Cloudflare
  expose TURN en TLS/443, mais aucun endpoint n'était joignable depuis cette
  machine le 2026-08-09, ce qui ne prouve pas leur inexistence. Le barreau 4
  reste une hypothèse, pas un plan.
- **Tailscale DERP.** La citation qui le disqualifiait venait de la page « peer
  relays », pas de la page DERP : conclusion probablement juste, non démontrée.
- **Google Drive Desktop et OneDrive** (fichiers partiels, nommage des
  conflits), **`ws://` depuis un contexte sécurisé**, et **le contexte sécurisé
  de la webview Tauri sur Android** — wry#1709 dit qu'Android ne traite pas
  `http://tauri.localhost` comme sécurisé, donc pas de `crypto.subtle`. À
  vérifier avant de promettre le mobile.

## La revendication à tester, pas à affirmer

Deux appareils qui ne se sont jamais parlé convergent en échangeant uniquement
des noms de fichiers. C'est `packages/collab/test/oplog.test.ts` : deux
`LoroBlockStore`, deux `OplogFiles` distincts sur une `Map` qui ne transporte
aucun objet vivant, un fichier tronqué injecté au milieu, un
`x.sync-conflict-2026-….loro` et un `.syncthing.x.tmp` que le filtre doit
ignorer, une compaction faite par un seul des deux. Si ce test passe, le
barreau 0 est réel ; sinon tout le reste de ce document est un diagramme.

Le second, pour le chiffrement : `packages/collab/test/crypto.test.ts`, où un
pair **sans** la clé doit faire passer l'état en mismatch visible, pas
disparaître en silence. Et `e2e/p2p.spec.ts` reste ce qui prouve le barreau 1.
