'use strict';

// scripts/resolve.js — pilote aider sur le checkout du runner.
//
// Trois lots écrivent ce fichier, dans cet ordre, et chacun n'écrit que sa part :
//
//   • lot 3a — section « Préparation du checkout » : masquage, identité git (R1),
//     résolution de la branche de base, SHA de base, création ou reprise de la
//     branche de travail (R9), préfixe d'authentification du push (R7).
//   • lot 3b — section « Primitives » : les six fonctions dont `plan/contrat.md`
//     fixe les signatures, plus la construction de la consigne et la liste de
//     chemins interdits.
//   • lot 3c — section « Orchestration » : la boucle, qui compose les primitives
//     sans en écrire aucune.
//
// Bibliothèque standard de Node uniquement, CommonJS : aucune dépendance, aucun
// `package.json`. Les noms lus dans l'environnement sont ceux de
// `plan/contrat.md`, seule source de vérité.

const fs = require('node:fs');
const { git, brancheDistanteExiste } = require('./lib/git.js');
const { masquerSecrets } = require('./lib/texte.js');

// Les lots 3b et 3c complètent ces imports avec ce dont ils ont besoin :
//   ./lib/git.js      → aDesCommits, etatFichiers
//   ./lib/gh.js       → gh
//   ./lib/chemins.js  → estCheminInterdit, normaliser
//   ./lib/texte.js    → nettoyerTexteTiers, tronquer

// ---------------------------------------------------------------------------
// Journal du job
//
// Les commandes de workflow (`::warning::`, `::error::`, `::add-mask::`) sont
// mono-ligne : un retour à la ligne les tronquerait silencieusement, d'où
// l'encodage en `%0A`.
//
// Les quatre fonctions publiques masquent (R7), sans exception à retenir : les
// lots 3b et 3c y verseront des sorties d'aider et des logs de validation, et
// une fonction de journal dont il faut se souvenir qu'elle ne masque pas est une
// fonction de journal qui fuira.
// ---------------------------------------------------------------------------

// Seule écriture non masquée du fichier. Réservée à `masquer()` : masquer la
// ligne `::add-mask::` elle-même remplacerait la valeur à masquer par le
// marqueur, et le runner ne masquerait alors plus rien.
function ecrireBrut(ligne) {
  process.stdout.write(`${ligne}\n`);
}

function journaliser(message) {
  ecrireBrut(masquerSecrets(String(message)));
}

function surUneLigne(message) {
  return String(message).replace(/\r?\n/g, '%0A');
}

// Masquage AVANT l'encodage en `%0A` : un motif de secret ne doit pas dépendre de
// la forme des fins de ligne. `journaliser` remasque derrière, ce qui est sans
// effet — `masquerSecrets` est idempotente — et sert de filet.
function avertir(message) {
  journaliser(`::warning::${surUneLigne(masquerSecrets(String(message)))}`);
}

function erreur(message) {
  journaliser(`::error::${surUneLigne(masquerSecrets(String(message)))}`);
}

/**
 * Demande au runner de masquer une valeur dans l'affichage.
 *
 * Portée réelle, à ne pas surestimer : le runner masque déjà ce qui vient de
 * `secrets.*`, le masquage ne vaut que pour ce qui est écrit APRÈS, et il ne
 * remplace que l'occurrence littérale exacte — ni un base64, ni un jeton coupé
 * en deux. C'est de la cosmétique de journal, pas une défense ; le seul cas
 * qu'il couvre vraiment est celui du consommateur qui passe la clé en clair.
 *
 * @param {string} valeur
 */
function masquer(valeur) {
  if (typeof valeur !== 'string' || valeur === '') return;
  ecrireBrut(`::add-mask::${valeur.replace(/\r?\n/g, '')}`);
}

// ---------------------------------------------------------------------------
// Configuration
//
// Une composite action n'expose PAS ses inputs en `INPUT_*` aux sous-processus :
// chaque valeur arrive par le `env:` de son step. Les noms ci-dessous sont ceux
// de `plan/contrat.md`.
//
// Tous les inputs d'action sont des chaînes : on ne compare qu'à `'true'`,
// jamais à `'false'`. Le lot 3a ne valide que ce qu'il consomme et laisse les
// autres valeurs en chaîne brute, pour ne pas dupliquer ici les défauts que
// `action.yml` porte déjà (lot 4).
// ---------------------------------------------------------------------------

