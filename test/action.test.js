'use strict';

// Harnais de cohérence statique de `action.yml` — lot 4.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert/strict`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/action.test.js
//
// ─── Pourquoi ce fichier existe, et pourquoi en Node ─────────────────────────
//
// Le lot 4 proposait ces contrôles en `python3 - <<'PY' … import yaml`. Mesuré sur
// le poste de développement : `python3 -c "import yaml"` rend
// `ModuleNotFoundError: No module named 'yaml'`. Un contrôle qu'on ne peut pas
// lancer n'est pas un contrôle, et faire installer `pyyaml` par la CI ferait
// dépendre la lecture de notre propre fichier d'un index de paquets. Le contrôle
// est donc porté ici, dans la suite de test, et la CI du lot 5 le lance avec les
// autres — hors ligne, sans clé d'API.
//
// Ce que ce fichier contrôle est invisible à l'exécution : une composite action
// n'expose PAS ses inputs en `INPUT_*` aux sous-processus, et une variable absente
// d'un bloc `env:` donne une chaîne VIDE, pas une erreur. De même,
// `${{ inputs.mdel }}` s'évalue en chaîne vide sans le moindre avertissement. Rien
// dans le dépôt, hors ce fichier, ne rougit sur ces fautes.
//
// ─── CE N'EST PAS UN PARSEUR YAML ────────────────────────────────────────────
//
// À lire avant d'étendre ce fichier. Les fonctions ci-dessous lisent les clés de
// blocs à indentation CONNUE de NOTRE fichier : deux espaces par niveau, aucune
// ancre, aucun alias, aucun flow mapping (`{a: 1}`), aucune clé multi-ligne, aucun
// commentaire en fin de ligne. Elles lèvent sur tout ce qu'elles ne savent pas
// juger, plutôt que de deviner. Un parseur approximatif qui se croit général est un
// piège : il rendrait vert un fichier qu'il a mal lu. Si `action.yml` prend une
// forme que ces fonctions refusent, la bonne correction est d'écrire la forme
// attendue dans `action.yml`, ou d'étendre le parseur ET de garder ses garde-fous —
// jamais de les retirer.
//
// ─── Trappe de test ─────────────────────────────────────────────────────────
//
// `ACTION_YML` désigne le fichier à lire, avec repli sur `action.yml` à la racine.
// C'est une trappe de test, au même titre que `GH_CLI` et `AIDER_CLI` du contrat :
// elle sert à prouver que ces tests rougissent bien quand on injecte la faute
// correspondante dans une COPIE du fichier. Un test qui ne passe jamais au rouge ne
// prouve rien. Elle n'est lue par rien d'autre que ce harnais.
//
// Ce harnais contrôle des NOMS et des VALEURS, jamais de la prose : aucune
// assertion ne porte sur le texte d'un commentaire ni sur le libellé d'une
// `description`, pour qu'une reformulation ne le fasse pas rougir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');
const CHEMIN_ACTION = process.env.ACTION_YML
  ? path.resolve(process.env.ACTION_YML)
  : path.join(RACINE, 'action.yml');

const TEXTE_BRUT = fs.readFileSync(CHEMIN_ACTION, 'utf8');

// ═════════════════════════════════════════════════════════════════════════════
// Lecture
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Retire les lignes de commentaire.
 *
 * Tous les motifs de clé interdite (`post:`, `main:`, `timeout-minutes:`) sont
 * appliqués au texte SANS commentaires, et ancrés en début de ligne. Sans ces deux
 * précautions, `/post:/` matche le mot dans un commentaire qui explique justement
 * qu'une composite n'a pas de `post:`, et `/timeout-minutes:/` matche l'input
 * `aider-call-timeout-minutes:`. Les deux ont été relevés à l'écriture.
 *
 * Ne gère que les commentaires occupant TOUTE la ligne. Un commentaire en fin de
 * ligne fausserait la lecture des valeurs, d'où le garde-fou ci-dessous.
 */
