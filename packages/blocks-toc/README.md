# @nbe/blocks-toc

La table des matières : un bloc dont le contenu **est** le document.

```ts
import { toc } from '@nbe/blocks-toc/dom'
new EditorView(el, editor, { blocks: [toc] })
```

Tous les autres blocs possèdent leur texte. Celui-ci n'en possède aucun — il lit
les titres de la page et rend des liens vers eux, donc il change quand *autre
chose* change. C'est ce qui en fait un cas intéressant pour l'API de greffons,
et la raison d'être de `ProjectionContext.page` : une projection qui rend un
bloc isolément ne peut pas construire la liste des autres.

Les ancres sont les identifiants de blocs, ceux que l'export HTML émet déjà —
un slug du titre se lirait mieux dans une URL, mais il entre en collision sur
deux titres identiques et se déplace dès qu'on reformule le titre, ce qui casse
silencieusement les liens qui pointaient dessus.

En Markdown, le bloc s'écrit `[TOC]` sur une ligne — l'orthographe de
Python-Markdown, comprise par la plupart des générateurs de sites statiques.

Sans DOM :

```ts
import { tocBlocks, tocEntries } from '@nbe/blocks-toc'
```