const MOTIF_BRANCHE = /^fix-issue-\d+$/;

function lireEnv(nom) {
  const valeur = process.env[nom];
  return typeof valeur === 'string' ? valeur.trim() : '';
}

/**
 * Lit et valide l'environnement.
 * @returns {Readonly<object>}
 */
function lireConfiguration() {
  const branche = lireEnv('BRANCHE');
  const numeroBrut = lireEnv('NUMERO_ISSUE');
  const brancheBase = lireEnv('BRANCHE_BASE');

  // `BRANCHE` vient de la sortie `branche` de la garde et FAIT FOI : elle n'est
  // jamais reconstruite depuis `NUMERO_ISSUE`, qui ne sert qu'aux commentaires
  // et au « Résout #<n> ». On revalide malgré tout la forme, parce que cette
  // valeur part en argument de `git switch` et de `git push` : un nom commençant
  // par « - » serait pris pour une option.
  if (!MOTIF_BRANCHE.test(branche)) {
    throw new Error(
      `BRANCHE invalide : ${JSON.stringify(branche)}. Attendu la sortie « branche » ` +
        'de scripts/garde.js, de la forme fix-issue-<n>.',
    );
  }

  const numeroIssue = Number(numeroBrut);
  if (!Number.isInteger(numeroIssue) || numeroIssue <= 0) {
    throw new Error(
      `NUMERO_ISSUE invalide : ${JSON.stringify(numeroBrut)}. Attendu la sortie ` +
        '« issue » de scripts/garde.js, un entier décimal positif.',
    );
  }

  // `BRANCHE_BASE` est l'input `base-branch`, écrit par l'auteur du workflow.
  // Vide est son défaut et son cas nominal. Non vide, il part en argument de
  // `git fetch` : on refuse ce que git ne saurait de toute façon pas nommer, et
  // surtout tout ce qui pourrait passer pour une option.
  if (brancheBase !== '' && !/^[A-Za-z0-9._\/-]+$/.test(brancheBase)) {
    throw new Error(
      `BRANCHE_BASE invalide : ${JSON.stringify(brancheBase)}. Attendu un nom de ` +
        'branche simple, ou une valeur vide pour utiliser la branche du checkout.',
    );
  }
  if (brancheBase.startsWith('-') || brancheBase.includes('..')) {
    throw new Error(`BRANCHE_BASE invalide : ${JSON.stringify(brancheBase)}.`);
  }

  return Object.freeze({
    // Fournies par le runner.
    cheminEvenement: lireEnv('GITHUB_EVENT_PATH'), // lot 3b — titre et corps de l'issue
    depot: lireEnv('GITHUB_REPOSITORY'), // lots 3b et 3c — `--repo` de gh
    espaceTravail: lireEnv('GITHUB_WORKSPACE'),
    cheminAction: lireEnv('GITHUB_ACTION_PATH'), // lot 3b — aider.conf.yml, aider-models.json

    // Secrets.
    cleDeepseek: lireEnv('DEEPSEEK_API_KEY'), // lot 3b — environnement d'aider
    jetonGh: lireEnv('GH_TOKEN'), // push (ci-dessous) et gh (lot 3b)

    // Sorties de la garde.
    branche,
    numeroIssue,

    // Inputs d'action, laissés en chaîne : les lots 3b et 3c les interprètent.
    modele: lireEnv('MODELE'),
    maxIterations: lireEnv('MAX_ITERATIONS'),
    commandeValidation: lireEnv('COMMANDE_VALIDATION'),
    brancheBase,
    mapTokens: lireEnv('MAP_TOKENS'),
    minutesMaxAppelAider: lireEnv('MINUTES_MAX_APPEL_AIDER'),

    // Les deux seules valeurs converties ici, parce qu'elles commandent une
    // branche de code et non un argument de sous-processus. Comparaison à
    // `'true'` faite une fois pour toutes, jamais à `'false'`.
    sansPublication: lireEnv('SANS_PUBLICATION') === 'true',
    // Sortie `consigne-restreinte` de la garde, étage 2 bis (R6) : le lot 3b ne
    // prend alors que le commentaire comme consigne et passe le corps de l'issue
    // en données non fiables.
    consigneRestreinte: lireEnv('CONSIGNE_RESTREINTE') === 'true',
  });
}

// ---------------------------------------------------------------------------
// Préparation du checkout — lot 3a
// ---------------------------------------------------------------------------

