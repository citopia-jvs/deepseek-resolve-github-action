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
 * `        CLE: valeur` pour les sous-clés de `env:` et de `with:`, un bloc
 * scalaire `run: |` dont le contenu est à huit espaces ou plus, et un bloc scalaire
 * de sous-clé (`settings: |` sous `with:`) dont le contenu est à dix espaces ou plus.
 */
function analyserSteps(lignes) {
  const steps = [];
  let courant = null;
  let imbrique = null;
  let bloc = null; // { cle, lignes }
  let sousBloc = null; // { cle, lignes, carte }

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

  const cloreSousBloc = () => {
    if (sousBloc) {
      sousBloc.carte.set(sousBloc.cle, sousBloc.lignes.join('\n'));
      sousBloc = null;
    }
  };

  for (const ligne of lignes) {
    if (sousBloc !== null) {
      if (ligne.trim() === '' || ligne.startsWith(' '.repeat(10))) {
        sousBloc.lignes.push(ligne.slice(10));
        continue;
      }
      cloreSousBloc();
    }
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
      if (['|', '|-', '>', '>-'].includes(c[2].trim())) {
        sousBloc = { cle: c[1], lignes: [], carte: imbrique };
        continue;
      }
      imbrique.set(c[1], valeurScalaire(c[2]));
      continue;
    }
    throw new Error(`ligne de step non lisible par ce harnais : ${JSON.stringify(ligne)}`);
  }
  cloreSousBloc();
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


