# Carnet

Une application de notes dont le stockage est un dossier que vous pouvez lire.

```bash
pnpm --filter @nbe/desktop app        # lancer en développement
pnpm --filter @nbe/desktop app:build  # produire un bundle
```

## Ce que contient le dossier

Vous choisissez un dossier au premier lancement. Il est ensuite rouvert seul.

```
mon-carnet/
  pages/                  ← le vault Markdown : c'est ça que vous lisez
    Projets.md
    Projets/
      Éditeur.md
  .nbe/                   ← les documents canoniques, en JSON
    019fdbe8-….json
    collections.json      ← schémas et vues des bases de données
```

`pages/` **est** un vault Obsidian : ouvrez-le dans Obsidian et tout est là,
la hiérarchie étant l'arborescence des dossiers.

## Pourquoi deux copies

Parce que le Markdown est une *projection*, pas un format de stockage — c'est
la décision D7 de `docs/ARCHITECTURE.md`, et elle a des pertes documentées : le
Markdown ne sait pas écrire un bloc vide, et il replie volontairement les
paragraphes coupés à la main. Si le Markdown était la seule copie, ces pertes
s'accumuleraient à chaque enregistrement.

Le JSON fait donc foi et le Markdown est **régénéré**. En échange, le Markdown
est toujours sûr à lire, à éditer et à comparer dans un `git diff`. Obsidian
ignore les dossiers commençant par un point, donc `.nbe/` ne le dérange pas.

## Les bases de données

Une base est quatre enregistrements (§2.5), jamais un seul : un **bloc de vue**
la place dans une page, une **vue** porte la mise en page et les filtres, un
**schéma** porte les propriétés typées, et **chaque ligne est une page**.

C'est pour ça qu'une ligne s'ouvre comme n'importe quelle autre page, et qu'elle
n'apparaît pas dans l'arbre : elle appartient à sa table. Les lignes ne sont
listées nulle part — une page appartient à une collection parce que ses propres
propriétés le disent, et c'est le seul endroit où c'est écrit.

## Voir l'interface sans construire l'application

```bash
pnpm --filter @nbe/desktop dev   # http://localhost:5174
```

Hors de Tauri, il n'y a pas de système de fichiers : l'application ouvre alors
un espace de travail **temporaire, en mémoire**, et le dit. Ce n'est pas une
commodité — c'est ce qui rend l'interface observable. Un curseur qui tombait au
mauvais endroit a été signalé et n'a pas pu être reproduit, faute d'un endroit
où un test pouvait atteindre cette interface.

## Si quelque chose ne marche pas

L'application le dit. Toute erreur s'affiche en bas à droite, en rouge, et y
reste jusqu'au message suivant — cliquez dessus pour la fermer. Il n'y a aucun
chemin où il ne se passe simplement rien : c'est le défaut trouvé au premier
essai, et le plus coûteux, parce qu'il rendait tous les autres invisibles.

## Ce que l'application n'ajoute pas

Presque rien, et c'est voulu. L'arbre des pages, la recherche, les backlinks,
la projection Markdown et les importateurs sont dans `@nbe/workspace` ; l'éditeur
est `@nbe/dom`. La seule pièce propre au bureau est `src/storage.ts` : les
quatre méthodes de `WorkspaceStorage`, au-dessus du système de fichiers de
Tauri, avec la même écriture atomique (fichier temporaire puis `rename`) que la
CLI — pour qu'un lecteur, y compris Obsidian ou un client de synchronisation
qui surveille le dossier, voie l'ancienne page ou la nouvelle, jamais une page
tronquée.

Côté Rust il n'y a aucune logique métier : trois plugins enregistrés, dont
`persisted-scope` **après** `fs`, pour que l'autorisation accordée par le
sélecteur de dossier survive à un redémarrage.