/**
 * Se place dans le checkout du dépôt consommateur.
 *
 * `estCheminInterdit()` fait des `lstat` sur des chemins relatifs (lot 1) : tout
 * le reste du script doit donc tourner depuis `GITHUB_WORKSPACE`. Hors runner, la
 * variable est absente et on reste dans le répertoire courant, ce qui rend le
 * script exerçable dans un dépôt jetable.
 *
 * @param {Readonly<object>} config
 */
function entrerDansEspaceTravail(config) {
  if (config.espaceTravail !== '' && config.espaceTravail !== process.cwd()) {
    if (!fs.existsSync(config.espaceTravail)) {
      throw new Error(`GITHUB_WORKSPACE introuvable : ${config.espaceTravail}`);
    }
    process.chdir(config.espaceTravail);
  }
  if (git(['rev-parse', '--is-inside-work-tree'], { tolererEchec: true }) !== 'true') {
    throw new Error(
      `${process.cwd()} n'est pas un dépôt git. L'action exige un actions/checkout ` +
        'avant son propre step.',
    );
  }
}

/**
 * Configure l'identité git du dépôt — R1.
 *
 * `aider/repo.py:291` fait `self.repo.git.config("--get", "user.name")` HORS du
 * `try` ouvert ligne 296 : sur une clé absente, `git config --get` sort en code 1
 * et GitPython lève un `GitCommandError` non rattrapé. `actions/checkout` ne
 * configure ni `user.name` ni `user.email`, donc le premier commit d'aider plante
 * le job avec une trace Python peu parlante. Reste vrai avec
 * `--no-auto-commits` : aider passe encore par ce chemin, et de toute façon
 * l'action commite elle-même (lot 3b) et a besoin d'une identité.
 *
 * Portée locale au dépôt, jamais `--global` : on ne modifie pas l'environnement
 * du runner au-delà du job.
 */
function configurerIdentiteGit() {
  git(['config', 'user.name', 'deepseek-resolve[bot]']);
  git(['config', 'user.email', 'deepseek-resolve@users.noreply.github.com']);
}

/**
 * La branche existe-t-elle localement ?
 * @param {string} nom
 * @returns {boolean}
 */
function brancheLocaleExiste(nom) {
  return (
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${nom}`], { tolererEchec: true }) !== null
  );
}

/**
 * Le remote `origin` est-il déclaré ?
 *
 * Toujours vrai après un `actions/checkout`. Faux dans un dépôt jetable créé au
 * `git init`, ce qui est le cas du bloc de vérification du lot 3a : sans ce
 * contrôle, `git ls-remote origin` sortirait en erreur et ferait échouer la
 * préparation là où il n'y a simplement rien à interroger.
 *
 * @returns {boolean}
 */
function remoteOrigineExiste() {
  return git(['remote', 'get-url', 'origin'], { tolererEchec: true }) !== null;
}

/**
 * Résout la branche de base.
 *
 * `BRANCHE_BASE` vide (son défaut) → la branche du checkout. Un événement
 * `issues` / `issue_comment` fait toujours tourner le workflow sur la branche par
 * défaut, c'est donc elle.
 *
 * `BRANCHE_BASE` renseignée → `git fetch --depth=1 origin <base>`, puis
 * `origin/<base>`. Le `--depth=1` compte : `fetch-depth: 1` est le défaut de
 * `actions/checkout`, et un `git fetch origin <base>` nu rapatrierait tout
 * l'historique de la branche. Le `remote.origin.fetch` posé par le checkout fait
 * que ce fetch crée bien `refs/remotes/origin/<base>`.
 *
 * Sans remote `origin` — jamais sur un runner, mais c'est le cas d'un dépôt
 * jetable créé au `git init` — le fetch est sauté avec un avertissement et on se
 * rabat sur la référence locale du même nom, pour que ce chemin reste exerçable
 * hors ligne.
 *
 * @param {Readonly<object>} config
 * @returns {{ nom: string, reference: string }} `nom` pour `gh pr create --base`,
 *   `reference` pour créer la branche de travail.
 */
function resoudreBase(config) {
  if (config.brancheBase !== '') {
    if (remoteOrigineExiste()) {
      git(['fetch', '--depth=1', 'origin', config.brancheBase]);
      return { nom: config.brancheBase, reference: `origin/${config.brancheBase}` };
    }
    if (!brancheLocaleExiste(config.brancheBase)) {
      throw new Error(
        `base-branch = ${config.brancheBase} : ce dépôt n'a ni remote « origin » ` +
          'pour la récupérer, ni branche locale de ce nom. Vérifier le nom de la ' +
          "branche, ou laisser base-branch vide pour partir de la branche du checkout.",
      );
    }
    avertir(
      `Aucun remote « origin » : le fetch de la base ${config.brancheBase} est sauté, ` +
        'la branche locale du même nom est utilisée à sa place.',
    );
    return { nom: config.brancheBase, reference: config.brancheBase };
  }

  const courante = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (courante === '' || courante === 'HEAD') {
    // HEAD détaché : il n'existe aucun nom de branche à donner en base de PR.
    throw new Error(
      "HEAD est détaché : impossible de déduire la branche de base du checkout. " +
        "Renseigner l'input base-branch.",
    );
  }
  return { nom: courante, reference: courante };
}