function retirerCommentaires(texte) {
  const lignes = texte.split('\n');
  for (const ligne of lignes) {
    if (/^\s*#/.test(ligne)) continue;
    // Un commentaire en fin de ligne sur une ligne de mapping : refusé net.
    if (/^\s*[A-Za-z0-9_.-]+:\s.*\s#/.test(ligne)) {
      throw new Error(
        `action.yml porte un commentaire en fin de ligne, que ce harnais ne sait ` +
          `pas lire : ${JSON.stringify(ligne)}. Le passer en commentaire de ligne ` +
          `entière, au-dessus de la clé.`,
      );
    }
  }
  return lignes.filter((ligne) => !/^\s*#/.test(ligne)).join('\n');
}

const TEXTE = retirerCommentaires(TEXTE_BRUT);
const LIGNES = TEXTE.split('\n');

/** Ôte les guillemets d'un scalaire, et rien de plus. */
function valeurScalaire(brut) {
  const v = brut.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Les lignes du bloc introduit par la clé `nomCle:` à l'indentation zéro. */
function lignesDuBloc(nomCle) {
  const debut = LIGNES.findIndex((ligne) => ligne === `${nomCle}:`);
  if (debut === -1) {
    throw new Error(`action.yml ne déclare pas de bloc « ${nomCle}: » à l'indentation zéro.`);
  }
  let fin = LIGNES.length;
  for (let i = debut + 1; i < LIGNES.length; i += 1) {
    if (LIGNES[i].trim() !== '' && !/^\s/.test(LIGNES[i])) {
      fin = i;
      break;
    }
  }
  return LIGNES.slice(debut, fin);
}

/** Les couples clé / valeur situés exactement à l'indentation `indent`. */
function clesDeNiveau(lignes, indent) {
  const resultat = new Map();
  const prefixe = ' '.repeat(indent);
  for (const ligne of lignes) {
    if (ligne.trim() === '') continue;
    if (!ligne.startsWith(prefixe) || /^\s/.test(ligne.slice(indent))) continue;
    const m = ligne.slice(indent).match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (!m) continue;
    resultat.set(m[1], valeurScalaire(m[2]));
  }
  return resultat;
}

/**
 * Mapping à deux niveaux : clés à `indent`, sous-clés à `indent + 2`.
 * Lève sur toute autre indentation — voir « ce n'est pas un parseur YAML ».
 */
function mappingImbrique(lignes, indent) {
  const resultat = new Map();
  let courant = null;
  for (const ligne of lignes) {
    if (ligne.trim() === '') continue;
    const m = ligne.match(/^( *)([A-Za-z0-9_.-]+):(.*)$/);
    if (!m) {
      throw new Error(`ligne non lisible par ce harnais : ${JSON.stringify(ligne)}`);
    }
    const [, espaces, cle, reste] = m;
    if (espaces.length === indent) {
      courant = new Map();
      resultat.set(cle, courant);
    } else if (espaces.length === indent + 2) {
      if (courant === null) {
        throw new Error(`sous-clé « ${cle} » sans clé parente : ${JSON.stringify(ligne)}`);
      }
      courant.set(cle, valeurScalaire(reste));
    } else {
      throw new Error(
        `indentation de ${espaces.length} espaces inattendue, ${indent} ou ${indent + 2} ` +
          `attendus : ${JSON.stringify(ligne)}`,
      );
    }
  }
  return resultat;
}

/**
 * Les steps de `runs.steps`.
 *
 * Chaque step est rendu sous la forme
 * `{ cles: Map, env: Map|null, avec: Map|null }`. Indentations attendues :
 * `    - cle: valeur` pour l'item, `      cle: valeur` pour ses autres clés,
 * `        CLE: valeur` pour les sous-clés de `env:` et de `with:`, et un bloc
 * scalaire `run: |` dont le contenu est à huit espaces ou plus.
 */
function analyserSteps(lignes) {
  const steps = [];
  let courant = null;
  let imbrique = null;
  let bloc = null; // { cle, lignes }

  const cloreBloc = () => {
    if (bloc) {
      courant.cles.set(bloc.cle, bloc.lignes.join('\n'));
      bloc = null;
    }
  };

  const poserCle = (texte) => {
    if (courant === null) {
      throw new Error(`clé « ${texte} » hors de tout step.`);
    }
    const m = texte.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (!m) {
      throw new Error(`clé de step non lisible : ${JSON.stringify(texte)}`);
    }
    const cle = m[1];
    const valeur = m[2].trim();
    if (valeur === '|' || valeur === '|-' || valeur === '>' || valeur === '>-') {
      imbrique = null;
      bloc = { cle, lignes: [] };
      return;
    }
    if (valeur === '' && (cle === 'env' || cle === 'with')) {
      imbrique = new Map();
      if (cle === 'env') courant.env = imbrique;
      else courant.avec = imbrique;
      return;
    }
    imbrique = null;
    courant.cles.set(cle, valeurScalaire(valeur));
  };

  for (const ligne of lignes) {
    if (bloc !== null) {
      if (ligne.trim() === '' || ligne.startsWith(' '.repeat(8))) {
        bloc.lignes.push(ligne.slice(8));
        continue;
      }
      cloreBloc();
    }
    if (ligne.trim() === '') continue;

    let m = ligne.match(/^ {4}- (\S.*)$/);
    if (m) {
      courant = { cles: new Map(), env: null, avec: null };
      steps.push(courant);
      imbrique = null;
      poserCle(m[1]);
      continue;
    }
    m = ligne.match(/^ {6}(\S.*)$/);
    if (m) {
      poserCle(m[1]);
      continue;
    }
    m = ligne.match(/^ {8}(\S.*)$/);
    if (m) {
      if (imbrique === null) {
        throw new Error(`sous-clé sans bloc env:/with: : ${JSON.stringify(ligne)}`);
      }
      const c = m[1].match(/^([A-Za-z0-9_.-]+):(.*)$/);
      if (!c) throw new Error(`sous-clé non lisible : ${JSON.stringify(ligne)}`);
      imbrique.set(c[1], valeurScalaire(c[2]));
      continue;
    }
    throw new Error(`ligne de step non lisible par ce harnais : ${JSON.stringify(ligne)}`);
  }
  cloreBloc();
  return steps;
}

const INPUTS = mappingImbrique(lignesDuBloc('inputs').slice(1), 2);
const OUTPUTS = mappingImbrique(lignesDuBloc('outputs').slice(1), 2);

const LIGNES_RUNS = lignesDuBloc('runs').slice(1);
const RUNS = clesDeNiveau(LIGNES_RUNS, 2);
const INDEX_STEPS = LIGNES_RUNS.findIndex((ligne) => ligne === '  steps:');
if (INDEX_STEPS === -1) throw new Error('runs ne déclare pas de bloc « steps: ».');
const STEPS = analyserSteps(LIGNES_RUNS.slice(INDEX_STEPS + 1));

/** Le script `scripts/<nom>.js` appelé par un step, ou `''`. */
function scriptDuStep(step) {
  const run = step.cles.get('run') || '';
  const m = run.match(/scripts\/([A-Za-z0-9._-]+\.js)/);
  return m ? `scripts/${m[1]}` : '';
}

/** Un libellé qui identifie un step dans un message d'échec. */
function nomDuStep(step, index) {
  return step.cles.get('id') || step.cles.get('uses') || scriptDuStep(step) || `step #${index + 1}`;
}

const CONDITION_GARDE = "steps.garde.outputs.poursuivre == 'true'";

// ═════════════════════════════════════════════════════════════════════════════
// 1 — `runs`
// ═════════════════════════════════════════════════════════════════════════════

test('runs déclare using: composite et n’a que les clés using et steps', () => {
  assert.equal(RUNS.get('using'), 'composite');
  // Le schéma `composite-runs` ne connaît que `{using, steps}` : ni `main:`, ni
  // `pre:`, ni `post:`. Un `post:` accepté à la lecture serait ignoré à
  // l'exécution, et le compte rendu de R12 ne partirait jamais.
  assert.deepEqual([...RUNS.keys()].sort(), ['steps', 'using']);

  // Motifs ANCRÉS et appliqués au texte sans commentaires : `/post:/` matcherait
  // le mot dans un commentaire, `/timeout-minutes:/` matcherait l'input
  // `aider-call-timeout-minutes:`.
  for (const cle of ['main', 'pre', 'post', 'pre-if', 'post-if', 'timeout-minutes']) {
    const motif = new RegExp(`^[ \\t]*${cle}:`, 'm');
    assert.equal(
      motif.test(TEXTE),
      false,
      `la clé « ${cle}: » n'existe pas dans une composite action : elle serait ` +
        `ignorée à l'exécution sans aucun message`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 et 3 — les inputs du contrat
// ═════════════════════════════════════════════════════════════════════════════

// Table « Inputs de action.yml » de `plan/contrat.md`, transcrite valeur par
// valeur. `defaut: null` = AUCUNE clé `default:`, ce qui n'est pas la même chose
// qu'un défaut vide.
const INPUTS_ATTENDUS = [
  { nom: 'deepseek-api-key', requis: 'true', defaut: null },
  { nom: 'github-token', requis: 'false', defaut: '${{ github.token }}' },
  { nom: 'max-iterations', requis: 'false', defaut: '2' },
  { nom: 'validation-command', requis: 'false', defaut: 'npm test' },
  { nom: 'base-branch', requis: 'false', defaut: '' },
  { nom: 'model', requis: 'false', defaut: 'deepseek/deepseek-v4-pro' },
  { nom: 'aider-version', requis: 'false', defaut: '0.86.2' },
  { nom: 'python-version', requis: 'false', defaut: '3.12' },
  { nom: 'map-tokens', requis: 'false', defaut: '2048' },
  { nom: 'allowed-associations', requis: 'false', defaut: 'OWNER,MEMBER,COLLABORATOR' },
  { nom: 'require-trusted-issue-author', requis: 'false', defaut: 'true' },
  { nom: 'no-publish', requis: 'false', defaut: 'false' },
  { nom: 'aider-call-timeout-minutes', requis: 'false', defaut: '15' },
];

test('les treize inputs du contrat sont déclarés, aucun de plus, aucun de moins', () => {
  assert.deepEqual(
    [...INPUTS.keys()].sort(),
    INPUTS_ATTENDUS.map((i) => i.nom).sort(),
  );
});

test('required et default de chaque input sont exactement ceux du contrat', () => {
  for (const attendu of INPUTS_ATTENDUS) {
    const declare = INPUTS.get(attendu.nom);
    assert.ok(declare, `input « ${attendu.nom} » absent`);
    assert.equal(
      declare.get('required'),
      attendu.requis,
      `required de « ${attendu.nom} »`,
    );
    if (attendu.defaut === null) {
      // `deepseek-api-key` : `required: true` ET un défaut serait contradictoire,
      // et un défaut vide ferait échouer l'appel à aider avec une erreur d'API
      // plutôt qu'un message clair.
      assert.equal(
        declare.has('default'),
        false,
        `« ${attendu.nom} » ne doit porter AUCUN default`,
      );
    } else {
      assert.equal(declare.get('default'), attendu.defaut, `default de « ${attendu.nom} »`);
    }
    // Un input sans `description` est refusé par le linter d'actions et n'apparaît
    // pas dans l'aide du Marketplace. On contrôle sa PRÉSENCE, jamais son texte.
    assert.ok(declare.has('description'), `« ${attendu.nom} » n'a pas de description`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 — cohérence dans les deux sens entre `inputs:` et `${{ inputs.* }}`
// ═════════════════════════════════════════════════════════════════════════════

test('chaque input déclaré est utilisé, et chaque inputs.<nom> utilisé est déclaré', () => {
  // LE contrôle qui attrape `${{ inputs.mdel }}`. Une expression qui désigne un
  // input inexistant ne lève pas : elle s'évalue en CHAÎNE VIDE. Le job passe au
  // vert, `MODELE` vaut '', et aider est appelé sans modèle. Rien d'autre dans ce
  // dépôt ne rougit sur cette faute de frappe.
  const utilises = new Set();
  for (const m of TEXTE.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)) utilises.add(m[1]);
  const declares = new Set(INPUTS.keys());

  const jamaisUtilises = [...declares].filter((nom) => !utilises.has(nom)).sort();
  const jamaisDeclares = [...utilises].filter((nom) => !declares.has(nom)).sort();

  assert.deepEqual(
    jamaisDeclares,
    [],
    `${JSON.stringify(jamaisDeclares)} est interpolé mais n'est pas déclaré dans ` +
      `inputs: — ces expressions s'évaluent en chaîne vide, sans erreur`,
  );
  assert.deepEqual(
    jamaisUtilises,
    [],
    `${JSON.stringify(jamaisUtilises)} est déclaré mais jamais interpolé — soit un ` +
      `env: manquant, soit un input mort`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 — les outputs, et les steps qu'ils désignent
// ═════════════════════════════════════════════════════════════════════════════

const OUTPUTS_ATTENDUS = ['poursuivre', 'numero-pr', 'branche', 'iterations', 'succes'];

// Sorties écrites par chaque script, d'après `plan/contrat.md`.
const SORTIES_PAR_SCRIPT = new Map([
  ['garde', ['poursuivre', 'issue', 'branche', 'motif', 'consigne-restreinte']],
  ['resoudre', ['numero-pr', 'iterations', 'succes']],
]);

test('les cinq outputs du contrat sont déclarés et pointent des steps existants', () => {
  assert.deepEqual([...OUTPUTS.keys()].sort(), [...OUTPUTS_ATTENDUS].sort());
  for (const nom of OUTPUTS_ATTENDUS) {
    const sortie = OUTPUTS.get(nom);
    assert.ok(sortie.has('description'), `l'output « ${nom} » n'a pas de description`);
    assert.ok(sortie.has('value'), `l'output « ${nom} » n'a pas de value`);
    assert.match(
      sortie.get('value'),
      /^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/,
      `la value de l'output « ${nom} » doit lire une sortie de step`,
    );
  }

  // Les identifiants sont RELEVÉS dans le YAML, pas codés en dur : un `id:`
  // renommé doit faire rougir ce test, pas le laisser passer.
  const identifiants = new Set(
    STEPS.map((step) => step.cles.get('id')).filter((id) => typeof id === 'string'),
  );
  for (const m of TEXTE.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
    const [, id, sortie] = m;
    assert.ok(
      identifiants.has(id),
      `« steps.${id}.outputs.${sortie} » désigne un step sans id: « ${id} » — ` +
        `l'expression s'évaluerait en chaîne vide`,
    );
    assert.ok(
      (SORTIES_PAR_SCRIPT.get(id) || []).includes(sortie),
      `« ${sortie} » n'est pas une sortie du step « ${id} » d'après plan/contrat.md`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 — le câblage `env:` step par step
// ═════════════════════════════════════════════════════════════════════════════

// Les trois tables « Variables d'environnement lues par les scripts » du contrat,
// moins les variables fournies par le runner (`GITHUB_*`) et moins les trappes de
// test (`GH_CLI`, `AIDER_CLI`, `AIDER_STUB_*`), qui n'ont RIEN à faire ici — voir
// le test suivant.
const ENV_ATTENDU = new Map([
  [
    'scripts/garde.js',
    {
      GH_TOKEN: '${{ inputs.github-token }}',
      ASSOCIATIONS_AUTORISEES: '${{ inputs.allowed-associations }}',
      EXIGER_AUTEUR_ISSUE_DE_CONFIANCE: '${{ inputs.require-trusted-issue-author }}',
    },
  ],
  [
    'scripts/resolve.js',
    {
      DEEPSEEK_API_KEY: '${{ inputs.deepseek-api-key }}',
      GH_TOKEN: '${{ inputs.github-token }}',
      NUMERO_ISSUE: '${{ steps.garde.outputs.issue }}',
      BRANCHE: '${{ steps.garde.outputs.branche }}',
      MODELE: '${{ inputs.model }}',
      MAX_ITERATIONS: '${{ inputs.max-iterations }}',
      COMMANDE_VALIDATION: '${{ inputs.validation-command }}',
      BRANCHE_BASE: '${{ inputs.base-branch }}',
      MAP_TOKENS: '${{ inputs.map-tokens }}',
      SANS_PUBLICATION: '${{ inputs.no-publish }}',
      MINUTES_MAX_APPEL_AIDER: '${{ inputs.aider-call-timeout-minutes }}',
      CONSIGNE_RESTREINTE: '${{ steps.garde.outputs.consigne-restreinte }}',
    },
  ],
  [
    'scripts/rendre-compte.js',
    {
      GH_TOKEN: '${{ inputs.github-token }}',
      NUMERO_ISSUE: '${{ steps.garde.outputs.issue }}',
      BRANCHE: '${{ steps.garde.outputs.branche }}',
      // Pas de `STATUT_JOB` : retiré avec l'issue #3. `${{ job.status }}` vaut
      // « success » dans un step qui suit un step de la même composite en échec
      // (mesuré, run 32380365244), donc elle ne pouvait pas servir de critère de
      // silence. Le contrat ne la liste plus ; ce test exigeant l'égalité EXACTE
      // du bloc `env:`, la remettre dans `action.yml` sans l'ajouter ici fait
      // rougir — et c'est voulu.
      SANS_PUBLICATION: '${{ inputs.no-publish }}',
    },
  ],
]);

test('le bloc env: de chaque step est exactement celui des tables du contrat', () => {
  // Le cœur de ce harnais. Une composite action n'expose PAS ses inputs en
  // `INPUT_*` : une variable oubliée ici donne une chaîne vide au script, pas une
  // erreur. `CONSIGNE_RESTREINTE` manquait dans l'exemple du lot 4 lui-même, et
  // son absence fait reprendre le corps d'une issue dont la garde venait de juger
  // l'auteur non autorisé (R6).
  for (const [index, step] of STEPS.entries()) {
    const script = scriptDuStep(step);
    const attendu = ENV_ATTENDU.get(script) || {};
    const obtenu = Object.fromEntries(step.env ? step.env : new Map());
    assert.deepEqual(
      obtenu,
      attendu,
      `le bloc env: du step « ${nomDuStep(step, index)} » ne correspond pas aux ` +
        `tables de plan/contrat.md`,
    );
  }
  // Et chaque script attendu a bien son step : sans ce contrôle, supprimer un step
  // entier passerait inaperçu ci-dessus.
  const scripts = STEPS.map(scriptDuStep).filter((s) => s !== '');
  assert.deepEqual([...scripts].sort(), [...ENV_ATTENDU.keys()].sort());
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 — les trappes de test restent fermées sur un runner
// ═════════════════════════════════════════════════════════════════════════════

test('aucune variable réservée aux tests n’est câblée dans action.yml', () => {
  // `GH_CLI` et `AIDER_CLI` remplacent les binaires `gh` et `aider` par des stubs,
  // et `AIDER_CLI` ouvre en plus l'héritage des `AIDER_STUB_*` dans
  // l'environnement d'aider, qui est sinon une liste blanche stricte (R7). Câblée
  // ici, n'importe laquelle de ces variables ferait exécuter par l'action un
  // binaire choisi par le workflow appelant.
  for (const nom of ['GH_CLI', 'AIDER_CLI', 'AIDER_STUB', 'ACTION_YML']) {
    assert.equal(
      new RegExp(`\\b${nom}`).test(TEXTE),
      false,
      `« ${nom} » est une trappe de test : elle ne doit apparaître nulle part dans ` +
        `action.yml`,
    );
  }
  for (const [index, step] of STEPS.entries()) {
    for (const cle of step.env ? step.env.keys() : []) {
      assert.equal(
        /^(GH_CLI|AIDER_CLI|AIDER_STUB)/.test(cle),
        false,
        `le step « ${nomDuStep(step, index)} » câble la trappe de test « ${cle} »`,
      );
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 à 12 — forme des steps
// ═════════════════════════════════════════════════════════════════════════════

test('chaque step run: déclare shell: bash', () => {
  // `shell:` est OBLIGATOIRE dans un step `run:` de composite action — contrairement
  // à un job de workflow, où il est facultatif. L'oubli est silencieux à
  // l'écriture et fait échouer le chargement de l'action à l'exécution.
  let comptes = 0;
  for (const [index, step] of STEPS.entries()) {
    if (!step.cles.has('run')) continue;
    comptes += 1;
    assert.equal(
      step.cles.get('shell'),
      'bash',
      `le step « ${nomDuStep(step, index)} » a un run: sans shell: bash`,
    );
  }
  assert.equal(comptes, 4, 'quatre steps run: attendus (garde, pipx, resolve, compte rendu)');
});

test('les steps 2 à 5 sont conditionnés par la garde, le dernier avec always()', () => {
  assert.equal(STEPS.length, 5, 'cinq steps attendus');
  // Le premier step est la garde elle-même : elle ne peut pas dépendre de sa
  // propre sortie.
  assert.equal(STEPS[0].cles.has('if'), false, 'le step de garde ne porte pas de if:');
  for (const index of [1, 2, 3]) {
    assert.equal(
      STEPS[index].cles.get('if'),
      CONDITION_GARDE,
      `le step « ${nomDuStep(STEPS[index], index)} » doit être conditionné par la garde`,
    );
  }
  // Sans `always() &&`, le compte rendu de secours ne partirait justement PAS dans
  // les cas pour lesquels il existe : `resolve.js` qui meurt, job annulé,
  // `timeout-minutes` du consommateur (R12).
  assert.equal(
    STEPS[4].cles.get('if'),
    `always() && ${CONDITION_GARDE}`,
    'le dernier step doit porter always() en plus de la condition de garde',
  );
});

test('tout script est appelé via $GITHUB_ACTION_PATH, jamais par un chemin relatif', () => {
  // En `uses: ./`, `GITHUB_ACTION_PATH` vaut `GITHUB_WORKSPACE` : un chemin relatif
  // passerait le smoke test du lot 5 et casserait chez tout consommateur, où
  // l'action est déployée sous `_actions/<owner>/<repo>/<ref>`.
  const references = [...TEXTE.matchAll(/(\S*)scripts\/[A-Za-z0-9._-]+\.js/g)];
  assert.ok(references.length > 0, 'aucun appel de script trouvé');
  for (const m of references) {
    assert.match(
      m[0],
      /^"?\$(GITHUB_ACTION_PATH|\{GITHUB_ACTION_PATH\})\/scripts\//,
      `« ${m[0]} » n'est pas préfixé par $GITHUB_ACTION_PATH`,
    );
  }
});

test('les versions épinglées sont celles de la table du contrat', () => {
  const uses = STEPS.map((step) => step.cles.get('uses')).filter(Boolean);
  // `setup-python@v5` déclare `using: node20`, retiré des runners le 2026-09-16 :
  // épingler v5 livrerait une action qui meurt à cette date.
  assert.deepEqual(uses, ['actions/setup-python@v6']);
  const setupPython = STEPS.find((step) => step.cles.get('uses') === 'actions/setup-python@v6');
  assert.equal(setupPython.avec.get('python-version'), '${{ inputs.python-version }}');

  // L'installation épingle la version par l'input, jamais un « latest » mouvant ni
  // un numéro en dur qui divergerait du défaut de l'input.
  const install = STEPS.map((step) => step.cles.get('run') || '').find((run) =>
    run.includes('aider-chat'),
  );
  assert.ok(install, 'aucun step n’installe aider-chat');
  assert.match(install, /aider-chat==\$\{\{\s*inputs\.aider-version\s*\}\}/);
});

test('aucun secret n’est interpolé dans un run:', () => {
  // Un secret interpolé dans un `run:` est écrit dans le script généré, donc
  // exposé à `set -x`, aux traces d'erreur du shell et à tout `ps`. Les secrets
  // passent par `env:`, où le runner les masque.
  const SECRETS = ['inputs.deepseek-api-key', 'inputs.github-token'];
  for (const [index, step] of STEPS.entries()) {
    const run = step.cles.get('run') || '';
    for (const secret of SECRETS) {
      assert.equal(
        run.includes(secret),
        false,
        `le step « ${nomDuStep(step, index)} » interpole « ${secret} » dans son run:`,
      );
    }
  }
  // `secrets.*` n'est de toute façon pas résolu dans un `action.yml` : l'écrire
  // donnerait une chaîne vide silencieuse.
  assert.equal(/secrets\./.test(TEXTE), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13 — les scripts appelés existent
// ═════════════════════════════════════════════════════════════════════════════

test('les scripts référencés par les steps existent sur le disque', () => {
  // Un action.yml qui appelle un fichier absent est vert à la lecture et rouge à
  // l'exécution, après l'installation d'aider — plus d'une minute de runner pour
  // apprendre qu'un fichier manque.
  const scripts = STEPS.map(scriptDuStep).filter((s) => s !== '');
  assert.ok(scripts.length > 0, 'aucun script référencé');
  for (const script of scripts) {
    const chemin = path.join(RACINE, script);
    assert.ok(fs.existsSync(chemin), `${script} est appelé par action.yml mais n'existe pas`);
  }
});
