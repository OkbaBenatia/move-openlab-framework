/** French: export of ML evaluation evidence and its display after import. Key = the exact English text passed to tr(). */
const text: Record<string, string> = {
  'ML evaluation evidence': 'Preuves d’évaluation ML',
  '{n} documents': '{n} documents',
  'Imported predictions and labels of the learned methods, with their dataset, split, population, decision, model and feature-pipeline provenance and the metric definitions.':
    'Prédictions et étiquettes importées des méthodes apprises, avec leur provenance (jeu de données, partition, population, décision, modèle, chaîne de caractéristiques) et la définition des métriques.',
  'Include the evidence': 'Inclure les preuves',
  'References only': 'Références seulement',
  'Leave out': 'Ne pas inclure',
  'The receiver re-validates the evidence and recomputes every figure (confusion matrix, metrics, threshold curve).':
    'Le destinataire revalide les preuves et recalcule chaque valeur (matrice de confusion, métriques, courbe de seuil).',
  'Only provenance, decision, metric definitions, recorded figures and SHA-256: the receiver sees them marked as not recomputable. Use this when the predictions or labels may not be shared.':
    'Seulement la provenance, la décision, la définition des métriques, les valeurs enregistrées et le SHA-256 : le destinataire les voit marquées comme non recalculables. À utiliser quand les prédictions ou les étiquettes ne peuvent pas être partagées.',
  'The receiver gets no ML evaluation for these records.': 'Le destinataire ne reçoit aucune évaluation ML pour ces enregistrements.',
  '{n} of them came to you as references only: they can only be passed on as references.': '{n} d’entre eux vous sont parvenus comme références seulement : ils ne peuvent être transmis que comme références.',
  'An installation older than this version cannot read a bundle with this section; it says so and imports nothing.':
    'Une installation antérieure à cette version ne peut pas lire une archive contenant cette section ; elle le signale et n’importe rien.',
  'reference received with a bundle': 'référence reçue avec une archive',
  'not recomputable here': 'non recalculable ici',
  'Received as a reference: the predictions and labels were not included in the bundle, so these figures are the exporter’s and cannot be recomputed here.':
    'Reçue comme référence : les prédictions et les étiquettes n’étaient pas dans l’archive ; ces valeurs sont celles de l’exportateur et ne peuvent pas être recalculées ici.',
  '{n} documents re-validated, every figure recomputed and identical': '{n} documents revalidés, chaque valeur recalculée et identique',
  '{n} references only: figures as recorded by the exporter, not recomputable here': '{n} références seulement : valeurs enregistrées par l’exportateur, non recalculables ici',
  '{n} document re-validated, every figure recomputed and identical': '{n} document revalidé, chaque valeur recalculée et identique',
  '{n} reference only: figures as recorded by the exporter, not recomputable here': '{n} référence seulement : valeurs enregistrées par l’exportateur, non recalculables ici',
};

export default text;