/**
 * Crée la branche de travail, ou la reprend — R9.
 *
 * Le cas réel n'est pas « la branche existe localement », impossible sur un
 * runner neuf : c'est la branche restée SUR LE REMOTE après une PR fermée sans
 * suppression, ou après un run annulé qui avait déjà poussé. `git switch -c`
 * réussissait alors localement et le push était rejeté en non-fast-forward,
 * après avoir consommé toutes les itérations.
 *
 * @param {string} nom nom de branche issu de la garde, qui fait foi
 * @param {string} referenceBase
 * @returns {'locale'|'distante'|false} origine de la reprise, `false` si créée
 */
function etablirBrancheTravail(nom, referenceBase) {
  if (brancheLocaleExiste(nom)) {
    // Inatteignable sur un runner neuf ; possible en réexécution locale. On s'y
    // place sans rien réécrire : ni reset ni merge, pour ne pas détruire du
    // travail déjà commité.
    git(['switch', nom]);
    return 'locale';
  }

  if (!remoteOrigineExiste()) {
    avertir(
      `Aucun remote « origin » : le contrôle de branche distante (R9) est sauté pour ${nom}.`,
    );
    git(['switch', '-c', nom, referenceBase]);
    return false;
  }

  if (brancheDistanteExiste(nom)) {
    git(['fetch', '--depth=1', 'origin', `${nom}:refs/remotes/origin/${nom}`]);
    git(['switch', '-c', nom, `origin/${nom}`]);
    return 'distante';
  }

  git(['switch', '-c', nom, referenceBase]);
  return false;
}

/**
 * Construit le préfixe d'arguments qui authentifie le push — durcissement de R7.
 *
 * Forme : `git -c http.extraheader="AUTHORIZATION: basic <base64>" push …`.
 * L'action ne dépend donc pas de `persist-credentials`, que le lot 6
 * recommandera de mettre à `false` : avec le défaut `true`, le jeton en écriture
 * est écrit dans `.git/config` du checkout, donc lisible par n'importe quel code
 * exécuté là — y compris celui que le modèle vient d'écrire, un
 * `git credential fill` suffisant.
 *
 * Le jeton est ici un ARGUMENT de ligne de commande. Deux conséquences tenues :
 * ce tableau n'est jamais journalisé, et `lib/git.js` masque son propre argv dans
 * ses messages d'erreur.
 *
 * @param {string} jeton
 * @returns {ReadonlyArray<string>} vide si aucun jeton n'est disponible
 */
function construirePrefixeAuthentification(jeton) {
  if (jeton === '') return Object.freeze([]);
  const identifiants = Buffer.from(`x-access-token:${jeton}`, 'utf8').toString('base64');
  // Masquer la valeur DÉRIVÉE, pas seulement le jeton brut : c'est cette forme
  // qui apparaîtrait dans la sortie d'un sous-processus, et ce canal est celui de
  // R7 — logs de validation réinjectés dans le prompt du tour suivant, extrait
  // publié en commentaire de PR, logs de job publics sur un dépôt public. Le
  // demander au runner referme le trou en amont, sans dépendre d'un motif de
  // forme en aval.
  masquer(identifiants);
  return Object.freeze(['-c', `http.extraheader=AUTHORIZATION: basic ${identifiants}`]);
}

