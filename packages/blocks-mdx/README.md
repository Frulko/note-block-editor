# @nbe/blocks-mdx

Les composants MDX : **gardés, montrés, jamais évalués.**

```ts
import { mdx } from '@nbe/blocks-mdx/dom'
new EditorView(el, editor, { blocks: [mdx] })
```

La décision d'abord, parce que tout le reste en découle : **ça n'exécute rien.**
MDX, c'est du Markdown avec du JSX dedans, et évaluer du JSX demande un runtime
de composants, un compilateur, et du code arbitraire venu d'un fichier qu'on
vous a donné — dans un éditeur dont toute la promesse est que vos notes sont des
fichiers lisibles sans lui. Même réponse que pour l'intégration HTML, pour la
même raison.

Ce que ça apporte, et c'est ce qui manquait vraiment : **un fichier `.mdx`
s'ouvre ici et se referme octet pour octet identique.** Sans ça, une balise de
composant est de la prose — `<Callout type="warning">` devient un paragraphe,
ses chevrons sont échappés à l'enregistrement, et le fichier cesse d'être du
MDX.

La majuscule est la règle de JSX elle-même : `<div>` reste de la prose, que le
Markdown porte déjà très bien, et `<Callout>` devient un bloc.

Un hôte qui veut vraiment *rendre* un composant enregistre son propre greffon
pour ce type et il n'arrive plus jamais ici : ceci est le repli, pas le plafond.
