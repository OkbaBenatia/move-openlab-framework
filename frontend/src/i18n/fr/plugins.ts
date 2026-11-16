/** French: plugins. Key = the exact English text passed to tr(). */
const text: Record<string, string> = {
  // + Add method: catalogue
  'Ready-made, provided or uploaded': 'Prêts à l’emploi, fournis ou téléversés',
  'Write, upload, register': 'Écrire, téléverser, enregistrer',
  'Plug-ins you can register for this problem': 'Greffons que vous pouvez enregistrer pour ce problème',
  'Ready-made examples': 'Exemples prêts à l’emploi',
  'Provided on this installation': 'Fournis sur cette installation',
  'Uploaded by you': 'Téléversés par vous',
  'Select Details to inspect a plug-in and check its compatibility (nothing is executed); Register runs its self-test in the sandbox and pins its code.':
    'Choisissez Détails pour examiner un greffon et vérifier sa compatibilité (rien n’est exécuté) ; Enregistrer lance son auto-test dans le bac à sable et fige son code.',
  'None yet — create one from the template, then upload it here.': 'Aucun pour l’instant — créez-en un à partir du modèle, puis téléversez-le ici.',
  'Available, not registered': 'Disponible, non enregistré',
  'Changed': 'Modifié',
  'Check compatibility': 'Vérifier la compatibilité',
  'Static check — nothing was executed.': 'Vérification statique — rien n’a été exécuté.',
  'Method id': 'Identifiant de méthode',
  'Registered code': 'Code enregistré',
  'details of {name}': 'détails de {name}',
  'Plug-ins are off on this installation.': 'Les greffons sont désactivés sur cette installation.',
  'Already registered: {id}. Registering the same method id and version again is refused — change the version to register changed code.':
    'Déjà enregistré : {id}. Enregistrer à nouveau le même identifiant et la même version est refusé — changez la version pour enregistrer un code modifié.',
  'Registered version differs from the file: {id} is pinned to other code. It is not replaced — change the version to register the new code.':
    'La version enregistrée diffère du fichier : {id} est figé sur un autre code. Il n’est pas remplacé — changez la version pour enregistrer le nouveau code.',
  '{id} is already registered from another plug-in — change the version.': '{id} est déjà enregistré depuis un autre greffon — changez la version.',
  // checks and upload
  'check steps': 'étapes de vérification',
  'ok': 'ok',
  'not run yet': 'pas encore lancé',
  'ZIP checked': 'ZIP vérifié',
  'Metadata (read without running the code)': 'Métadonnées (lues sans exécuter le code)',
  'Not registered yet': 'Pas encore enregistré',
  'Self-test in the sandbox': 'Auto-test dans le bac à sable',
  'Running in the sandbox…': 'Exécution dans le bac à sable…',
  'Choose a .zip file.': 'Choisissez un fichier .zip.',
  'The file is empty.': 'Le fichier est vide.',
  'The ZIP is larger than the limit.': 'Le ZIP dépasse la taille autorisée.',
  'Upload the completed plug-in (.zip)': 'Téléverser le greffon terminé (.zip)',
  'plug-in ZIP to upload': 'ZIP du greffon à téléverser',
  'upload result': 'résultat du téléversement',
  'code': 'code',
  'One directory <name>/ with plugin.py and small text files only (test_plugin.py, README.md, LICENSE). Checked before anything is stored and nothing is executed; stored in your workspace only, visible to no other account; runs only in the verified sandbox.':
    'Un seul dossier <nom>/ contenant plugin.py et de petits fichiers texte seulement (test_plugin.py, README.md, LICENSE). Vérifié avant tout enregistrement, sans rien exécuter ; stocké dans votre espace uniquement, invisible pour les autres comptes ; exécuté seulement dans le bac à sable vérifié.',
  'Identical to a plug-in you already uploaded: nothing was changed.': 'Identique à un greffon déjà téléversé : rien n’a changé.',
  'Register needs every check above to pass.': 'L’enregistrement exige que toutes les vérifications ci-dessus réussissent.',
  'Uploads need the verified sandbox; this installation runs plug-ins in trusted-process mode (administrators only, folder plug-ins only).':
    'Le téléversement exige le bac à sable vérifié ; cette installation exécute les greffons en mode processus de confiance (administrateurs seulement, greffons du dossier seulement).',
  // template
  'The platform does not write your algorithm or train a model: you implement solve(instance, config) yourself. The platform checks it, runs it in the sandbox and validates every solution independently.':
    'La plateforme n’écrit pas votre algorithme et n’entraîne aucun modèle : vous implémentez vous-même solve(instance, config). La plateforme le vérifie, l’exécute dans le bac à sable et valide chaque solution de façon indépendante.',
  'Not the problem of the open experiment: you can register it, and run it on an experiment of that problem.':
    'Ce n’est pas le problème de l’expérience ouverte : vous pouvez l’enregistrer et l’exécuter sur une expérience de ce problème.',
  'Describe your method': 'Décrivez votre méthode',
  'Display name': 'Nom affiché',
  'display name': 'nom affiché',
  'author': 'auteur',
  'kind': 'type',
  'Short description': 'Description courte',
  'short description': 'description courte',
  'The rule your method follows, in one sentence.': 'La règle suivie par votre méthode, en une phrase.',
  'Name: 3 to 41 characters, lowercase letters, digits and _, starting with a letter.': 'Nom : 3 à 41 caractères, minuscules, chiffres et _, commençant par une lettre.',
  'Method id {id}, version 0.1.0.': 'Identifiant de méthode {id}, version 0.1.0.',
  'Generate and download': 'Générer et télécharger',
  'Generate the template (.zip)': 'Générer le modèle (.zip)',
  'Downloaded {file} ({bytes} bytes): plugin.py, test_plugin.py, README.md': '{file} téléchargé ({bytes} octets) : plugin.py, test_plugin.py, README.md',
  'The template was not generated: {reason}': 'Le modèle n’a pas été généré : {reason}',
  'Implement solve(instance, config) in plugin.py': 'Implémentez solve(instance, config) dans plugin.py',
  'instance': 'instance',
  'return': 'retour',
  'As generated, solve() returns no decision: the result is valid but serves no one, so it passes the self-test without being a method. Implement your rule before you register it. README.md explains how to test and check it.':
    'Tel que généré, solve() ne renvoie aucune décision : le résultat est valide mais ne sert personne ; il passe donc l’auto-test sans être une méthode. Implémentez votre règle avant de l’enregistrer. README.md explique comment le tester et le vérifier.',
  'Upload the completed plug-in': 'Téléversez le greffon terminé',
  'Register, run, compare': 'Enregistrer, exécuter, comparer',
  'Register runs the self-test in the sandbox and pins the code. Run with this method runs it on the frozen scenarios of the open experiment; every solution is validated independently. Then Compare shows it next to the other methods. A valid solution is not an optimal one.':
    'Enregistrer lance l’auto-test dans le bac à sable et fige le code. Exécuter avec cette méthode la lance sur les scénarios figés de l’expérience ouverte ; chaque solution est validée de façon indépendante. Comparer la montre ensuite à côté des autres méthodes. Une solution valide n’est pas une solution optimale.',
  // developer details
  'Each step has a command-line equivalent (the same template and the same checks):': 'Chaque étape a son équivalent en ligne de commande (même modèle, mêmes vérifications) :',
  'Generate the template:': 'Générer le modèle :',
  'Test solve() locally:': 'Tester solve() en local :',
  'Metadata check and sandboxed self-test (what Register does):': 'Vérification des métadonnées et auto-test dans le bac à sable (ce que fait Enregistrer) :',
  'Run on every scenario of an exported experiment, validated and compared (Run with this method, then Compare):':
    'Exécuter sur chaque scénario d’une expérience exportée, avec validation et comparaison (Exécuter avec cette méthode, puis Comparer) :',
  'Make the ZIP to upload:': 'Créer le ZIP à téléverser :',
  'Operator alternative to uploading: copy the directory into the approved folder.': 'Alternative pour l’opérateur : copier le dossier dans le dossier approuvé.',
};

export default text;