/**
 * Rend le checkout utilisable par aider et par les lots 3b et 3c.
 *
 * @param {Readonly<object>} config
 * @returns {Readonly<object>} préparation :
 *   `nomBrancheBase` — nom de branche pour `gh pr create --base` (lot 3b) ;
 *   `referenceBase` — révision git dont la branche de travail est partie ;
 *   `shaBase` — SHA de la base, ce que la PR ajoute (diff du relecteur) ;
 *   `shaDepart` — SHA de HEAD après établissement de la branche, ce que CE run
 *     produit (comptage R4 du lot 3c) ;
 *   `branche` — branche de travail, celle de la garde ;
 *   `reprise` — `'locale'`, `'distante'` ou `false` ;
 *   `prefixeAuthentification` — arguments à placer AVANT `push` (lot 3b).
 */
function preparer(config) {
  // 1. Masquer, avant tout le reste : le masquage ne vaut que pour la suite.
  masquer(config.cleDeepseek);
  masquer(config.jetonGh);

  entrerDansEspaceTravail(config);

  // 2. Identité git — R1.
  configurerIdentiteGit();

  // 3. Branche de base.
  const base = resoudreBase(config);

  // La base ne peut pas être la branche de travail : le comptage
  // `<base>..HEAD` du lot 3c (R4) rendrait alors toujours zéro. N'arrive pas sur
  // un runner neuf — le checkout est sur la branche par défaut — mais arrive en
  // réexécution locale du script dans un checkout déjà préparé.
  if (base.nom === config.branche) {
    throw new Error(
      `La branche du checkout est déjà la branche de travail ${config.branche} : ` +
        "aucune base de comparaison. Renseigner l'input base-branch.",
    );
  }

  // 4. SHA de base, relevé sur la base RÉSOLUE et non sur HEAD : avec un
  //    `base-branch` différent du checkout, partir de HEAD donnerait un diff de
  //    PR faux. Et un SHA plutôt qu'un nom, parce qu'un nom de branche peut
  //    bouger sous nos pieds pendant le job.
  const shaBase = git(['rev-parse', '--verify', `${base.reference}^{commit}`]);

  // 5. Créer ou reprendre la branche de travail — R9.
  const reprise = etablirBrancheTravail(config.branche, base.reference);

  // 6. SHA de départ, relevé APRÈS l'établissement de la branche. Distinct de
  //    `shaBase` dès que la branche est reprise : voir « Pourquoi `shaDepart` en
  //    plus de `shaBase` » dans `plan/contrat.md`.
  const shaDepart = git(['rev-parse', '--verify', 'HEAD^{commit}']);

  // 7. Authentification du push — R7.
  const prefixeAuthentification = construirePrefixeAuthentification(config.jetonGh);
  if (prefixeAuthentification.length === 0 && !config.sansPublication) {
    avertir(
      'GH_TOKEN est absent : le push et les commentaires de PR échoueront. ' +
        "Vérifier l'input github-token.",
    );
  }

  return Object.freeze({
    nomBrancheBase: base.nom,
    referenceBase: base.reference,
    shaBase,
    shaDepart,
    branche: config.branche,
    reprise,
    prefixeAuthentification,
  });
}

/**
 * Résume la préparation dans le journal du job.
 *
 * Ne journalise jamais `prefixeAuthentification` : il porte le jeton.
 *
 * @param {Readonly<object>} preparation
 */
function journaliserPreparation(preparation) {
  const etat =
    preparation.reprise === false
      ? 'créée'
      : `reprise (branche ${preparation.reprise} préexistante)`;
  journaliser(`Branche de base   : ${preparation.nomBrancheBase} (${preparation.referenceBase})`);
  journaliser(`SHA de base       : ${preparation.shaBase}`);
  journaliser(`SHA de départ     : ${preparation.shaDepart}`);
  journaliser(`Branche de travail: ${preparation.branche} — ${etat}`);
}

