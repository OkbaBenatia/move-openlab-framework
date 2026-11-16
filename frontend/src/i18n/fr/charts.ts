/** French: the private-research context, the shared "Choose metrics" selection, chart selection and export, the CO₂
 *  card of a problem without the platform's CO₂ calculation. Key = the exact English text passed to tr(). */
const charts: Record<string, string> = {
  // private-research context
  'Private Research context': 'Contexte Recherche privée',
  'restricted records, shown to your account only': 'enregistrements restreints, affichés pour votre compte uniquement',
  'Studies and history': 'Études et historique',
  'Exit to Workspace': 'Quitter vers l’espace de travail',
  'Private Research workspace': 'Espace de travail Recherche privée',
  'Exit Private Research': 'Quitter la Recherche privée',
  'Exit Private Research and return to the public Workspace?': 'Quitter la Recherche privée et revenir à l’espace de travail public ?',
  'The public Workspace opens on a public experiment. Private selections, map layers and results leave the screen; nothing is deleted or changed.':
    'L’espace de travail public s’ouvre sur une expérience publique. Les sélections, couches de carte et résultats privés quittent l’écran ; rien n’est supprimé ni modifié.',
  // one metric selection
  'Mobility and CO₂': 'Mobilité et CO₂',
  'Tick the metrics to show. The same choice applies to the Workspace results, Compare › Methods, Compare › Experiments, the charts and the exported tables of this problem. Hover a metric for its definition and how it is aggregated.':
    'Cochez les métriques à afficher. Le même choix s’applique aux résultats de l’espace de travail, à Comparer › Méthodes, à Comparer › Expériences, aux graphiques et aux tableaux exportés de ce problème. Survolez une métrique pour sa définition et son agrégation.',
  selection: 'sélection',
  'Select all': 'Tout sélectionner',
  'Deselect all': 'Tout désélectionner',
  'Reset to defaults': 'Rétablir les valeurs par défaut',
  '{n} of {m} selected': '{n} sur {m} sélectionnées',
  'Keep this choice for my account': 'Conserver ce choix pour mon compte',
  'Otherwise it applies until you close this browser tab.': 'Sinon, il s’applique jusqu’à la fermeture de cet onglet.',
  'Select at least one metric.': 'Sélectionnez au moins une métrique.',
  'Choose the metrics shown here, in Compare and in the charts': 'Choisir les métriques affichées ici, dans Comparer et dans les graphiques',
  'count over {n} scenarios': 'décompte sur {n} scénarios',
  'Validated runs': 'Exécutions validées',
  'Runs accepted by the independent validator, out of the runs executed. The validator checks every solution; the method does not.':
    'Exécutions acceptées par le validateur indépendant, sur les exécutions réalisées. Le validateur vérifie chaque solution ; la méthode ne le fait pas.',
  'Repetitions identical': 'Répétitions identiques',
  'Whether every repetition of a run gave the same validated result (runtimes are not required to match).':
    'Indique si toutes les répétitions d’une exécution ont donné le même résultat validé (les temps d’exécution n’ont pas à coïncider).',
  yes: 'oui',
  no: 'non',
  // Compare: the two kinds
  'Methods: different algorithms on the same matched scenarios.': 'Méthodes : des algorithmes différents sur les mêmes scénarios appariés.',
  'Experiments: separate experiments with each other — controlled variants, imported results, reproductions.':
    'Expériences : des expériences distinctes entre elles — variantes contrôlées, résultats importés, reproductions.',
  // charts: selection and export
  'select {title} for export': 'sélectionner {title} pour l’export',
  'Select this chart for a combined export': 'Sélectionner ce graphique pour un export groupé',
  'The data of this chart': 'Les données de ce graphique',
  'This chart as an image, with its title and legend': 'Ce graphique en image, avec son titre et sa légende',
  'This chart as a vector image, with its title and legend': 'Ce graphique en image vectorielle, avec son titre et sa légende',
  'one value per scenario ({n} scenarios)': 'une valeur par scénario ({n} scénarios)',
  'Select at least one chart to export.': 'Sélectionnez au moins un graphique à exporter.',
  '{n} charts exported: one ZIP with a PNG, an SVG and a CSV per chart, and a manifest.': '{n} graphiques exportés : un ZIP avec un PNG, un SVG et un CSV par graphique, et un manifeste.',
  'The export failed: the browser could not draw a chart image.': 'L’export a échoué : le navigateur n’a pas pu dessiner l’image d’un graphique.',
  'export charts': 'exporter des graphiques',
  '{n} of {m} charts selected': '{n} graphiques sélectionnés sur {m}',
  'Select all charts': 'Sélectionner tous les graphiques',
  'Clear selection': 'Effacer la sélection',
  'One ZIP: a PNG, an SVG and a CSV per selected chart, and a manifest with titles, metrics, units, scope, methods and provenance':
    'Un ZIP : un PNG, un SVG et un CSV par graphique sélectionné, et un manifeste avec titres, métriques, unités, périmètre, méthodes et provenance',
  'Tick the charts to export (the box before each title), or Select all charts': 'Cochez les graphiques à exporter (la case devant chaque titre), ou Sélectionner tous les graphiques',
  'Export selected (ZIP)': 'Exporter la sélection (ZIP)',
  'Exporting…': 'Export en cours…',
  // CO₂ where the platform's calculation is not configured
  'The platform’s CO₂ calculation is not configured for this problem: its scenarios carry no vehicle energy profiles. No value is shown and none is assumed; nothing is copied from another experiment.':
    'Le calcul de CO₂ de la plateforme n’est pas configuré pour ce problème : ses scénarios ne portent aucun profil énergétique de véhicule. Aucune valeur n’est affichée ni supposée ; rien n’est copié d’une autre expérience.',
  'Reported by the formulation itself, not computed by the platform.': 'Rapporté par la formulation elle-même, non calculé par la plateforme.',
};

export default charts;
