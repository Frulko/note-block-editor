# NbeModel

Le format de document, lu par une seconde implémentation.

```bash
cd native/swift && swift test
```

## Ce que ça prouve, et pourquoi ça vaut d'exister

`docs/ARCHITECTURE.md` §9 affirme que le contrat de store « sert de
spécification qu'un portage Swift reproduit », et §4 que « les types et les
propriétés inconnus font l'aller-retour intacts ». Ce sont deux affirmations
sur la portabilité, et **aucune n'avait jamais été vérifiée hors de
TypeScript**.

La fixture `Tests/NbeModelTests/document.json` est écrite par l'éditeur
lui-même. Les deux implémentations sont donc confrontées l'une à l'autre, et
non à l'idée qu'un auteur se fait du format.

Le test qui compte le plus est celui du bloc inconnu. `Codable` jette les clés
qu'on ne lui a pas déclarées — c'est le comportement par défaut, et il briserait
§4 en silence : ouvrir un document dans un client plus ancien en supprimerait
des morceaux. Les propriétés ne sont donc pas une structure typée mais un
`JSONValue`, qui garde ce qu'il a reçu.

Deuxième piège, plus discret : `1` qui ressort en `1.0`. C'est un autre document
pour n'importe quel lecteur, et c'est ce que fait un aller-retour par `Double`.

## Ce que ce n'est pas

Un éditeur. Pas de vues TextKit 2, pas de chrome SwiftUI, pas de `loro-swift` —
tout ça demande un projet d'application et un appareil. Ce qui est ici est la
couche que ces interfaces liraient, et la seule partie qu'on peut vérifier sans
en construire une.

Aucune dépendance, délibérément : ce paquet existe pour montrer que le format
n'en réclame pas. Un portage qui exigerait une bibliothèque JSON de notre choix
prouverait quelque chose sur cette bibliothèque.
