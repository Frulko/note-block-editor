# @nbe/blocks-mermaid

Les diagrammes Mermaid, dessinés depuis le bloc de code qui les contient déjà.

```ts
import { mermaidStyles } from '@nbe/blocks-mermaid'
import { mermaidFeature } from '@nbe/blocks-mermaid/dom'

new EditorView(el, editor, { features: [...defaultFeatures, mermaidFeature] })
```

**Aucun nouveau type de bloc, aucun changement du format de fichier.**
` ```mermaid ` est la façon dont tous les outils Markdown écrivent un diagramme,
et cet éditeur en fait déjà un bloc de code dont le `language` est `mermaid` —
qui fait déjà l'aller-retour octet pour octet. Un bloc `mermaid` dédié se serait
battu avec le bloc de code pour la même clôture, pour rien.

C'est donc une *feature*, pas un greffon : elle repère ces blocs et dessine à
côté de la source. Le SVG vit **hors** de la zone éditable, exactement comme les
couleurs de syntaxe — le curseur, l'IME et le réconciliateur DOM→modèle
n'apprennent jamais qu'un diagramme est à l'écran.

Trois modes, stockés dans les props du bloc de code : `preview`, `code`,
`both` (défaut).

## La dépendance

`mermaid` est une **peer dependency optionnelle, importée à la première
utilisation**. Une page sans diagramme ne paie rien ; un hôte qui ne l'installe
pas obtient un bloc de code ordinaire et aucune erreur. C'est le même marché que
les grammaires de coloration, et la seule raison pour laquelle une bibliothèque
de 2 Mo peut être proposée dans un projet qui refuse les dépendances réseau à
l'exécution.
