import { PluginSettingTab, Setting, type App } from 'obsidian';
import {
  LOCALE_NAMES,
  debugFeature,
  defaultFeatures,
  exportFeature,
  findFeature,
  labelsFor,
  stickyFormatToolbarFeature,
  TYPEFACES,
  wordCountFeature,
  type EditorViewOptions,
} from '@nbe/dom';
import { CODE_THEMES } from '@nbe/blocks-code';
import { mermaidFeature } from '@nbe/blocks-mermaid/dom';
import { floatingTocFeature } from '@nbe/blocks-toc/dom';
import { BLOCKS } from './document';
import type CarnetPlugin from './main';

/**
 * The vault settings, and the tab that edits them.
 *
 * @module
 */

/**
 * Everything data-shaped in {@link EditorViewOptions}, as vault settings.
 * The function-shaped options (page hosts, assets, topology, recognizers,
 * custom blocks, labels) are code, not settings, and stay out.
 */
export interface CarnetSettings {
  maxWidth: string;
  padTop: string;
  padBottom: string;
  padX: string;
  spellcheck: boolean;
  columns: boolean;
  readOnly: boolean;
  /** Open every Markdown file in Carnet instead of Obsidian's editor. */
  defaultEditor: boolean;
  /**
   * Which way the token layer points: follow the vault, or force one.
   *
   * A vault theme that is dark on some pages and light on others is not
   * exotic — a print stylesheet, a light snippet on a dark theme — and a
   * reader who wants the editor light regardless had no way to say so.
   */
  themeMode: 'vault' | 'light' | 'dark';
  /**
   * Take the vault theme's palette — ink, rules, accent, hover — or keep
   * Carnet's. The paper and the faces follow the vault either way.
   */
  vaultPalette: boolean;
  /** Which syntax palette code blocks use. See `CODE_THEMES`. */
  codeTheme: string;
  /** The face the prose is set in. See `TYPEFACES`. */
  typeface: string;
  /** Pin the format bar above the note instead of floating it over a selection. */
  stickyToolbar: boolean;
  /** The editor's interface language. `LOCALE_NAMES` lists what ships. */
  locale: string;
  /** Comments, kept in the note itself as Obsidian comment syntax. */
  comments: boolean;
  /** One CSS custom property per line: `--nbe-accent-rgb: 220 38 38`. */
  theme: string;
  /** Chrome features toggled off, by feature name; absent means on. */
  features: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: CarnetSettings = {
  maxWidth: '',
  padTop: '',
  padBottom: '',
  padX: '',
  spellcheck: false,
  columns: false,
  readOnly: false,
  defaultEditor: false,
  themeMode: 'vault',
  vaultPalette: true,
  codeTheme: 'one',
  typeface: 'sans',
  stickyToolbar: false,
  // the vault is most likely French if this plugin is installed; the editor's
  // own default is English and every other language is one setting away
  locale: 'fr',
  comments: true,
  theme: '',
  features: {},
};

/**
 * The chrome features a user may sensibly turn off; the input core stays.
 *
 * `on: false` makes one opt-*in* instead. Absent from the saved settings means
 * this default, not "enabled" — a floating outline over every note is a
 * preference, and the wrong one to impose on someone who never asked.
 */
const OPTIONAL_FEATURES: ReadonlyArray<{ name: string; label: string; desc: string; on?: boolean }> = [
  { name: 'slash-menu', label: 'Menu slash', desc: 'Le menu d’insertion ouvert en tapant « / ».' },
  { name: 'mentions', label: 'Mentions', desc: 'L’autocomplétion ouverte en tapant « @ ».' },
  { name: 'gutter', label: 'Gouttière', desc: 'Le bouton + et la poignée de glisser-déposer au survol.' },
  { name: 'format-toolbar', label: 'Barre de mise en forme', desc: 'La barre flottante sur une sélection de texte.' },
  { name: 'block-toolbar', label: 'Barre de bloc', desc: 'La barre d’outils par bloc au survol.' },
  { name: 'link-hover', label: 'Carte de lien', desc: 'La carte d’édition au survol d’un lien.' },
  { name: 'database', label: 'Bases de données', desc: 'Les vues de base de données interactives.' },
  { name: 'find', label: 'Recherche ⌘F', desc: 'Rechercher dans la note ouverte, surlignage des résultats.' },
  { name: 'export', label: 'Export ⌘P', desc: 'Markdown, texte ou impression PDF de la note ouverte.' },
  { name: 'word-count', label: 'Compteur de mots', desc: 'Mots, caractères et temps de lecture sous la note.' },
  { name: 'mermaid', label: 'Diagrammes Mermaid', desc: 'Dessine les blocs ```mermaid, avec Aperçu / Code / Les deux.' },
  {
    name: 'debug-hold',
    label: 'Figer le chrome (⌥⇧D)',
    desc: 'Outil de mise au point : ⌥⇧D fige la gouttière, la barre et les menus ouverts pour pouvoir les inspecter. Échap libère.',
    on: false,
  },
  {
    name: 'floating-toc',
    label: 'Sommaire flottant',
    desc: 'Les titres de la note, derrière un bouton en bas à droite : le panneau souligne la section en cours de lecture et suit le défilement.',
    on: false,
  },
];

/** Whether a feature is on: the saved setting, else the feature's own default. */
function featureOn(s: CarnetSettings, name: string): boolean {
  return s.features[name] ?? OPTIONAL_FEATURES.find((f) => f.name === name)?.on ?? true;
}

/** Project the vault settings onto the editor's options, defaults preserved. */
export function viewOptions(s: CarnetSettings): EditorViewOptions {
  const opts: EditorViewOptions = {
    labels: labelsFor(s.locale),
    spellcheck: s.spellcheck,
    columns: s.columns,
    readOnly: s.readOnly,
    // the table is a plugin: without it a note's `| a | b |` stays a paragraph
    blocks: BLOCKS,
  };
  // readOnly's default is "no features at all"; only pick features when editing
  /*
   * `findFeature` is not in the defaults — in a browser `⌘F` belongs to the
   * browser. A pane is not a browser window: there is no page find to take
   * here, so this host offers it and lets the setting turn it off.
   */
  if (!s.readOnly)
    opts.features = [
      ...defaultFeatures,
      findFeature,
      exportFeature,
      wordCountFeature,
      mermaidFeature,
      floatingTocFeature,
      debugFeature,
    ]
      .map((f) =>
        // the *same* bar, pinned rather than floating — swapped in rather than
        // added, because two bars offering the same seven marks is not a
        // configuration anyone meant to choose
        s.stickyToolbar && f.name === 'format-toolbar' ? stickyFormatToolbarFeature : f,
      )
      .filter((f) => featureOn(s, f.name === 'sticky-format-toolbar' ? 'format-toolbar' : f.name));
  if (s.maxWidth.trim()) opts.maxWidth = s.maxWidth.trim();
  const padding: { top?: string; bottom?: string; x?: string } = {};
  if (s.padTop.trim()) padding.top = s.padTop.trim();
  if (s.padBottom.trim()) padding.bottom = s.padBottom.trim();
  if (s.padX.trim()) padding.x = s.padX.trim();
  if (Object.keys(padding).length) opts.padding = padding;
  const theme: Record<string, string> = {};
  for (const line of s.theme.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) theme[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (Object.keys(theme).length) opts.theme = theme;
  return opts;
}

export class CarnetSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CarnetPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Commentaires')
      .setDesc('Commenter un bloc depuis la marge droite. Les fils sont écrits dans la note elle-même, en syntaxe de commentaire Obsidian (%%…%%) — invisibles en mode lecture, et ils voyagent avec le fichier.')
      .addToggle((t) =>
        t.setValue(s.comments).onChange((v) => {
          s.comments = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Langue')
      .setDesc('La langue de l’interface de l’éditeur — menus, infobulles, messages. Elle ne touche pas au contenu des notes.')
      .addDropdown((d) =>
        d
          .addOptions(LOCALE_NAMES)
          .setValue(s.locale)
          .onChange((v) => {
            s.locale = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Thème')
      .setDesc('Carnet suit le thème du coffre par défaut. Forcer clair ou sombre change l’éditeur et son chrome flottant, sans toucher au reste d’Obsidian.')
      .addDropdown((d) =>
        d
          .addOptions({ vault: 'Suivre le coffre', light: 'Clair', dark: 'Sombre' })
          .setValue(s.themeMode)
          .onChange((v) => {
            s.themeMode = v as CarnetSettings['themeMode'];
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Couleurs du coffre')
      .setDesc(
        'Prend l’encre, les filets, l’accent et le survol du thème du coffre. Désactivé, Carnet garde sa propre palette — le papier et les polices suivent le coffre dans les deux cas. Le code en ligne garde toujours sa teinte : celle du coffre le rendrait identique au texte autour.',
      )
      .addToggle((t) =>
        t.setValue(s.vaultPalette).onChange((v) => {
          s.vaultPalette = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Coloration du code')
      .setDesc('La palette des blocs de code. Chaque thème a sa version claire et sa version sombre ; celle qui s’applique suit le thème ci-dessus.')
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(CODE_THEMES.map((t) => [t.id, t.label])))
          .setValue(s.codeTheme)
          .onChange((v) => {
            s.codeTheme = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Barre de mise en forme fixe')
      .setDesc(
        'Épingle la barre au-dessus de la note, à la manière des éditeurs WYSIWYG, au lieu de la faire flotter sur la sélection. Sans rien de sélectionné, les boutons de marque sont grisés : ce qu’ils appliqueraient n’existe pas encore.',
      )
      .addToggle((t) =>
        t.setValue(s.stickyToolbar).onChange((v) => {
          s.stickyToolbar = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Typographie')
      .setDesc(
        'La police du texte de la note. Les blocs de code restent en chasse fixe quoi qu’il arrive : un listing dans une police à chasse variable est un listing dont les colonnes ne s’alignent plus.',
      )
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(TYPEFACES.map((t) => [t.id, t.label])))
          .setValue(s.typeface)
          .onChange((v) => {
            s.typeface = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Éditeur par défaut')
      .setDesc('Ouvre les fichiers Markdown dans Carnet plutôt que dans l’éditeur d’Obsidian. « Revenir à l’éditeur Markdown » reste disponible fichier par fichier.')
      .addToggle((t) =>
        t.setValue(s.defaultEditor).onChange((v) => {
          s.defaultEditor = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Largeur du texte')
      .setDesc('Largeur maximale de la colonne de texte. Vide = 708px (Notion) ; « 100% » désactive le centrage.')
      .addText((t) =>
        t.setPlaceholder('708px').setValue(s.maxWidth).onChange((v) => {
          s.maxWidth = v;
          save();
        }),
      );

    const pads: Array<[keyof CarnetSettings & ('padTop' | 'padBottom' | 'padX'), string]> = [
      ['padTop', 'Marge haute'],
      ['padBottom', 'Marge basse'],
      ['padX', 'Marges latérales'],
    ];
    for (const [key, name] of pads) {
      new Setting(containerEl)
        .setName(name)
        .setDesc('Toute valeur CSS ; vide = défaut de l’éditeur.')
        .addText((t) =>
          t.setPlaceholder('ex. 24px').setValue(s[key]).onChange((v) => {
            s[key] = v;
            save();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Correction orthographique')
      .setDesc('Demande au navigateur de vérifier l’orthographe dans l’éditeur.')
      .addToggle((t) =>
        t.setValue(s.spellcheck).onChange((v) => {
          s.spellcheck = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Colonnes par glisser-déposer')
      .setDesc('Expérimental : déposer un bloc à côté d’un autre crée deux colonnes.')
      .addToggle((t) =>
        t.setValue(s.columns).onChange((v) => {
          s.columns = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Lecture seule')
      .setDesc('Affiche les notes sans permettre de les modifier.')
      .addToggle((t) =>
        t.setValue(s.readOnly).onChange((v) => {
          s.readOnly = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Fonctionnalités').setHeading();
    for (const f of OPTIONAL_FEATURES) {
      new Setting(containerEl)
        .setName(f.label)
        .setDesc(f.desc)
        .addToggle((t) =>
          t.setValue(featureOn(s, f.name)).onChange((v) => {
            s.features[f.name] = v;
            save();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Thème')
      .setDesc('Variables CSS du token layer, une par ligne. Ex. : --nbe-accent-rgb: 220 38 38')
      .addTextArea((t) =>
        t.setPlaceholder('--nbe-accent-rgb: 220 38 38\n--nbe-radius: 2px').setValue(s.theme).onChange((v) => {
          s.theme = v;
          save();
        }),
      );
  }
}