// ---------------------------------------------------------------------------
// Primitives — lot 3b
//
// À écrire ici, aux signatures EXACTES de `plan/contrat.md`, et rien d'autre —
// aucune boucle :
//
//   appelerAider(consigne)     -> { codeSortie, sortie }
//   executerValidation()       -> { codeSortie, logs }    environnement filtré
//   commiterTravail(message)   -> { commite, refuses }
//   publierInitial(prompt)     -> { numeroPr }            push + gh pr create
//   publierTour(i, resultat)   -> void
//   publierCompteRendu(bilan)  -> void
//
// plus la construction de la consigne (R6) et la liste de chemins interdits,
// appliquée par `lib/chemins.js`.
//
// Déjà en place et réutilisable :
//   • `lireConfiguration()` expose toutes les variables du contrat, dont
//     `cheminAction` (aider.conf.yml, aider-models.json — R8), `cleDeepseek`,
//     `jetonGh`, `modele`, `mapTokens`, `minutesMaxAppelAider`,
//     `commandeValidation`, `numeroIssue`, `sansPublication`, `consigneRestreinte`
//     (étage 2 bis de la garde, R6), `cheminEvenement`, `depot`.
//   • `preparation.prefixeAuthentification` : à placer AVANT `push` dans le
//     tableau d'arguments de `git()`, jamais journalisé.
//   • `preparation.nomBrancheBase` : `gh pr create --base`.
//   • `preparation.shaBase` et `preparation.shaDepart` : deux points de
//     référence distincts, cf. `plan/contrat.md`.
//   • `journaliser`, `avertir`, `erreur` pour le journal du job : les trois
//     appliquent `masquerSecrets()`, aucune exception à retenir. `masquer()`
//     demande au runner de masquer une valeur.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestration — lot 3c
//
// À écrire ici : la boucle qui compose les six primitives ci-dessus sans en
// écrire aucune ni en modifier la signature. Y vivent R4 (`aDesCommits`), le
// contrôle du code de sortie d'aider, le contrôle de ceinture avant push, le
// mode `no-publish`, les `::group::` par itération et l'écriture des outputs
// `numero-pr`, `iterations`, `succes` dans `GITHUB_OUTPUT`.
//
// Déjà en place et réutilisable :
//   • `preparation.shaDepart` : la base du contrôle R4, `aDesCommits(shaDepart)`.
//     C'est CE run qui est mesuré, pas la branche : quand `reprise` vaut
//     `'distante'`, la branche porte déjà les commits d'un run précédent.
//   • `preparation.shaBase` : la base du diff de la PR et du contrôle de ceinture
//     `git log --name-only <shaBase>..HEAD`. Ne pas recalculer depuis HEAD.
//     Les deux SHA et leur partage des rôles sont figés dans `plan/contrat.md`,
//     section « Objet `preparation` rendu par `preparer()` ».
//   • `config.sansPublication` : booléen, déjà comparé à `'true'` une seule fois.
//   • `config.maxIterations` : chaîne brute, à interpréter ici.
// ---------------------------------------------------------------------------

/**
 * Point d'entrée de la boucle. Remplacé par le lot 3c.
 * @param {Readonly<object>} config
 * @param {Readonly<object>} preparation
 * @returns {number} code de sortie du processus
 */
function orchestrer(config, preparation) {
  throw new Error(
    "L'orchestration (lot 3c) n'est pas encore écrite. Lancer avec " +
      '--preparer-seulement pour exercer la préparation du checkout (lot 3a).',
  );
}

// ---------------------------------------------------------------------------
// Ligne de commande
// ---------------------------------------------------------------------------

const USAGE = `Usage : node scripts/resolve.js [--preparer-seulement]

  --preparer-seulement  N'exécute que la préparation du checkout (identité git,
                        branche de base, SHA de base, branche de travail) et
                        s'arrête avant tout appel réseau et avant la boucle.
  --aide, --help        Affiche ce message.

Variables d'environnement : voir la section « resolve.js » de plan/contrat.md.`;

/**
 * @param {string[]} arguments_ `process.argv.slice(2)`
 * @returns {number} code de sortie
 */
function principal(arguments_) {
  const connus = new Set(['--preparer-seulement', '--aide', '--help']);
  const inconnu = arguments_.find((a) => !connus.has(a));
  if (inconnu !== undefined) {
    // L'usage sur stdout, l'erreur sur une seule ligne : une commande de workflow
    // est mono-ligne, y coller l'usage entier le rendrait illisible.
    journaliser(USAGE);
    throw new Error(`Argument inconnu : ${inconnu}`);
  }
  if (arguments_.includes('--aide') || arguments_.includes('--help')) {
    journaliser(USAGE);
    return 0;
  }

  const config = lireConfiguration();
  const preparation = preparer(config);
  journaliserPreparation(preparation);

  if (arguments_.includes('--preparer-seulement')) {
    journaliser('--preparer-seulement : la boucle n’est pas lancée.');
    return 0;
  }

  return orchestrer(config, preparation);
}

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (err) {
    erreur(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Le lot 3b ajoute ici ses primitives, pour `test/boucle.test.js`.
module.exports = { lireConfiguration, preparer, principal };