/** Le step d'identifiant `id`, qui doit exister. */
function stepParId(id) {
  const step = STEPS.find((s) => s.cles.get('id') === id);
  assert.ok(step, `aucun step d'id « ${id} » dans action.yml`);
  return step;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 — `runs`
// ═════════════════════════════════════════════════════════════════════════════

test('runs déclare using: composite et n’a que les clés using et steps', () => {
  assert.equal(RUNS.get('using'), 'composite');
  // Le schéma `composite-runs` ne connaît que `{using, steps}` : ni `main:`, ni
  // `pre:`, ni `post:`. Une clé acceptée à la lecture serait ignorée à l'exécution.
  assert.deepEqual([...RUNS.keys()].sort(), ['steps', 'using']);
  for (const cle of ['main', 'pre', 'post', 'pre-if', 'post-if', 'timeout-minutes']) {
    assert.equal(
      new RegExp(`^[ \\t]*${cle}:`, 'm').test(TEXTE),
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
  { nom: 'scaleway-api-key', requis: 'true', defaut: null },
  { nom: 'scaleway-base-url', requis: 'false', defaut: 'https://api.scaleway.ai/v1' },
  { nom: 'model', requis: 'false', defaut: 'glm-5.3' },
  { nom: 'context-window', requis: 'false', defaut: '256000' },
  { nom: 'max-turns', requis: 'false', defaut: '30' },
  { nom: 'github-token', requis: 'false', defaut: '${{ github.token }}' },
  { nom: 'validation-command', requis: 'false', defaut: 'npm test' },
  { nom: 'base-branch', requis: 'false', defaut: '' },
  { nom: 'allowed-associations', requis: 'false', defaut: 'OWNER,MEMBER,COLLABORATOR' },
  { nom: 'require-trusted-issue-author', requis: 'false', defaut: 'true' },
];

test('les inputs du contrat sont déclarés, aucun de plus, aucun de moins', () => {
  assert.deepEqual([...INPUTS.keys()].sort(), INPUTS_ATTENDUS.map((i) => i.nom).sort());
});

test('required et default de chaque input sont exactement ceux du contrat', () => {
  for (const attendu of INPUTS_ATTENDUS) {
    const declare = INPUTS.get(attendu.nom);
    assert.ok(declare, `input « ${attendu.nom} » absent`);
    assert.equal(declare.get('required'), attendu.requis, `required de « ${attendu.nom} »`);
    if (attendu.defaut === null) {
      assert.equal(declare.has('default'), false, `« ${attendu.nom} » ne doit porter AUCUN default`);
    } else {
      assert.equal(declare.get('default'), attendu.defaut, `default de « ${attendu.nom} »`);
    }
    // On contrôle la PRÉSENCE de la description, jamais son texte.
    assert.ok(declare.has('description'), `« ${attendu.nom} » n'a pas de description`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 — cohérence dans les deux sens entre `inputs:` et `${{ inputs.* }}`
// ═════════════════════════════════════════════════════════════════════════════

test('chaque input déclaré est utilisé, et chaque inputs.<nom> utilisé est déclaré', () => {
  // LE contrôle qui attrape `${{ inputs.mdel }}`. Une expression qui désigne un
  // input inexistant ne lève pas : elle s'évalue en CHAÎNE VIDE, sans erreur.
  const utilises = new Set();
  for (const m of TEXTE.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)) utilises.add(m[1]);
  const declares = new Set(INPUTS.keys());
  const jamaisUtilises = [...declares].filter((nom) => !utilises.has(nom)).sort();
  const jamaisDeclares = [...utilises].filter((nom) => !declares.has(nom)).sort();
  assert.deepEqual(jamaisDeclares, [], `${JSON.stringify(jamaisDeclares)} est interpolé mais pas déclaré`);
  assert.deepEqual(jamaisUtilises, [], `${JSON.stringify(jamaisUtilises)} est déclaré mais jamais interpolé`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 — les outputs, et les sorties de steps citées
// ═════════════════════════════════════════════════════════════════════════════

const OUTPUTS_ATTENDUS = ['poursuivre', 'branche', 'numero-pr', 'succes'];

// Sorties de chaque step, d'après `plan/contrat.md` (et `execution_file` pour
// claude-code-action, d'après son propre action.yml).
const SORTIES_PAR_STEP = new Map([
  ['garde', ['poursuivre', 'issue', 'branche', 'motif', 'consigne-restreinte']],
  ['preparer', ['numero-pr', 'consigne', 'sauvegarde-config']],
  ['proxy', ['jeton']],
  ['claude1', ['execution_file']],
  ['claude2', ['execution_file']],
  ['verifier1', ['succes', 'consigne-reprise', 'extrait']],
  ['verifier2', ['succes', 'consigne-reprise', 'extrait']],
  ['conclure', ['succes']],
]);

test('les outputs du contrat sont déclarés et toute sortie citée existe', () => {
  assert.deepEqual([...OUTPUTS.keys()].sort(), [...OUTPUTS_ATTENDUS].sort());
  for (const nom of OUTPUTS_ATTENDUS) {
    const sortie = OUTPUTS.get(nom);
    assert.ok(sortie.has('description'), `l'output « ${nom} » n'a pas de description`);
    assert.match(
      sortie.get('value') || '',
      /^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/,
      `la value de l'output « ${nom} » doit lire une sortie de step`,
    );
  }
  const identifiants = new Set(STEPS.map((s) => s.cles.get('id')).filter(Boolean));
  for (const m of TEXTE.matchAll(/steps\.([A-Za-z0-9_-]+)\.(outputs\.([A-Za-z0-9_-]+)|outcome)/g)) {
    const [, id, , sortie] = m;
    assert.ok(identifiants.has(id), `« ${m[0]} » désigne un step sans id: « ${id} »`);
    if (sortie) {
      assert.ok(
        (SORTIES_PAR_STEP.get(id) || []).includes(sortie),
        `« ${sortie} » n'est pas une sortie du step « ${id} » d'après plan/contrat.md`,
      );
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 — le câblage `env:` step par step
// ═════════════════════════════════════════════════════════════════════════════

// Les tables « Variables d'environnement lues par les scripts » du contrat, moins
// les variables du runner et moins la trappe de test `GH_CLI`. Indexées par `id`
// de step : `verifier.js` tourne deux fois, avec deux `PASSAGE` différents.
const SI_PASSAGE_2 = "steps.claude2.outcome != 'skipped'";
const ENV_ATTENDU = new Map([
  ['garde', {
    GH_TOKEN: '${{ inputs.github-token }}',
    ASSOCIATIONS_AUTORISEES: '${{ inputs.allowed-associations }}',
    EXIGER_AUTEUR_ISSUE_DE_CONFIANCE: '${{ inputs.require-trusted-issue-author }}',
  }],
  ['preparer', {
    GH_TOKEN: '${{ inputs.github-token }}',
    NUMERO_ISSUE: '${{ steps.garde.outputs.issue }}',
    BRANCHE: '${{ steps.garde.outputs.branche }}',
    BRANCHE_BASE: '${{ inputs.base-branch }}',
    COMMANDE_VALIDATION: '${{ inputs.validation-command }}',
    CONSIGNE_RESTREINTE: '${{ steps.garde.outputs.consigne-restreinte }}',
  }],
  ['proxy', {
    SCW_SECRET_KEY: '${{ inputs.scaleway-api-key }}',
    SCW_MODELE: '${{ inputs.model }}',
    SCW_BASE_URL: '${{ inputs.scaleway-base-url }}',
  }],
  // Pas de GH_TOKEN dans les deux verifier : ils lancent du code écrit par le modèle.
  ['verifier1', {
    COMMANDE_VALIDATION: '${{ inputs.validation-command }}',
    SAUVEGARDE_CONFIG: '${{ steps.preparer.outputs.sauvegarde-config }}',
    CONSIGNE: '${{ steps.preparer.outputs.consigne }}',
    PASSAGE: '1',
  }],
  ['verifier2', {
    COMMANDE_VALIDATION: '${{ inputs.validation-command }}',
    SAUVEGARDE_CONFIG: '${{ steps.preparer.outputs.sauvegarde-config }}',
    CONSIGNE: '${{ steps.preparer.outputs.consigne }}',
    PASSAGE: '2',
  }],
  ['conclure', {
    GH_TOKEN: '${{ inputs.github-token }}',
    NUMERO_ISSUE: '${{ steps.garde.outputs.issue }}',
    NUMERO_PR: '${{ steps.preparer.outputs.numero-pr }}',
    BRANCHE: '${{ steps.garde.outputs.branche }}',
    SAUVEGARDE_CONFIG: '${{ steps.preparer.outputs.sauvegarde-config }}',
    SUCCES: `\${{ ${SI_PASSAGE_2} && steps.verifier2.outputs.succes || steps.verifier1.outputs.succes }}`,
    PASSAGES: `\${{ ${SI_PASSAGE_2} && '2' || '1' }}`,
    ISSUE_CLAUDE: `\${{ ${SI_PASSAGE_2} && steps.claude2.outcome || steps.claude1.outcome }}`,
    EXTRAIT: `\${{ ${SI_PASSAGE_2} && steps.verifier2.outputs.extrait || steps.verifier1.outputs.extrait }}`,
    FICHIER_EXECUTION: `\${{ ${SI_PASSAGE_2} && steps.claude2.outputs.execution_file || steps.claude1.outputs.execution_file }}`,
    RELECTEUR: '${{ github.actor }}',
  }],
]);

test('le bloc env: de chaque step est exactement celui des tables du contrat', () => {
  // Une composite action n'expose PAS ses inputs en `INPUT_*` : une variable
  // oubliée ici donne une chaîne vide au script, pas une erreur.
  for (const [index, step] of STEPS.entries()) {
    const attendu = ENV_ATTENDU.get(step.cles.get('id')) || {};
    const obtenu = Object.fromEntries(step.env ? step.env : new Map());
    assert.deepEqual(obtenu, attendu, `le bloc env: du step « ${nomDuStep(step, index)} »`);
  }
  for (const id of ENV_ATTENDU.keys()) stepParId(id);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 — les trappes de test restent fermées sur un runner
// ═════════════════════════════════════════════════════════════════════════════

test('aucune variable réservée aux tests n’est câblée dans action.yml', () => {
  // `GH_CLI` remplace le binaire `gh` : câblée ici, elle ferait exécuter par
  // l'action un binaire choisi par le workflow appelant.
  for (const nom of ['GH_CLI', 'ACTION_YML']) {
    assert.equal(new RegExp(`\\b${nom}`).test(TEXTE), false, `« ${nom} » est une trappe de test`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 à 11 — forme et ordre des steps
// ═════════════════════════════════════════════════════════════════════════════

// Le déroulé de `plan/contrat.md`, dans l'ordre, avec la condition exacte de
// chaque step. `null` : aucun `if:`.
const DEROULE = [
  ['garde', null],
  ['preparer', "steps.garde.outputs.poursuivre == 'true'"],
  ['proxy', "steps.preparer.outcome == 'success'"],
  ['claude1', "steps.proxy.outcome == 'success'"],
  ['verifier1', "always() && steps.claude1.outcome != 'skipped'"],
  ['claude2', "always() && steps.verifier1.outputs.succes == 'false'"],
  ['verifier2', "always() && steps.claude2.outcome != 'skipped'"],
  ['conclure', "always() && steps.preparer.outputs.numero-pr != ''"],
];

test('les steps suivent le déroulé du contrat, avec leurs conditions exactes', () => {
  // Sans `always()`, verifier et conclure ne tourneraient pas après un passage du
  // modèle en échec : la PR resterait sans commentaire.
  assert.deepEqual(STEPS.map((s) => s.cles.get('id')), DEROULE.map(([id]) => id));
  for (const [id, condition] of DEROULE) {
    const step = stepParId(id);
    if (condition === null) assert.equal(step.cles.has('if'), false, `« ${id} » ne porte pas de if:`);
    else assert.equal(step.cles.get('if'), condition, `condition du step « ${id} »`);
  }
});

test('chaque step run: déclare shell: bash', () => {
  // `shell:` est OBLIGATOIRE dans un step `run:` de composite action.
  const avecRun = STEPS.filter((s) => s.cles.has('run'));
  assert.equal(avecRun.length, 6, 'six steps run: attendus');
  for (const [index, step] of avecRun.entries()) {
    assert.equal(step.cles.get('shell'), 'bash', `le step « ${nomDuStep(step, index)} » n'a pas shell: bash`);
  }
});

test('tout script est appelé via $GITHUB_ACTION_PATH, jamais par un chemin relatif', () => {
  // En `uses: ./`, `GITHUB_ACTION_PATH` vaut `GITHUB_WORKSPACE` : un chemin relatif
  // passerait le smoke local et casserait chez tout consommateur.
  const references = [...TEXTE.matchAll(/(\S*)scripts\/[A-Za-z0-9._-]+\.js/g)];
  assert.ok(references.length > 0, 'aucun appel de script trouvé');
  for (const m of references) {
    assert.match(m[0], /^"?\$(GITHUB_ACTION_PATH|\{GITHUB_ACTION_PATH\})\/scripts\//, `« ${m[0]} »`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 12 — les deux passages du modèle
// ═════════════════════════════════════════════════════════════════════════════

const CLAUDE_CODE_ACTION = 'anthropics/claude-code-action@6b6870e649b5ff408753befeaee5fc7989d4e6a9';

test('claude-code-action est épinglée par le SHA du contrat, et seule action appelée', () => {
  const uses = STEPS.map((s) => s.cles.get('uses')).filter(Boolean);
  assert.deepEqual(uses, [CLAUDE_CODE_ACTION, CLAUDE_CODE_ACTION]);
});

test('les deux passages sont réglés à l’identique, sans Bash, et .git interdit', () => {
  // Le cœur de la sécurité de la voie A : claude-code-action met le jeton GitHub dans
  // l'environnement de Claude Code, donc tout code qu'il exécuterait pourrait le lire.
  // Voir « Pourquoi Claude Code n'a pas Bash » dans plan/contrat.md.
  const [premier, second] = ['claude1', 'claude2'].map(stepParId);
  for (const cle of ['anthropic_api_key', 'github_token', 'settings', 'claude_args']) {
    assert.equal(second.avec.get(cle), premier.avec.get(cle), `« ${cle} » diffère entre les deux passages`);
  }
  assert.equal(premier.avec.get('prompt'), '${{ steps.preparer.outputs.consigne }}');
  assert.equal(second.avec.get('prompt'), '${{ steps.verifier1.outputs.consigne-reprise }}');
  assert.equal(premier.avec.get('anthropic_api_key'), '${{ steps.proxy.outputs.jeton }}');

  const args = premier.avec.get('claude_args').split('\n').join(' ');
  const autorises = args.match(/--allowedTools "([^"]*)"/);
  const interdits = args.match(/--disallowedTools "([^"]*)"/);
  assert.ok(autorises && interdits, 'claude_args doit porter --allowedTools et --disallowedTools entre guillemets');
  // Des VIRGULES : mesuré au lot C, une liste séparée par des espaces arrive comme
  // une seule entrée et n'est pas appliquée.
  assert.deepEqual(autorises[1].split(','), ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
  assert.ok(interdits[1].split(',').includes('Bash'), 'Bash doit être dans --disallowedTools');

  const reglages = JSON.parse(premier.avec.get('settings').replace(/\$\{\{[^}]*\}\}/g, 'x'));
  for (const regle of ['Read(./.git/**)', 'Edit(./.git/**)', 'Write(./.git/**)']) {
    assert.ok(reglages.permissions.deny.includes(regle), `settings.permissions.deny doit porter ${regle}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 13 — secrets et scripts
// ═════════════════════════════════════════════════════════════════════════════

test('aucun secret n’est interpolé dans un run:', () => {
  // Un secret interpolé dans un `run:` est écrit dans le script généré. Les secrets
  // passent par `env:`, où le runner les masque.
  for (const [index, step] of STEPS.entries()) {
    const run = step.cles.get('run') || '';
    for (const secret of ['inputs.scaleway-api-key', 'inputs.github-token']) {
      assert.equal(run.includes(secret), false, `le step « ${nomDuStep(step, index)} » interpole « ${secret} »`);
    }
  }
  // `secrets.*` n'est pas résolu dans un `action.yml` : chaîne vide silencieuse.
  assert.equal(/secrets\./.test(TEXTE), false);
});

test('les scripts référencés par les steps existent sur le disque', () => {
  const scripts = STEPS.map(scriptDuStep).filter((s) => s !== '');
  assert.ok(scripts.length > 0, 'aucun script référencé');
  for (const script of scripts) {
    assert.ok(fs.existsSync(path.join(RACINE, script)), `${script} est appelé par action.yml mais n'existe pas`);
  }
});
