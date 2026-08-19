'use strict';

// Harnais de cohérence statique de `.github/workflows/test.yml` — lot 5.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert/strict`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/ci.test.js
//
// ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
//
// Le workflow est le seul endroit qui lance les six autres suites, et rien ne le
// surveillait. Deux défauts mesurés du lot 5 le justifient à eux seuls, parce que
// tous deux laissaient la CI VERTE tout en ne contrôlant plus rien :
//
//   1. `find … -exec node --check {} \;` rend 0 même sur un script cassé. Mesuré
//      sur ce dépôt avec un `scripts/casse.js` contenant `const a = ;`. La forme
//      `-exec … +` n'est pas meilleure : `node --check bon.js casse.js` rend 0,
//      `node --check` ignorant silencieusement ses arguments après le premier. Un
//      contrôle qui ne pouvait pas échouer.
//   2. Un `uses:` en chemin relatif au lieu de `$GITHUB_ACTION_PATH` passe
//      `smoke-local`, parce qu'en `uses: ./` le runner fait coïncider
//      `GITHUB_ACTION_PATH` et `GITHUB_WORKSPACE`. Seul `smoke-sous-repertoire`
//      les sépare — et seulement s'il n'a AUCUN checkout à la racine.
//
// Ce fichier épingle donc les formes dont on a mesuré que l'écart est SILENCIEUX.
// Chaque cas porte dans son commentaire la mesure qui le justifie, jamais la
// paraphrase de son assertion.
//
// ─── LA FAMILLE DE MUTATIONS À ESSAYER ───────────────────────────────────────
//
// À lire avant d'ajouter un cas ici. Deux batteries de mutation, 31 cas et 23 cas,
// ont validé ce harnais en ne mutant que des FORMES : un mot remplacé par un autre.
// Cinq défauts bloquants leur ont survécu, tous de la même famille — RETIRER LE
// TRAVAIL EN GARDANT L'APPARENCE :
//
//   supprimer le step (l'installation d'actionlint gardée, son lancement retiré ;
//   le step d'assertion d'un smoke retiré) ; vider le corps d'une boucle ; couper le
//   lien entre une déclaration et son usage (une boucle sur une variable, un `node`
//   sur une autre) ; neutraliser le code de sortie (`exit "$manquantes"` retiré, un
//   `::error::` seul n'échouant pas un step) ; ajouter `|| true` ; changer un
//   prédicat pour que le lot contrôlé soit VIDE (`-name '*.mjs'`, ou un `-path` AJOUTÉ à
//   côté du `-name '*.js'` qu'on a laissé en place) ; empêcher un job
//   de tourner (`if:`, `continue-on-error:`, un `on:` filtré) ; restreindre un contrôle
//   aux fichiers nommés aujourd'hui (`actionlint .github/workflows/test.yml`) ; désarmer
//   un job depuis un fichier que ce harnais ne lit pas (`.github/actionlint.yaml`).
//
// Et la leçon de la troisième batterie : UN BAN DE GRAPHIES NE FERME PAS UNE FAMILLE.
// Les deux motifs `|| true` et `set +e` une fois interdits, sont restés verts `|| :`,
// `; true` et `set +o errexit`. D'où trois interdits par PROPRIÉTÉ — aucune alternation,
// aucun `set +` qui désarme la détection d'échec, aucun `;` hors compound command — et
// non par liste : voir `BANS_DE_FORME` et `infractionsDeForme`.
//
// Et la leçon de la QUATRIÈME : UN BAN TROP LARGE EST UN BAN QU'ON RETIRE. Trois de ces
// interdits refusaient du shell légitime ou visaient à l'envers — `if … ; then … ; fi` sur
// une seule ligne, `set +x` refusé quand `set -x` passait, `|| exit 1` accusé d'avaler un
// code de retour qu'il propage. Corriger la portée d'un ban vaut mieux que le voir sauter
// en entier à la première gêne.
//
// Et celle de la CINQUIÈME : UNE EXCLUSIVITÉ NE VAUT QUE SUR LE BORD OÙ ELLE EST POSÉE. Le
// prédicat du `find` était épinglé par égalité, et tout ce qui suivait le `|` restait libre :
// `| xargs -0 -n1 node --check --help` est resté vert à 31 cas sur 31, avec un tube qui rend
// 0 sur un `scripts/casse.js` bien réel. Les deux bords sont maintenant lus par égalité dans
// le même cas. Deux corollaires du même passage : recoller les continuations `\` AVANT
// d'analyser, parce qu'un contrôle qui refuse de couper une ligne de 74 caractères est un
// contrôle qu'on retirera ; et ATTACHER UNE DÉCISION À SA PRÉMISSE — la permission donnée à
// `set -x` reposait sur « ce workflow ne porte aucun secret », vrai mais tenu par personne,
// d'où le cas qui refuse tout `secrets.` en contenu.
//
// ─── UNE LIMITE QUE CE FICHIER NE FERME PAS ──────────────────────────────────
//
// `if [ ! -f "$suite" ] && false; then` reste vert, et le step rend 0 quelles que soient
// les suites absentes : le motif `-f "$suite"`, le `::error::`, le `manquantes=1` et
// l'`exit "$manquantes"` sont tous encore là. C'est la SÉMANTIQUE du shell qui change,
// pas le texte, et un lecteur statique ne peut pas la juger. Idem pour l'assertion de
// `smoke-local` avec un `&& false`. Poursuivre par des motifs de plus en plus fins
// ajouterait de la complexité contre une famille infinie : la limite est inscrite dans
// plan/contrat.md, « Ce qu'aucun lecteur statique ne peut fermer ». Aucun nom de cas
// ci-dessous ne doit laisser croire qu'elle est couverte — d'où « le step … porte un
// ::error:: et une sortie qui peut être non nulle » plutôt que « … rend un code non nul
// quand une suite manque ».
//
// D'où deux règles de forme pour les cas ci-dessous. Une assertion ne porte pas sur
// la présence d'un motif « quelque part dans le fichier » mais dans le `run:` d'un
// step NOMMÉ. Et deux assertions qui doivent parler du même objet le lisent l'une de
// l'autre — le corps de la boucle est extrait de son en-tête, le chemin du binaire
// actionlint est lu sur la commande qui l'extrait — au lieu de citer deux fois la
// même valeur en espérant qu'elles restent d'accord.
//
// ─── CE N'EST PAS UN PARSEUR YAML ────────────────────────────────────────────
//
// Même règle que `test/action.test.js`, à lire avant d'étendre ce fichier. Les
// fonctions ci-dessous lisent les blocs à indentation CONNUE de NOTRE fichier :
// deux espaces par niveau, aucune ancre, aucun alias, aucun flow mapping en dehors
// de `branches: [main]`, aucune clé multi-ligne hors bloc scalaire `|`. Elles
// LÈVENT sur tout ce qu'elles ne savent pas juger, plutôt que de deviner. Un
// parseur approximatif qui se croit général rendrait vert un fichier qu'il a mal
// lu. La validité YAML du workflow est prouvée par `actionlint` dans le job
// `syntaxe`, pas ici.
//
// ─── CONTENU ET COMMENTAIRES SONT DEUX CHOSES ────────────────────────────────
//
// Plusieurs cas sont de la forme « ce motif est ABSENT » : `ubuntu-latest`,
// `-exec`, `GH_CLI`, `${{ … }}` dans un `run:`. Le workflow cite précisément ces
// motifs dans ses commentaires, pour expliquer pourquoi il ne les utilise pas. Un
// lecteur qui ne distingue pas les deux rend ces cas faux dès l'écriture. Tous les
// motifs d'absence sont donc appliqués à `TEXTE` — commentaires retirés — et jamais
// à `TEXTE_BRUT`. Le premier cas ci-dessous contrôle cette distinction sur un
// échantillon écrit ici même, pour qu'elle ne repose pas sur la relecture.
//
// ─── Trappe de test ─────────────────────────────────────────────────────────
//
// `CI_YML` désigne le fichier à lire, avec repli sur `.github/workflows/test.yml`.
// Figée par `plan/contrat.md`, au même titre qu'`ACTION_YML` au lot 4 : sans elle,
// aucune mutation ne peut être essayée sans modifier le vrai workflow du dépôt, et
// un test qu'on ne peut pas faire rougir ne prouve rien. Elle n'est lue par rien
// d'autre que ce harnais.
//
// Ce harnais contrôle des NOMS et des VALEURS, jamais de la prose : aucune
// assertion ne porte sur le texte d'un commentaire ni sur un `name:` de job ou de
// step, pour qu'une reformulation ne le fasse pas rougir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');
const CHEMIN_CI = process.env.CI_YML
  ? path.resolve(process.env.CI_YML)
  : path.join(RACINE, '.github', 'workflows', 'test.yml');
const CHEMIN_CONTRAT = path.join(RACINE, 'plan', 'contrat.md');
const CHEMIN_ACTION = path.join(RACINE, 'action.yml');

const TEXTE_BRUT = fs.readFileSync(CHEMIN_CI, 'utf8');

// ═════════════════════════════════════════════════════════════════════════════
// Lecture du workflow
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Marque les lignes qui appartiennent au CONTENU d'un bloc scalaire (`run: |`).
 *
 * Sert à deux choses. D'abord à ne pas appliquer aux corps de `run:` le garde-fou
 * « commentaire en fin de ligne » : `echo "a: b # c"` est du shell parfaitement
 * légitime. Ensuite à documenter que ces lignes ne sont PAS du mapping YAML.
 *
 * @param {string[]} lignes
 * @returns {boolean[]} un drapeau par ligne
 */
function indicesDeBlocLitteral(lignes) {
  const dans = new Array(lignes.length).fill(false);
  for (let i = 0; i < lignes.length; i += 1) {
    const m = lignes[i].match(/^( *)(?:- )?[A-Za-z0-9_.-]+: *(?:\||\|-|>|>-) *$/);
    if (!m) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < lignes.length; j += 1) {
      if (lignes[j].trim() === '') {
        dans[j] = true;
        continue;
      }
      if (lignes[j].match(/^ */)[0].length <= indent) break;
      dans[j] = true;
    }
  }
  return dans;
}

/**
 * Retire les lignes de commentaire — ET SEULEMENT ELLES.
 *
 * Un commentaire de ligne entière est retiré partout, y compris dans un corps de
 * `run:` où c'est un commentaire shell : les motifs d'absence ne doivent pas plus
 * rougir sur `# pas de ${{ … }} ici` que sur la ligne YAML équivalente.
 *
 * Un commentaire en FIN de ligne de mapping est refusé net : il fausserait la
 * lecture des valeurs, et ce harnais préfère lever que deviner.
 */
function retirerCommentaires(texte) {
  const lignes = texte.split('\n');
  const litteral = indicesDeBlocLitteral(lignes);
  for (const [i, ligne] of lignes.entries()) {
    if (/^\s*#/.test(ligne)) continue;
    if (litteral[i]) continue;
    if (/^\s*(?:- )?[A-Za-z0-9_.-]+:\s.*\s#/.test(ligne)) {
      throw new Error(
        `${CHEMIN_CI} porte un commentaire en fin de ligne, que ce harnais ne sait ` +
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

/**
 * Les lignes du bloc introduit par `nomCle:` à l'indentation zéro, ou `null`.
 *
 * Rend `null` plutôt que de lever : `permissions:` déplacé dans un job est une
 * faute qu'un message d'assertion explique mieux qu'une exception au chargement.
 */
function lignesDuBlocRacine(nomCle) {
  const debut = LIGNES.findIndex((ligne) => ligne === `${nomCle}:`);
  if (debut === -1) return null;
  let fin = LIGNES.length;
  for (let i = debut + 1; i < LIGNES.length; i += 1) {
    if (LIGNES[i].trim() !== '' && !/^\s/.test(LIGNES[i])) {
      fin = i;
      break;
    }
  }
  return LIGNES.slice(debut + 1, fin);
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
      if (reste.trim() !== '') courant.set('', valeurScalaire(reste));
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
 * Les steps d'un bloc `steps:`, le tiret à l'indentation `indentTiret`.
 *
 * Chaque step est rendu sous la forme `{ cles: Map, env: Map|null, avec: Map|null }`.
 * Indentations attendues, pour un tiret à 6 : `      - cle: valeur` pour l'item,
 * `        cle: valeur` pour ses autres clés, `          CLE: valeur` pour les
 * sous-clés de `env:` et de `with:`, et un bloc scalaire `run: |` dont le contenu
 * est à dix espaces ou plus. Le contenu du bloc est rendu désindenté de dix.
 */
function analyserSteps(lignes, indentTiret) {
  const indentCle = indentTiret + 2;
  const indentSous = indentTiret + 4;
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
      if (ligne.trim() === '' || ligne.startsWith(' '.repeat(indentSous))) {
        bloc.lignes.push(ligne.slice(indentSous));
        continue;
      }
      cloreBloc();
    }
    if (ligne.trim() === '') continue;

    let m = ligne.match(new RegExp(`^ {${indentTiret}}- (\\S.*)$`));
    if (m) {
      courant = { cles: new Map(), env: null, avec: null };
      steps.push(courant);
      imbrique = null;
      poserCle(m[1]);
      continue;
    }
    m = ligne.match(new RegExp(`^ {${indentCle}}(\\S.*)$`));
    if (m) {
      poserCle(m[1]);
      continue;
    }
    m = ligne.match(new RegExp(`^ {${indentSous}}(\\S.*)$`));
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

/** Les jobs, dans l'ordre du fichier : `{ id, cles, steps }`. */
function analyserJobs(lignesJobs) {
  const brut = [];
  let courant = null;
  for (const ligne of lignesJobs) {
    if (ligne.trim() === '') {
      if (courant) courant.lignes.push(ligne);
      continue;
    }
    const m = ligne.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      courant = { id: m[1], lignes: [] };
      brut.push(courant);
      continue;
    }
    if (!/^ {4}\S/.test(ligne) && !/^ {5,}/.test(ligne)) {
      throw new Error(`ligne du bloc jobs: non lisible par ce harnais : ${JSON.stringify(ligne)}`);
    }
    if (courant === null) {
      throw new Error(`ligne de job sans identifiant de job : ${JSON.stringify(ligne)}`);
    }
    courant.lignes.push(ligne);
  }
  return brut.map((job) => {
    const index = job.lignes.findIndex((ligne) => ligne === '    steps:');
    if (index === -1) {
      throw new Error(`le job « ${job.id} » ne déclare pas de bloc « steps: ».`);
    }
    return {
      id: job.id,
      cles: clesDeNiveau(job.lignes, 4),
      steps: analyserSteps(job.lignes.slice(index + 1), 6),
    };
  });
}

const LIGNES_JOBS = lignesDuBlocRacine('jobs');
if (LIGNES_JOBS === null) {
  throw new Error(`${CHEMIN_CI} ne déclare aucun bloc « jobs: » à l'indentation zéro.`);
}
const JOBS = analyserJobs(LIGNES_JOBS);
const PAR_ID = new Map(JOBS.map((job) => [job.id, job]));
const TOUS_LES_STEPS = JOBS.flatMap((job) => job.steps.map((step) => ({ job, step })));

/**
 * Le corps d'un `run:`, ou `''` — bloc scalaire comme scalaire d'une ligne.
 *
 * Les commentaires shell en sont ôtés, ceux de FIN DE LIGNE compris : `retirerCommentaires`
 * n'ôte que les lignes entières. Sans quoi tous les motifs ancrés de ce fichier —
 * `^ *node "$suite" *$`, `^ *exit +…`, les motifs d'absence de `-exec` et de `${{ … }}` —
 * rougiraient sur un `node "$suite"   # commentaire`, qui est du shell parfaitement
 * légitime. « Contenu et commentaires sont deux choses », et l'endroit où le trancher est
 * ici, une fois, plutôt que dans chaque assertion.
 */
function corpsDuRun(step) {
  return retirerCommentairesShell(step.cles.get('run') || '');
}

/** Un libellé qui identifie un step dans un message d'échec. */
function nomDuStep(job, step, index) {
  const propre =
    step.cles.get('id') ||
    step.cles.get('uses') ||
    step.cles.get('name') ||
    `step #${index + 1}`;
  return `${job.id} / ${propre}`;
}

/** Le seul step d'un job dont le corps de `run:` contient `motif`. */
function stepUnique(idJob, motif, quoi) {
  const job = PAR_ID.get(idJob);
  assert.ok(job, `le job « ${idJob} » n'existe pas`);
  const trouves = job.steps.filter((step) => corpsDuRun(step).includes(motif));
  assert.equal(
    trouves.length,
    1,
    `un seul step de « ${idJob} » doit ${quoi} (motif ${JSON.stringify(motif)}), ` +
      `${trouves.length} trouvé(s)`,
  );
  return trouves[0];
}

/** Échappe une chaîne pour l'insérer telle quelle dans une expression rationnelle. */
function echapper(texte) {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═════════════════════════════════════════════════════════════════════════════
// Les trois bans de forme des corps de `run:` — des PROPRIÉTÉS, pas des graphies
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Retire les commentaires shell d'une ligne, entiers comme de fin de ligne.
 *
 * Un ban qui rougit sur un commentaire est faux : le workflow CITE `|| true` et
 * `set +e` dans ses commentaires pour expliquer qu'il ne les emploie pas, comme il
 * cite `ubuntu-latest` et `-exec`. `retirerCommentaires` n'ôte que les commentaires
 * de LIGNE ENTIÈRE ; celui-ci ôte aussi ceux de fin de ligne, en tenant compte des
 * guillemets, pour que `echo "clef: valeur # pas un commentaire"` reste intact.
 *
 * Limite assumée : la lecture est ligne à ligne, donc une chaîne à guillemets ouverte
 * sur plusieurs lignes serait mal jugée — ce fichier n'en contient aucune. Et un motif
 * banni écrit à l'intérieur d'une chaîne (`echo "a || b"`) rougirait : fail-closed,
 * assumé, il n'y en a aucun aujourd'hui.
 */
function retirerCommentairesShell(corps) {
  return corps
    .split('\n')
    .map((ligne) => {
      let simple = false;
      let doubles = false;
      for (let i = 0; i < ligne.length; i += 1) {
        const c = ligne[i];
        if (c === '\\' && !simple) {
          i += 1;
          continue;
        }
        if (c === "'" && !doubles) {
          simple = !simple;
          continue;
        }
        if (c === '"' && !simple) {
          doubles = !doubles;
          continue;
        }
        if (c === '#' && !simple && !doubles && (i === 0 || /[ \t]/.test(ligne[i - 1]))) {
          return ligne.slice(0, i);
        }
      }
      return ligne;
    })
    .join('\n');
}

// Deux propriétés, exprimées comme telles. Énumérer des orthographes ne ferme pas une
// famille : le ban précédent portait sur `|| true` et `set +e`, et laissait passer
// `|| :`, `|| exit 0`, `set +o errexit` et `set +ex` — tous mesurés verts.
const BANS_DE_FORME = [
  {
    motif: /\|\|/,
    quoi: 'une alternation « || »',
    // Ce message a été réécrit parce qu'il accusait la mauvaise cause sur les deux
    // formes que ce ban refuse à tort. Mesuré : `[ -f "$archive" ] || exit 1` sort en 1,
    // et `command -v pipx >/dev/null || { echo "::error::absent"; exit 1; }` — la garde
    // qu'emploie `action.yml` lui-même — aussi. Elles n'avalent RIEN, elles font
    // l'inverse : leur dire qu'elles « avalent le code de retour » envoie relire un
    // script correct. Le ban reste, mais il doit nommer son exception et donner la
    // forme de remplacement.
    pourquoi:
      'une alternation dont le maillon gauche ÉCHOUE remplace son code de retour par ' +
      'celui du maillon droit : « || true », « || : », « || echo … », « || exit 0 » ' +
      'rendent le step vert. Mesuré : « sha256sum -c - || : » n’impose plus du tout le ' +
      'condensat d’actionlint. EXCEPTION, nommée ici pour que ce message n’accuse pas la ' +
      'mauvaise cause : « || exit 1 » et « cmd || { echo "::error::…"; exit 1; } » ne ' +
      'l’avalent pas, elles sortent en 1. Le ban les refuse quand même, parce qu’il est ' +
      'une PROPRIÉTÉ et non un tri de graphies — aucun motif ne distingue de façon fiable ' +
      'un maillon droit qui échoue d’un maillon droit qui absout. Écrire à la place ' +
      '« if … ; then echo "::error::…"; exit 1; fi », que le ban du « ; » admet, y compris ' +
      'sur une seule ligne. Ce workflow ne contient AUCUN « || »',
  },
  {
    // Ne bannit PAS `set -x`, et le ban précédent, `/\bset\s+\+/`, avait l'intention
    // exactement inversée : il refusait `set +x`, qui MASQUE la trace, tandis que
    // `set -x`, qui la DÉVERSE, n'était refusé par rien. La question se reposera, d'où
    // la réponse ici : ce workflow ne porte aucun secret — pas un `secrets.*` (tenu par un
    // cas à lui, « aucun "secrets." en contenu »), pas un
    // jeton dans un `env:` de step, la clé DeepSeek des deux smokes vaut la chaîne
    // « factice » — donc la trace n'y expose rien, et `set -x` reste permis. Le ban ne
    // porte que sur ce qui DÉSARME la détection d'échec.
    motif: /\bset\s+(?:\+o\s+(?:errexit|pipefail)\b|\+[A-Za-z]*e[A-Za-z]*\b)/,
    quoi: 'un « set + » qui désarme la détection d’échec',
    pourquoi:
      '« set +e », « set +ex », « set +o errexit » et « set +o pipefail » rendent le step ' +
      'vert quoi qu’il échoue ensuite. Mesuré en shell : « set -eo pipefail ; ' +
      'set +o errexit ; for f in un deux trois; do false; done » déroule TOUS les tours ' +
      'et rend 0 — 191 cas sur 202 peuvent rougir sans que le job des suites bouge. Sont ' +
      'permis les « set + » qui ne touchent pas à la détection d’échec, « set +x » ' +
      'compris, et « set -x » n’est refusé par rien : ce workflow ne porte aucun secret. ' +
      'Cette prémisse n’est pas une croyance, elle est tenue par le cas « aucun ' +
      '"secrets." en contenu » ci-dessous',
  },
];

// Les formes où un `;` n'enchaîne PAS une commande dont le code de retour remplace celui
// de la précédente : dans une compound command, il sépare l'en-tête de son mot-clé
// (`for … ; do`) ou ferme la forme écrite sur une seule ligne (`… ; fi`).
//
// Deux défauts mesurés de la version précédente, qui refusait du shell légitime — et un
// ban qui refuse le légitime est un ban qu'on finira par retirer en entier :
//   `if [ -n "$RUNNER_TEMP" ]; then echo "temp ok"; fi` sur une seule ligne rougissait,
//   parce que le `String.replace` était SANS `g` : il n'ôtait que le `; then` et laissait
//   le `; fi`. Idem pour `for f in a b; do echo "$f"; done`.
//   `; fi`, `; done`, `; esac`, `; elif`, `; else` n'étaient admis nulle part, et ni
//   `elif`, ni `until`, ni `select`, ni `case` ne figuraient parmi les en-têtes.
// D'où un remplacement GLOBAL et les deux listes ci-dessous.
const TETE_COMPOUND = /^\s*(?:if|elif|for|while|until|select|case)\b/;
const SEPARATEUR_LEGITIME = /;[ \t]*(?:do|then|elif|else|fi|done|esac)\b/g;

/**
 * Les infractions de forme du corps d'un `run:`, messages compris. Vide si propre.
 *
 * Rendue comme une liste et non comme un booléen : un même corps peut porter plusieurs
 * infractions, et le message doit les nommer toutes plutôt que la première.
 */
function infractionsDeForme(corps) {
  // Ce nettoyage FAIT DOUBLON avec celui de `corpsDuRun`, et le doublon est voulu — la
  // fonction est idempotente. Lequel des deux prouve quoi, puisque la question s'est
  // posée en relecture : celui-ci est le seul en jeu pour la contre-épreuve
  // « les trois bans épargnent les commentaires … », qui appelle `infractionsDeForme`
  // sur des chaînes BRUTES écrites dans le test, sans passer par `corpsDuRun` ; celui de
  // `corpsDuRun` est le seul en jeu pour tous les motifs ANCRÉS de ce fichier
  // (`^ *node "$suite" *$`, `^ *exit +…`), que la contre-épreuve ne touche pas. Retirer
  // l'un des deux rendrait donc l'autre famille de cas fausse, et le retrait ne serait
  // pas signalé par les cas qui semblent porter la preuve. Les deux restent.
  const nu = retirerCommentairesShell(corps);
  const infractions = [];
  for (const ban of BANS_DE_FORME) {
    if (ban.motif.test(nu)) infractions.push(`${ban.quoi} — ${ban.pourquoi}`);
  }
  for (const ligne of nu.split('\n')) {
    if (!ligne.includes(';')) continue;
    // `;;` termine une clause de `case`. Ce n'est jamais un enchaînement de commandes —
    // hors `case`, bash refuse la ligne — et il apparaît sur des lignes qui ne commencent
    // par aucun mot-clé (`  success) echo ok ;;`). Il est donc ôté sans condition
    // d'en-tête, contrairement aux séparateurs ci-dessous.
    let reste = ligne.replace(/;;/g, ' ');
    if (TETE_COMPOUND.test(ligne)) reste = reste.replace(SEPARATEUR_LEGITIME, ' ');
    if (!reste.includes(';')) continue;
    infractions.push(
      `un « ; » hors compound command, sur ${JSON.stringify(ligne.trim())} — un « ; » de ` +
        `fin de commande enchaîne une commande dont le code de retour remplace celui de la ` +
        `précédente : mesuré, « sha256sum -c - ; true » n’impose plus le condensat ` +
        `d’actionlint. Sont admis « ; do », « ; then », « ; elif », « ; else », « ; fi », ` +
        `« ; done » et « ; esac » sur une ligne qui COMMENCE par if/elif/for/while/until/` +
        `select/case — la forme sur une seule ligne comprise —, et « ;; » partout, qui ` +
        `ferme une clause de case`,
    );
  }
  return infractions;
}

/**
 * La boucle `for VAR in MOTIF … do … done` d'un corps de `run:`, et son CORPS.
 *
 * Pourquoi séparer le corps : deux assertions indépendantes, l'une sur l'en-tête de
 * la boucle et l'autre sur la présence d'un `node "$…"` n'importe où dans le step, se
 * satisfont d'un corps qui ne fait qu'`echo` plus un `node` sur une seule suite hors
 * boucle. Mesuré : le job passait de 195 cas à 11, et ce harnais restait vert.
 *
 * Ce n'est pas un parseur shell, même doctrine que pour le YAML : le `done` est cherché
 * à l'indentation EXACTE du `for`, et la fonction lève sur tout ce qu'elle ne sait pas
 * juger plutôt que de deviner.
 */
function boucleFor(corps, motif) {
  const lignes = corps.split('\n');
  const enTete = new RegExp(`^( *)for +([A-Za-z_][A-Za-z0-9_]*) +in +${echapper(motif)} *;? *(do)? *$`);
  const trouvees = lignes
    .map((ligne, i) => ({ i, m: ligne.match(enTete) }))
    .filter(({ m }) => m !== null);
  if (trouvees.length !== 1) {
    throw new Error(
      `${trouvees.length} boucle(s) « for … in ${motif} » dans ce corps de run:, une ` +
        `seule attendue.`,
    );
  }
  const { i, m } = trouvees[0];
  const [, indent, variable, doSurLaMemeLigne] = m;
  let debut = i + 1;
  if (!doSurLaMemeLigne) {
    if (lignes[debut] === undefined || lignes[debut].trim() !== 'do') {
      throw new Error(`la boucle « for … in ${motif} » n’est suivie d’aucun « do ».`);
    }
    debut += 1;
  }
  const fin = lignes.findIndex((ligne, j) => j >= debut && ligne === `${indent}done`);
  if (fin === -1) {
    throw new Error(
      `la boucle « for … in ${motif} » n’est fermée par aucun « done » à l’indentation ` +
        `de son « for » (${indent.length} espaces).`,
    );
  }
  return { variable, corps: lignes.slice(debut, fin).join('\n') };
}

/**
 * Recolle les continuations de ligne `\`, comme le fait le shell.
 *
 * Un contrôle qui refuse une édition légitime est un contrôle qu'on finira par retirer —
 * et c'est alors la famille entière qui se rouvre. Mesuré ROUGE sur la version précédente
 * de ce lecteur, avec la commande du `node --check` coupée en deux :
 *
 *     find scripts test -name '*.js' -print0 \
 *       | xargs -0 -n1 node --check
 *
 * Couper une ligne de 74 caractères est une édition ordinaire, et le message d'échec
 * énumérait les jetons trouvés sans nommer la cause. Le recollage se fait ici, avant tout
 * découpage, et vaut pour une coupure AVANT comme APRÈS le `|`.
 *
 * Portée volontairement locale au lecteur du tube, et non posée dans `corpsDuRun` : les
 * motifs ancrés du reste de ce fichier (`^ *node "$suite" *$`, `^ *exit +…`) et les bans de
 * forme jugent le texte ligne à ligne, et le recollage y déplacerait des lignes sans
 * qu'aucun cas ne le contrôle. Le workflow ne porte aujourd'hui aucune continuation
 * ailleurs ; le jour où il en portera une, c'est ce commentaire qu'il faudra relire.
 */
function recollerContinuations(corps) {
  return corps.replace(/\\\n[ \t]*/g, ' ');
}

/**
 * Le tube du contrôle syntaxique, découpé à SES DEUX BORDS :
 * `{ repertoires, predicat, aval }`, ou `null` si le corps ne porte aucun tube.
 *
 * Les trois listes sont rendues comme des LISTES DE JETONS, jamais comme un texte à
 * fouiller, parce que les deux bords se vident par AJOUT et qu'un contrôle par présence
 * reste alors vert. Trois mesures sur ce dépôt, chacune avec un `scripts/casse.js` bien
 * réel, chacune à 31 cas sur 31 et `actionlint` à 0, chacune avec un tube qui rend 0 :
 *
 *   `-name '*.js'` muté en `-name '*.mjs'` : ZÉRO fichier dans le lot ;
 *   `find scripts test -path nulle-part -name '*.js' -print0 | …` : le `-name '*.js'` est
 *   toujours là, un prédicat AJOUTÉ suffit à vider le lot ;
 *   `| xargs -0 -n1 node --check --help` : le lot est intact, mais `node` sort en 0 avant
 *   d'avoir rien lu. Mesuré sous Node v24.19.0, un par un : `--help`, `--version` et `-v`
 *   rendent le tube 0. `-n1` retiré ou passé à `-n2` fait de même, par l'autre mécanisme —
 *   `node --check bon.js casse.js` rend 0.
 *
 * Le troisième est le même trou que les deux premiers, de l'autre côté du tube : épingler
 * le `find` par égalité et laisser libre ce qui suit `node --check` ne ferme rien. Les deux
 * bords sont donc rendus, et le cas qui les lit les contrôle par égalité tous les deux.
 *
 * Deux jetons sont refusés par cette égalité SANS absoudre quoi que ce soit, et c'est dit
 * ici pour que le message du cas n'accuse pas la mauvaise cause : mesuré, `xargs -P 4` et
 * `node --check -p 1` laissent le tube rendre 1. Ils sont refusés parce que l'égalité est
 * une PROPRIÉTÉ et non un tri de graphies — aucun motif ne distingue de façon fiable un
 * jeton ajouté qui contrôle d'un jeton ajouté qui absout.
 *
 * Ce n'est pas un parseur shell, même doctrine que pour le YAML : la ligne analysée est LA
 * ligne qui porte un `|` — pas la première ligne qui contient `find` —, et la fonction lève
 * sur tout ce qu'elle ne sait pas juger, plutôt que de deviner.
 */
function analyserTubeDuCheck(corps) {
  const lignes = recollerContinuations(corps).split('\n');
  const portantes = lignes.filter((ligne) => ligne.includes('|'));
  if (portantes.length === 0) return null;
  if (portantes.length !== 1) {
    throw new Error(
      `${portantes.length} lignes de ce corps de run: portent un « | », une seule ` +
        `attendue : ce lecteur ne saurait pas dire laquelle contrôle la syntaxe. Lignes : ` +
        `${JSON.stringify(portantes.map((ligne) => ligne.trim()))}`,
    );
  }
  const morceaux = portantes[0].split('|');
  if (morceaux.length !== 2) {
    throw new Error(
      `la ligne ${JSON.stringify(portantes[0].trim())} porte ${morceaux.length - 1} « | », ` +
        `un seul attendu.`,
    );
  }
  const amont = morceaux[0].trim().split(/\s+/).filter(Boolean);
  const aval = morceaux[1].trim().split(/\s+/).filter(Boolean);
  if (amont[0] !== 'find') {
    throw new Error(
      `le maillon gauche du tube commence par ${JSON.stringify(amont[0])}, « find » ` +
        `attendu : ${JSON.stringify(portantes[0].trim())}`,
    );
  }
  let i = 1;
  while (i < amont.length && !amont[i].startsWith('-')) i += 1;
  return { repertoires: amont.slice(1, i), predicat: amont.slice(i), aval };
}

// ═════════════════════════════════════════════════════════════════════════════
// Lecture de `plan/contrat.md` — la seule source de vérité pour les noms
// ═════════════════════════════════════════════════════════════════════════════

const LIGNES_CONTRAT = fs.readFileSync(CHEMIN_CONTRAT, 'utf8').split('\n');

/**
 * Les lignes d'une section de `plan/contrat.md`, titre compris, jusqu'au titre suivant
 * de niveau ÉGAL OU SUPÉRIEUR — les sous-sections restent donc dedans.
 *
 * Sert à borner la portée des trois lecteurs de tables ci-dessous, et du garde-fou de
 * forme qui les protège. Le garde-fou portait sur le fichier ENTIER : mesuré, aligner
 * les colonnes de la table des `inputs` — que ce harnais ne lit jamais — faisait LEVER la
 * suite au chargement. Le fail-closed est juste, sa portée ne l'était pas : un contrôle
 * doit refuser ce qui casse sa lecture, pas ce qu'il ne lit pas.
 *
 * La lecture est bornée à la même section que le garde-fou, et non au fichier entier :
 * sinon une ligne alignée ailleurs serait silencieusement écartée d'un lecteur global
 * sans que plus rien ne le signale — exactement le mode de panne que le garde-fou existe
 * pour fermer.
 */
function lignesDeSection(lignes, motifTitre, quoi) {
  const debut = lignes.findIndex((ligne) => motifTitre.test(ligne));
  if (debut === -1) {
    throw new Error(
      `plan/contrat.md ne porte plus de titre pour ${quoi} (motif ${motifTitre}) — la ` +
        `table que ce harnais y lit a changé de nom ou de niveau.`,
    );
  }
  const niveau = lignes[debut].match(/^#+/)[0].length;
  let fin = lignes.length;
  for (let i = debut + 1; i < lignes.length; i += 1) {
    const m = lignes[i].match(/^(#+) /);
    if (m && m[1].length <= niveau) {
      fin = i;
      break;
    }
  }
  return lignes.slice(debut, fin);
}

// Les TROIS sections réellement lues, et elles seules. Déclarées en table et non en trois
// appels dispersés, pour que `verifierLesTablesLues` ci-dessous soit exactement la portée
// du garde-fou : le cas qui contrôle cette portée l'appelle sur des lignes de contrat
// TRUQUÉES, et ne pourrait rien prouver si la portée n'était pas une valeur.
const SECTIONS_LUES = [
  { motif: /^#+ +Versions épinglées *$/, quoi: '« Versions épinglées »' },
  { motif: /^#+ +Suites de test du dépôt *$/, quoi: '« Suites de test du dépôt »' },
  {
    motif: /^#+ +Jobs de `\.github\/workflows\/test\.yml` *$/,
    quoi: '« Jobs de `.github/workflows/test.yml` »',
  },
];

/**
 * Refuse une ligne de tableau markdown que les lecteurs ci-dessous ne savent pas
 * découper, EN LE DISANT.
 *
 * Les trois lecteurs — versions épinglées, suites, jobs — cherchent la forme ancrée
 * « | `valeur` | ». Un simple alignement de colonnes, « | `smoke-local`  | » avec deux
 * espaces, la fait échouer : la ligne est alors silencieusement ignorée, et le cas qui
 * en dépend annonce une DIVERGENCE entre le workflow et le contrat. C'est faux — la
 * table n'a pas changé de contenu, elle n'est plus lisible.
 *
 * Le refus reste : lire un demi-tableau serait pire, puisque les identifiants de cette
 * table sont les noms des checks obligatoires. Seul le message change, pour nommer
 * laquelle des deux choses s'est produite.
 *
 * PORTÉE : appelée une fois par section lue, jamais sur le fichier entier — voir
 * `lignesDeSection`. Reste dans le champ, à l'intérieur d'une section, les tables des
 * sous-sections ; sans effet, leur première cellule n'est jamais un identifiant seul
 * entre accents graves (`| \`-name '*.js'\` → \`'*.mjs'\` |` porte deux jetons et est
 * donc ignorée, comme une ligne d'en-tête).
 */
function verifierFormeDesTables(lignes, ou) {
  for (const ligne of lignes) {
    if (!ligne.startsWith('|')) continue;
    const cellules = ligne.split('|');
    if (cellules.length < 3) continue;
    const premiere = cellules[1].trim();
    // Ni ligne d'en-tête, ni séparateur `| --- |` : seules les lignes dont la première
    // cellule est un identifiant entre accents graves sont concernées.
    if (!/^`[^`]+`$/.test(premiere)) continue;
    if (ligne.startsWith(`| ${premiere} |`)) continue;
    throw new Error(
      `une table de ${ou} n’est pas lisible sous cette forme : ${JSON.stringify(ligne)}. ` +
        `Ce harnais lit la première cellule par un motif ancré « | \`valeur\` | », un seul ` +
        `espace de chaque côté du tube ; un alignement de colonnes par espaces ` +
        `supplémentaires la rend illisible. Ce n’est PAS une divergence de contenu entre ` +
        `le workflow et le contrat. Retirer l’alignement, ou étendre ce lecteur.`,
    );
  }
}

/**
 * Applique le garde-fou de forme aux TROIS sections lues, et à elles seules.
 *
 * Prend les lignes du contrat en paramètre au lieu de lire `LIGNES_CONTRAT` : c'est ce qui
 * rend la portée testable. Le cas « le lecteur de tables du contrat … » l'appelle sur une
 * copie où une ligne a été alignée, table par table, et distingue ainsi « le garde-fou
 * couvre cette table » de « le garde-fou couvre tout le fichier » — ce qu'une assertion
 * portant sur le vrai contrat ne pourrait pas faire.
 */
function verifierLesTablesLues(lignes) {
  for (const { motif, quoi } of SECTIONS_LUES) {
    const ou = `${quoi} de plan/contrat.md`;
    verifierFormeDesTables(lignesDeSection(lignes, motif, ou), ou);
  }
}

verifierLesTablesLues(LIGNES_CONTRAT);

// Le déstructurage ci-dessous rendrait `undefined` sur une entrée retirée de
// `SECTIONS_LUES`, et la panne se manifesterait plus loin par un TypeError qui n'apprend
// rien. Trois sections, dites ici.
if (SECTIONS_LUES.length !== 3) {
  throw new Error(
    `SECTIONS_LUES doit décrire les trois sections de plan/contrat.md que ce harnais lit, ` +
      `${SECTIONS_LUES.length} décrite(s).`,
  );
}
const [SECTION_VERSIONS, SECTION_SUITES, SECTION_JOBS] = SECTIONS_LUES.map(({ motif, quoi }) =>
  lignesDeSection(LIGNES_CONTRAT, motif, `${quoi} de plan/contrat.md`),
);

/** La deuxième cellule de la ligne de tableau dont la première est `` `nom` ``. */
function celluleDuContrat(nom) {
  const lignes = SECTION_VERSIONS.filter((ligne) => ligne.startsWith(`| \`${nom}\` |`));
  if (lignes.length !== 1) {
    throw new Error(
      `plan/contrat.md doit porter exactement une ligne de tableau pour « ${nom} », ` +
        `${lignes.length} trouvée(s) — la table « Versions épinglées » a changé de forme.`,
    );
  }
  return lignes[0].split('|')[2].trim();
}

// Version de `actions/checkout` : `` `v5` `` dans la cellule.
const CHECKOUT_CONTRAT = (() => {
  const m = celluleDuContrat('actions/checkout').match(/^`(v[0-9]+)`$/);
  if (!m) throw new Error('la version de actions/checkout n’est pas lisible dans plan/contrat.md.');
  return m[1];
})();

// Version et condensat d'`actionlint`, dans la même cellule.
const ACTIONLINT_CONTRAT = (() => {
  const cellule = celluleDuContrat('actionlint');
  const version = cellule.match(/^`([0-9]+\.[0-9]+\.[0-9]+)`/);
  const condensat = cellule.match(/SHA-256 `([0-9a-f]{64})`/);
  if (!version || !condensat) {
    throw new Error('la version ou le condensat d’actionlint n’est pas lisible dans plan/contrat.md.');
  }
  return { version: version[1], condensat: condensat[1] };
})();

// Les suites recensées par « Suites de test du dépôt », dans l'ordre du tableau.
// Toutes les suites du contrat, `test/ci.test.js` comprise : sans sa ligne dans le
// job `suites`, supprimer ce harnais ne serait signalé par rien — le glob cesserait
// de le lancer sans un mot, et tous les contrôles du workflow disparaîtraient avec
// lui.
const SUITES_CONTRAT = SECTION_SUITES.map((ligne) =>
  ligne.match(/^\| `(test\/[A-Za-z0-9_.-]+\.test\.js)` \|/),
)
  .filter(Boolean)
  .map((m) => m[1]);

/**
 * Les identifiants de la table « Jobs de `.github/workflows/test.yml` » du contrat.
 *
 * Lus, et non recopiés en littéral. Mesuré avec la liste écrite ici : renommer
 * `smoke-local` dans la table du contrat laissait ce harnais VERT — la divergence
 * n'était détectée que dans un sens, alors que la table est justement l'endroit où
 * les noms des checks obligatoires sont figés.
 */
function jobsDuContrat() {
  // Bornes : la SECTION pour le garde-fou de forme, mais la lecture s'arrête au premier
  // sous-titre. Les deux ne se recouvrent pas exactement, et c'est voulu dans ce sens-là
  // seulement : une table ajoutée dans une sous-section de « Jobs de … » — il y en a deux —
  // serait lue comme une liste d'identifiants de job et ferait rougir le cas 1 en annonçant
  // une divergence qui n'existe pas. Trop strict d'un côté (le garde-fou couvre les
  // sous-sections) vaut mieux que faux de l'autre.
  const identifiants = [];
  for (const [i, ligne] of SECTION_JOBS.entries()) {
    if (i > 0 && /^#/.test(ligne)) break;
    const m = ligne.match(/^\| `([A-Za-z0-9_-]+)` \|/);
    if (m) identifiants.push(m[1]);
  }
  if (identifiants.length === 0) {
    throw new Error(
      'la table « Jobs de `.github/workflows/test.yml` » de plan/contrat.md ne porte ' +
        'aucune ligne « | `<identifiant>` | … | ».',
    );
  }
  return identifiants;
}

const JOBS_CONTRAT = jobsDuContrat();
const JOBS_SMOKE = JOBS_CONTRAT.filter((id) => id.startsWith('smoke'));

// ═════════════════════════════════════════════════════════════════════════════
// Lecture des `outputs:` de `action.yml`
// ═════════════════════════════════════════════════════════════════════════════

/** Les clés du bloc `nomCle:` d'`action.yml`, à l'indentation deux. */
function clesDuBlocDeAction(nomCle) {
  const lignes = fs
    .readFileSync(CHEMIN_ACTION, 'utf8')
    .split('\n')
    .filter((ligne) => !/^\s*#/.test(ligne));
  const debut = lignes.findIndex((ligne) => ligne === `${nomCle}:`);
  if (debut === -1) throw new Error(`action.yml ne déclare pas de bloc « ${nomCle}: ».`);
  const cles = [];
  for (let i = debut + 1; i < lignes.length; i += 1) {
    const ligne = lignes[i];
    if (ligne.trim() === '') continue;
    if (!/^\s/.test(ligne)) break;
    const m = ligne.match(/^( +)([A-Za-z0-9_.-]+):/);
    if (!m) {
      throw new Error(`ligne du bloc « ${nomCle}: » d’action.yml non lisible : ${JSON.stringify(ligne)}`);
    }
    if (m[1].length === 2) cles.push(m[2]);
  }
  return cles;
}

const OUTPUTS_ACTION = new Set(clesDuBlocDeAction('outputs'));

// ═════════════════════════════════════════════════════════════════════════════
// 0 — le lecteur distingue le contenu des commentaires
// ═════════════════════════════════════════════════════════════════════════════

test('le lecteur retire les commentaires de ligne entière et refuse ceux de fin de ligne', () => {
  // Ce cas ne porte pas sur le workflow mais sur le harnais lui-même. Sans lui,
  // quatre cas d'absence ci-dessous (`ubuntu-latest`, `-exec`, `GH_CLI`,
  // `${{ … }}`) seraient FAUX dès l'écriture : le workflow cite chacun de ces
  // motifs dans un commentaire, pour expliquer pourquoi il ne l'utilise pas.
  const echantillon = [
    '# runs-on: ubuntu-latest serait un défaut',
    'jobs:',
    '  a:',
    '    # jamais GH_CLI ici',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: |',
    '          echo "clef: valeur # pas un commentaire YAML"',
  ].join('\n');
  const filtre = retirerCommentaires(echantillon);
  assert.equal(/ubuntu-latest/.test(filtre), false, 'un commentaire de ligne entière doit disparaître');
  assert.equal(/GH_CLI/.test(filtre), false, 'y compris indenté dans un job');
  assert.ok(filtre.includes('ubuntu-24.04'), 'le contenu doit rester');
  // Un `#` dans un corps de `run:` est du shell, pas un commentaire YAML : le
  // garde-fou de fin de ligne ne doit pas s'y déclencher.
  assert.ok(filtre.includes('clef: valeur # pas un commentaire YAML'));

  // En revanche, sur une vraie ligne de mapping, le harnais lève plutôt que de
  // lire « ubuntu-24.04 # provisoire » comme la valeur « ubuntu-24.04 ».
  assert.throws(
    () => retirerCommentaires('jobs:\n  a:\n    runs-on: ubuntu-24.04 # provisoire\n'),
    /commentaire en fin de ligne/,
  );
});

test('le lecteur de tables du contrat refuse un alignement de colonnes en le nommant', () => {
  // Ce cas ne porte pas sur le workflow mais sur le harnais. Mesuré : la table du
  // contrat alignée sur ses colonnes, « | `smoke-local`  | » avec deux espaces, faisait
  // rougir ce fichier en annonçant une DIVERGENCE entre le workflow et le contrat — la
  // ligne était silencieusement ignorée par le lecteur, donc absente de la liste
  // attendue. Le refus est juste, le diagnostic était faux : il envoyait relire deux
  // listes identiques.
  assert.doesNotThrow(() =>
    verifierFormeDesTables(['| `smoke-local` | ce qu’il prouve |'], 'un échantillon'),
  );
  // Ni en-tête ni séparateur ne sont concernés : leur première cellule n'est pas un
  // identifiant entre accents graves.
  assert.doesNotThrow(() =>
    verifierFormeDesTables(['| Job   | Ce qu’il prouve |', '| ---   | --- |'], 'un échantillon'),
  );
  assert.throws(
    () => verifierFormeDesTables(['| `smoke-local`  | ce qu’il prouve |'], 'un échantillon'),
    (erreur) => {
      assert.match(erreur.message, /n’est pas lisible sous cette forme/);
      assert.match(erreur.message, /PAS une divergence/);
      assert.equal(/divergé/.test(erreur.message), false);
      return true;
    },
  );

  // Et sa PORTÉE, qui était le fichier ENTIER : mesuré, aligner les colonnes de la table
  // des `inputs` de plan/contrat.md — une table qu'aucun lecteur de ce harnais ne touche —
  // faisait LEVER la suite au chargement. Un contrôle doit refuser ce qui casse sa lecture,
  // pas ce qu'il ne lit pas.
  //
  // Contrôlé en alignant une ligne dans une COPIE des lignes du contrat, table par table, et
  // non en observant le vrai fichier : une assertion sur le vrai contrat resterait verte si
  // quelqu'un rebranchait le garde-fou sur le fichier entier, puisque le vrai contrat n'est
  // aligné nulle part. C'est la portée qu'il faut faire varier, pas le contenu.
  const aligner = (motifLigne) =>
    LIGNES_CONTRAT.map((ligne) => (motifLigne.test(ligne) ? ligne.replace('` |', '`  |') : ligne));
  const compte = (motifLigne) => LIGNES_CONTRAT.filter((ligne) => motifLigne.test(ligne)).length;

  // Hors portée : la table des inputs. Une seule ligne visée, et son existence est contrôlée
  // — sans quoi « aucune ligne alignée » rendrait ce cas vert pour rien.
  const uneLigneDesInputs = /^\| `deepseek-api-key` \|/;
  assert.equal(compte(uneLigneDesInputs), 1, 'la table des « Inputs de action.yml » a changé de forme');
  assert.doesNotThrow(
    () => verifierLesTablesLues(aligner(uneLigneDesInputs)),
    'le garde-fou de forme couvre la table des « Inputs de action.yml », que ce harnais ne ' +
      'lit jamais : aligner ses colonnes ferait lever la suite au chargement',
  );

  // Dans la portée : les trois tables lues, chacune, et le message doit nommer LAQUELLE.
  for (const [motifLigne, nomAttendu] of [
    [/^\| `actions\/checkout` \|/, 'Versions épinglées'],
    [/^\| `test\/garde\.test\.js` \|/, 'Suites de test du dépôt'],
    [/^\| `smoke-local` \|/, 'Jobs de `.github/workflows/test.yml`'],
  ]) {
    assert.equal(compte(motifLigne), 1, `${motifLigne} doit viser exactement une ligne du contrat`);
    assert.throws(
      () => verifierLesTablesLues(aligner(motifLigne)),
      (erreur) => {
        assert.match(erreur.message, /n’est pas lisible sous cette forme/);
        assert.ok(
          erreur.message.includes(nomAttendu),
          `le message doit nommer la table « ${nomAttendu} », obtenu : ${erreur.message}`,
        );
        return true;
      },
      `aligner une ligne de « ${nomAttendu} » doit être refusé : cette table EST lue`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 — les quatre jobs du contrat
// ═════════════════════════════════════════════════════════════════════════════

test('les quatre jobs du contrat sont déclarés, dans cet ordre, et aucun de plus', () => {
  // Ces identifiants sont les noms des checks obligatoires d'une branche protégée :
  // un job renommé rend le check « en attente » pour toujours, et une PR reste
  // bloquée sans qu'aucun job ne rougisse. La liste attendue est LUE dans la table
  // « Jobs de .github/workflows/test.yml » du contrat, jamais recopiée ici : sinon la
  // divergence n'est vue que dans un sens, et renommer un job dans le contrat seul
  // reste vert. L'ordre est comparé aussi — celui du contrat, qui donne au lecteur du
  // fichier la progression syntaxe → suites → montage réel.
  assert.equal(JOBS_CONTRAT.length, 4, 'plan/contrat.md doit recenser quatre jobs');
  assert.deepEqual(
    JOBS.map((job) => job.id),
    JOBS_CONTRAT,
    'les jobs du workflow et la table « Jobs de … » de plan/contrat.md ont divergé',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 bis — les déclencheurs, et rien qui puisse faire remonter un job vert sans
//         l'avoir exécuté
// ═════════════════════════════════════════════════════════════════════════════

test('on: est push sur main et pull_request sans aucun filtre', () => {
  // Mesuré, tous verts et `actionlint` à 0 : `on: workflow_dispatch:` seul, et
  // `pull_request: paths: ['scripts/**']`. Les quatre identifiants de job sont les
  // checks obligatoires d'une branche protégée : un déclencheur restreint ne rend pas
  // les jobs rouges, il les empêche de TOURNER — le check reste « en attente » et la
  // PR est bloquée, ou pire, la protection ne demande plus rien. Un filtre `paths:`
  // est le cas vicieux : la CI ne tourne plus sur une PR qui ne touche que
  // `plan/` ou `.github/`, c'est-à-dire précisément le fichier que ce harnais lit.
  const lignes = lignesDuBlocRacine('on');
  assert.ok(lignes !== null, 'aucun bloc « on: » à l’indentation zéro');
  const declencheurs = mappingImbrique(lignes, 2);
  assert.deepEqual(
    [...declencheurs.keys()],
    ['push', 'pull_request'],
    'les déclencheurs attendus sont « push » et « pull_request », et eux seuls',
  );
  assert.deepEqual(
    Object.fromEntries(declencheurs.get('push')),
    { branches: '[main]' },
    'le déclencheur « push » doit se limiter à branches: [main]',
  );
  assert.equal(
    declencheurs.get('pull_request').size,
    0,
    'le déclencheur « pull_request » ne doit porter AUCUN filtre (paths:, branches:, ' +
      'types:) : la CI doit tourner sur toute PR',
  );
});

test('aucun if: ni continue-on-error: sur un job ni sur un step', () => {
  // Mesuré, verts et `actionlint` à 0 :
  // `if: github.event_name == 'workflow_dispatch'` sur `smoke-sous-repertoire`, et
  // `continue-on-error: true` sur `suites`. Un job SAUTÉ et un job en
  // `continue-on-error` remontent tous deux VERTS au check obligatoire — la
  // protection de branche ne protège plus, et rien ne le signale.
  // Sur un step, c'est le même mécanisme à l'échelle du dessous : le step
  // d'assertion d'un smoke, sauté ou toléré, laisse le job vert sans avoir rien
  // contrôlé.
  for (const job of JOBS) {
    for (const cle of ['if', 'continue-on-error']) {
      assert.equal(
        job.cles.has(cle),
        false,
        `le job « ${job.id} » porte « ${cle}: » — il remonterait vert sans avoir tourné`,
      );
    }
  }
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    for (const cle of ['if', 'continue-on-error']) {
      assert.equal(
        step.cles.has(cle),
        false,
        `le step « ${nomDuStep(job, step, index)} » porte « ${cle}: »`,
      );
    }
  }
  // Et le fichier entier, pour une clé posée à une indentation que le découpage en
  // jobs et en steps ci-dessus ne saurait pas juger.
  assert.equal(
    /^\s*(?:- )?(?:if|continue-on-error):/m.test(TEXTE),
    false,
    '« if: » ou « continue-on-error: » est présent en contenu',
  );
});

test('aucun corps de run: ne porte « || », « set + », ni un « ; » hors compound command', () => {
  // La famille de mutations qui a survécu à trois batteries : garder l'apparence du
  // contrôle et lui retirer son pouvoir d'échouer. La première correction bannissait
  // deux GRAPHIES, `|| true` et `set +e` — et trois autres graphies de la même famille
  // sont restées vertes, mesurées avec les 28 cas et `actionlint` à 0 :
  //   `sha256sum -c - || :`   le condensat d'actionlint n'est plus imposé du tout ;
  //   `sha256sum -c - ; true` idem ;
  //   `set +o errexit` en tête du step des suites — mesuré en shell,
  //   `set -eo pipefail; set +o errexit; for f in un deux trois; do false; done` déroule
  //   TOUS les tours et rend 0, donc 191 cas sur 202 peuvent rougir sans que le job bouge.
  // D'où trois PROPRIÉTÉS et non trois listes : aucune alternation, aucun `set +` qui
  // désarme la détection d'échec, aucun `;` hors compound command. Leur PORTÉE, elle, a été
  // resserrée à la quatrième passe — voir la contre-épreuve qui suit : un ban qui refuse du
  // shell légitime finit par être retiré en entier, et c'est alors la famille entière qui
  // se rouvre.
  // Ce qu'aucun motif ne peut fermer, et que ce cas ne prétend pas couvrir : un
  // `&& false` qui laisse tout le texte en place et change la SÉMANTIQUE du shell.
  // Inscrit comme limite connue dans plan/contrat.md.
  //
  // Appliqué step par step et non sur `TEXTE` : `analyserSteps` LÈVE sur toute ligne
  // qu'elle ne sait pas juger, donc « tous les steps » est bien tous les steps, et le
  // message peut nommer celui qui fraude. Un ban sur le fichier entier porterait en plus
  // sur la prose des `name:`, ce que ce harnais s'interdit.
  assert.ok(TOUS_LES_STEPS.length > 0, 'aucun step trouvé — le fichier a changé de forme');
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    const infractions = infractionsDeForme(corpsDuRun(step));
    assert.deepEqual(
      infractions,
      [],
      `le corps du run: du step « ${nomDuStep(job, step, index)} » porte ` +
        `${infractions.join(' ; ')}. Ces trois interdits sont des propriétés, pas des ` +
        `graphies : voir « Ce que test/ci.test.js interdit désormais, et qui contraint ` +
        `les éditions futures » dans plan/contrat.md avant d’en lever un.`,
    );
  }
});

test('les trois bans épargnent les commentaires et les compound commands légitimes', () => {
  // Contre-épreuve, et elle vaut autant que les bans eux-mêmes : un ban qui rougit sur
  // un commentaire est faux. Le workflow CITE `|| true` et `set +e` dans ses
  // commentaires pour expliquer qu'il ne les emploie pas, exactement comme il cite
  // `ubuntu-latest` et `-exec`.
  //
  // Un niveau a été RETIRÉ d'ici, et pourquoi doit rester écrit : il passait
  // `retirerCommentaires('# … || true …')` à `infractionsDeForme`, donc une chaîne dont la
  // ligne était DÉJÀ partie. L'assertion passait quels que soient les bans — un cas qui ne
  // peut pas rougir, dans une contre-épreuve dont le sujet est justement « les cas qui ne
  // peuvent pas rougir ». Le commentaire YAML de ligne entière est prouvé par le cas
  // « le lecteur retire les commentaires de ligne entière … », et le commentaire shell de
  // ligne entière par les deux premières lignes de l'échantillon ci-dessous, qui passent
  // par le nettoyage propre à `infractionsDeForme`.
  //
  // Niveau 1 : le commentaire shell dans un corps de `run:`, entier ou en fin de ligne.
  const commente = [
    '# ni « || : » ni « set +e » ici',
    '  # pas plus que « sha256sum -c - ; true »',
    'sha256sum -c -   # ni ici : || exit 0 ; set +ex',
  ].join('\n');
  assert.deepEqual(infractionsDeForme(commente), []);

  // Un `#` dans une CHAÎNE n'ouvre pas un commentaire, et ne doit donc rien absoudre de ce
  // qui le suit : fail-closed dans le bon sens.
  assert.ok(
    infractionsDeForme('echo "a # b" || true').length >= 1,
    'un « # » entre guillemets ne doit pas masquer un vrai « || true »',
  );
  assert.ok(
    infractionsDeForme('echo "# pas un commentaire" ; true').length >= 1,
    'un « # » entre guillemets ne doit pas masquer un vrai « ; true »',
  );

  // Niveau 2 : les formes légitimes, dont les deux qui sont dans le workflow.
  const legitime = [
    'if [ -n "$POURSUIVRE" ]; then',
    '  echo "poursuivre non vide"',
    'fi',
    'for suite in test/*.test.js; do',
    '  node "$suite"',
    'done',
    'while read -r ligne; do',
    '  echo "$ligne"',
    'done < liste',
    'echo "clef: valeur # pas un commentaire"',
  ].join('\n');
  assert.deepEqual(infractionsDeForme(legitime), []);

  // Niveau 2 bis : les compound commands écrites sur UNE SEULE ligne. Toutes mesurées
  // ROUGES avant correction, et toutes légitimes — `if [ -n "$RUNNER_TEMP" ]; then
  // echo "temp ok"; fi` est même la forme que le message du ban « || » recommande. Cause :
  // le `replace` sans `g` n'ôtait que le premier séparateur et laissait le `; fi`, et ni
  // `; done`, ni `; esac`, ni `elif`, ni `until`, ni `case`/`;;` n'étaient prévus. Chacune
  // est ici parce qu'elle a rougi, pas par symétrie.
  for (const uneLigne of [
    'if [ -n "$RUNNER_TEMP" ]; then echo "temp ok"; fi',
    'for f in a b; do echo "$f"; done',
    'while read -r l; do echo "$l"; done < liste',
    'until [ -f "$archive" ]; do sleep 1; done',
    'if [ -n "$A" ]; then echo a; elif [ -n "$B" ]; then echo b; else echo c; fi',
    'case "$STATUT" in success) echo ok ;; *) echo ko ;; esac',
    '  success) echo ok ;;',
  ]) {
    assert.deepEqual(
      infractionsDeForme(uneLigne),
      [],
      `« ${uneLigne} » est du shell légitime : un ban qui refuse le légitime est un ban ` +
        `qu’on finira par retirer en entier`,
    );
  }

  // Niveau 2 ter : et la teneur du ban survit à ces admissions — un « ; » qui enchaîne
  // vraiment reste refusé, y compris DANS une compound command d'une seule ligne.
  for (const fraudeCompound of [
    'if [ -f "$suite" ]; then node "$suite"; true; fi',
    'for f in a b; do sha256sum -c -; true; done',
    'if [ -f x ]; then echo ok; fi; true',
  ]) {
    assert.ok(
      infractionsDeForme(fraudeCompound).length >= 1,
      `« ${fraudeCompound} » enchaîne une commande qui remplace le code de retour et doit ` +
        `rester refusée : admettre « ; fi » ne doit pas ouvrir « ; true »`,
    );
  }

  // Et l'inverse : les cinq graphies mesurées vertes rougissent bien, chacune.
  for (const fraude of [
    'sha256sum -c - || :',
    'sha256sum -c - || true',
    'node "$suite" || exit 0',
    'sha256sum -c - ; true',
    'set +e',
    'set +o errexit',
    'set +o pipefail',
    'set +ex',
  ]) {
    assert.ok(
      infractionsDeForme(fraude).length >= 1,
      `« ${fraude} » doit être refusée par les bans de forme`,
    );
  }

  // Ce que le ban « set + » ne refuse PAS, et l'intention qu'il avait à l'envers : le
  // motif précédent était `/\bset\s+\+/`, qui refusait `set +x` — lequel MASQUE la trace —
  // pendant que `set -x`, qui la DÉVERSE, n'était refusé par rien. Le ban ne porte plus que
  // sur ce qui désarme la détection d'échec. `set -x` reste permis : ce workflow ne porte
  // aucun secret, la trace n'y expose rien — prémisse tenue par le cas « aucun
  // "secrets." en contenu », et non par la relecture.
  for (const permis of ['set -x', 'set +x', 'set -eo pipefail', 'set +o xtrace']) {
    assert.deepEqual(
      infractionsDeForme(permis),
      [],
      `« ${permis} » ne désarme pas la détection d’échec et ne doit pas être refusée`,
    );
  }

  // Deux formes LÉGITIMES que le ban « || » refuse quand même. Épinglées ici pour que la
  // décision soit visible plutôt que subie : mesuré, `[ -f "$archive" ] || exit 1` et
  // `command -v pipx >/dev/null || { echo "::error::absent"; exit 1; }` — la garde
  // qu'emploie `action.yml` lui-même — sortent en 1. Elles n'avalent RIEN, elles font
  // l'inverse. Le ban reste, parce qu'aucun motif ne distingue de façon fiable un maillon
  // droit qui échoue d'un maillon droit qui absout ; mais son message doit nommer
  // l'exception et donner la forme de remplacement, sans quoi il envoie relire un script
  // correct en accusant la mauvaise cause.
  for (const legitimeRefusee of [
    '[ -f "$archive" ] || exit 1',
    'command -v pipx >/dev/null || { echo "::error::absent"; exit 1; }',
  ]) {
    const joint = infractionsDeForme(legitimeRefusee).join(' ; ');
    assert.notEqual(joint, '', `« ${legitimeRefusee} » doit rester refusée par le ban « || »`);
    assert.ok(
      joint.includes('« || exit 1 »'),
      'le message du ban « || » doit NOMMER l’exception « || exit 1 », qui sort en 1 au ' +
        'lieu d’avaler le code de retour',
    );
    assert.ok(
      joint.includes('if … ; then echo "::error::…"; exit 1; fi'),
      'le message du ban « || » doit renvoyer à la forme « if », que le ban du « ; » admet',
    );
  }

  // Ce que les bans ne ferment PAS, écrit ici pour qu'on ne s'y trompe pas : `&& false`
  // garde tout le texte attendu et rend le step vert. Voir plan/contrat.md,
  // « Ce qu'aucun lecteur statique ne peut fermer ».
  assert.deepEqual(infractionsDeForme('if [ ! -f "$suite" ] && false; then'), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 ter — la prémisse qui autorise `set -x`
// ═════════════════════════════════════════════════════════════════════════════

// Les deux façons d'amener un jeton dans ce fichier. `github.token` compte autant que
// `secrets.` : c'est la valeur que `action.yml` verse dans `GH_TOKEN`, et elle passait.
const MOTIF_SECRET = /secrets\.|github\.token/;

test('aucun « secrets. » ni « github.token » en contenu — c’est cette absence qui autorise « set -x »', () => {
  // Ce cas ne contrôle pas un défaut, il ATTACHE UNE DÉCISION À SA PRÉMISSE. Le ban
  // « set + » ci-dessus permet délibérément `set -x`, qui DÉVERSE la trace de toutes les
  // commandes dans les logs publics du run, et le motive en une phrase : ce workflow ne
  // porte aucun secret. Vérifié vrai au moment de l'écrire — pas un `secrets.` dans le
  // fichier, et les seules clés d'`env:` de step sont `VERSION_ACTIONLINT`,
  // `SHA256_ACTIONLINT`, `POURSUIVRE`, `SUCCES`, `NUMERO_PR`, la clé DeepSeek des deux
  // smokes valant la chaîne « factice ».
  //
  // Mais rien ne TENAIT cette prémisse : un `env: JETON: ${{ secrets.MACHIN }}` ajouté à
  // un step est mesuré VERT sur la version précédente de ce fichier — le cas 17 ne juge
  // que les valeurs de la forme `steps.<id>.outputs.<nom>` et écarte les autres. La
  // permission serait alors devenue fausse sans que rien ne bouge, et c'est exactement
  // l'ordre dans lequel une trace finit par recracher un jeton.
  //
  // Appliqué à `TEXTE` et jamais à `TEXTE_BRUT`, comme tous les motifs d'absence de ce
  // fichier : citer `${{ secrets.X }}` en commentaire pour expliquer qu'on n'en pose pas
  // reste légitime. Contrôlé ici même plutôt que par la relecture, sur un échantillon.
  assert.equal(
    MOTIF_SECRET.test(TEXTE),
    false,
    'ce workflow porte un « secrets. » ou un « github.token » en contenu. Ce n’est pas ' +
      'seulement une clé de ' +
      'trop : c’est la PRÉMISSE du ban « set + » qui tombe. Ce ban permet « set -x », qui ' +
      'déverse la trace de chaque commande dans les logs publics du run, et il ne le ' +
      'permet QUE parce qu’aucun secret n’est à portée de cette trace. Poser un secret ' +
      'ici oblige à rouvrir la décision — voir « Ce que test/ci.test.js interdit ' +
      'désormais, et qui contraint les éditions futures » dans plan/contrat.md — et non à ' +
      'lever ce cas',
  );
  // La contre-épreuve, du même coup : le nom cité en COMMENTAIRE ne doit rien faire
  // rougir, sinon le workflow ne peut plus expliquer ce qu'il refuse.
  const echantillon = [
    '# aucun « ${{ secrets.MACHIN }} » n’est posé ici, et c’est ce qui permet set -x',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-24.04',
  ].join('\n');
  assert.equal(
    MOTIF_SECRET.test(retirerCommentaires(echantillon)),
    false,
    'un « secrets. » cité en commentaire doit rester permis : « contenu et commentaires ' +
      'sont deux choses »',
  );
  // Et le sens inverse, sans quoi l'assertion ci-dessus serait verte quels que soient les
  // motifs : la même citation en CONTENU est bien vue.
  assert.equal(
    MOTIF_SECRET.test(retirerCommentaires('jobs:\n  a:\n    env:\n      JETON: x-secrets.y\n')),
    true,
    'le motif doit voir un « secrets. » qui n’est pas en commentaire',
  );
  // `github.token` est la SECONDE moitié de la prémisse, et elle manquait : mesuré, un
  // `env: JETON: ${{ github.token }}` posé sur un step passait, alors que c'est la valeur
  // même que `action.yml` verse dans `GH_TOKEN`. Le runner la masque dans les logs, donc
  // l'exposition pratique est faible — mais la prémisse écrite, elle, ne l'est pas.
  assert.equal(
    MOTIF_SECRET.test(retirerCommentaires('jobs:\n  a:\n    env:\n      JETON: ${{ github.token }}\n')),
    true,
    'le motif doit voir un « github.token » posé en contenu',
  );
  // Conséquence assumée, notée pour qui la rencontrera : l'orthographe canonique
  // `github-token: ${{ secrets.GITHUB_TOKEN }}` est refusée elle aussi, alors que sa
  // valeur est celle du défaut de l'input. Passer par le défaut, ou rouvrir la décision
  // au contrat.
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 — le runner en dur
// ═════════════════════════════════════════════════════════════════════════════

test('chaque job épingle runs-on: ubuntu-24.04 en dur', () => {
  // Mesuré : `actionlint` accepte `ubuntu-latest` sans un mot, dans les quatre
  // jobs. Ces quatre lignes ne tiennent qu'à la relecture — donc à ce cas.
  // `ubuntu-latest` basculera sur 26.04, dont le Python 3.14 est hors de la borne
  // `<3.13` d'aider-chat : les jobs de ce dépôt doivent tourner sur l'image
  // recommandée aux consommateurs.
  for (const job of JOBS) {
    assert.equal(
      job.cles.get('runs-on'),
      'ubuntu-24.04',
      `le job « ${job.id} » ne pose pas runs-on: ubuntu-24.04 en dur`,
    );
  }
});

test('« ubuntu-latest » n’apparaît nulle part en contenu', () => {
  // Complément du cas précédent : celui-ci attraperait un `runs-on` posé ailleurs
  // qu'à l'indentation attendue, ou une matrice. Appliqué à `TEXTE`, jamais à
  // `TEXTE_BRUT` : le workflow mentionne `ubuntu-latest` en commentaire, pour dire
  // qu'il ne l'emploie pas.
  assert.equal(
    /ubuntu-latest/.test(TEXTE),
    false,
    '`ubuntu-latest` est présent en contenu — une mention en commentaire est légitime, pas une valeur',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 — `permissions:` et `defaults.run.shell`
// ═════════════════════════════════════════════════════════════════════════════

test('permissions: contents: read au niveau du workflow, et rien d’autre', () => {
  // Aucun de ces jobs n'écrit quoi que ce soit, et le défaut du dépôt est peut-être
  // plus permissif. Les deux smokes montent une action qui sait pousser et
  // commenter : la restriction est ce qui empêche un jeton large d'être à portée
  // d'un `action.yml` en cours de modification.
  const lignes = lignesDuBlocRacine('permissions');
  assert.ok(
    lignes !== null,
    'aucun bloc « permissions: » à l’indentation zéro — un bloc posé au niveau d’un ' +
      'job ne restreint pas les autres',
  );
  assert.deepEqual(Object.fromEntries(clesDeNiveau(lignes, 2)), { contents: 'read' });
});

test('defaults.run.shell vaut bash, sans quoi le tube du job syntaxe avale l’échec du find', () => {
  // Ce n'est pas décoratif. Le shell par défaut d'un `run:` sous Linux est
  // `bash -e {0}`, SANS `pipefail` : dans `find … | xargs …`, seul le code du
  // dernier maillon compte. Mesuré sur un arbre sain dont un répertoire de la liste
  // a été renommé : `find scripts test absent … | xargs …` rend 0 sans `pipefail`
  // et 1 avec, alors que `find` a écrit « No such file or directory ». Le contrôle
  // du job `syntaxe` cesserait de contrôler en restant vert.
  // `shell: bash` donne `bash --noprofile --norc -eo pipefail {0}`.
  const lignes = lignesDuBlocRacine('defaults');
  assert.ok(lignes !== null, 'aucun bloc « defaults: » à l’indentation zéro');
  const defauts = mappingImbrique(lignes, 2);
  const run = defauts.get('run');
  assert.ok(run, 'defaults: ne déclare pas de sous-bloc « run: »');
  assert.equal(run.get('shell'), 'bash');
});

test('aucun step ni aucun job ne surcharge shell:', () => {
  // Le `defaults:` du workflow ne protège que ce qu'aucune surcharge ne reprend.
  // Mesuré : `shell: sh` ajouté au seul step du `node --check` laissait ce harnais à
  // 21 cas sur 21, et ramenait tel quel le mode de panne décrit en tête du workflow —
  // l'échec du `find` avalé faute de `pipefail`, contrôle vert sur un arbre amputé.
  // La forme retenue est donc : une seule ligne `shell:` dans tout le fichier, celle
  // de `defaults.run`. Une surcharge, même en `bash`, est soit redondante soit une
  // rétrogradation déguisée.
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    assert.equal(
      step.cles.has('shell'),
      false,
      `le step « ${nomDuStep(job, step, index)} » surcharge shell: — le « shell: bash » ` +
        `de defaults.run doit rester le seul du fichier`,
    );
  }
  for (const job of JOBS) {
    assert.equal(
      job.cles.has('defaults'),
      false,
      `le job « ${job.id} » déclare son propre « defaults: », qui peut redéfinir shell:`,
    );
  }
  const lignesShell = LIGNES.filter((ligne) => /^\s*(?:- )?shell:/.test(ligne));
  assert.deepEqual(
    lignesShell,
    ['    shell: bash'],
    'une seule ligne « shell: » est attendue dans tout le fichier, celle de defaults.run',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 et 5 — le `node --check`
// ═════════════════════════════════════════════════════════════════════════════

test('les deux bords du tube du node --check sont épinglés par égalité, et jamais find -exec', () => {
  // LE défaut le plus grave du lot 5 : un contrôle qui ne pouvait pas échouer.
  // Mesuré sur ce dépôt, avec un `scripts/casse.js` contenant `const a = ;` :
  //   `-exec node --check {} \;` rend 0 ;
  //   `-exec node --check {} +` rend 0 aussi dès que le fichier cassé n'est pas le
  //   premier du lot, `node --check` ignorant SILENCIEUSEMENT ses arguments après
  //   le premier (`node --check bon.js casse.js` → code 0).
  // `xargs -0 -n1` fait un appel par fichier et rend non nul.
  //
  // LES DEUX BORDS du tube sont épinglés par ÉGALITÉ d'une liste de jetons, dans ce cas-ci
  // et non dans deux cas séparés : c'est le même trou, et il s'est rouvert TROIS fois,
  // chaque fois par AJOUT d'un jeton plutôt que par substitution — un ajout garde le motif
  // attendu en place, donc un contrôle par présence reste vert.
  //   Bord gauche, mesuré : `-name '*.js'` muté en `-name '*.mjs'`, le tube rend 0 avec
  //   ZÉRO fichier contrôlé et ce harnais restait vert à 21 cas sur 21. Puis la même
  //   mutation par ajout : `find scripts test -path nulle-part -name '*.js' -print0 | …`
  //   contient toujours `-name '*.js'` — 31 cas sur 31, `actionlint` à 0, lot vide.
  //   Bord droit, mesuré : `| xargs -0 -n1 node --check --help`, 31 cas sur 31, et le tube
  //   rend 0 avec un `scripts/casse.js` bien réel sur le disque. Le lot est intact, cette
  //   fois : c'est `node` qui sort en 0 avant d'avoir rien lu. Mesurés un par un sous Node
  //   v24.19.0, `--help`, `--version` et `-v` rendent tous le tube 0 ; `-n1` passé à `-n2`
  //   aussi, cette fois parce que `node --check bon.js casse.js` rend 0.
  //   Et deux jetons qui sont refusés SANS absoudre — `xargs -P 4`, `node --check -p 1`,
  //   mesurés à 1 tous les deux. Ils tombent quand même, parce qu'aucun motif ne distingue
  //   de façon fiable un jeton ajouté qui contrôle d'un jeton ajouté qui absout ; c'est la
  //   même décision, et la même exception nommée, que pour le ban « || ».
  // D'où l'exclusivité des deux côtés. Ce n'est PAS la famille exemptée par « Ce qu'aucun
  // lecteur statique ne peut fermer » : ici le TEXTE change, pas la sémantique du shell.
  // `-print0` et `-0` vont par paire — sans lui, un chemin à espace serait découpé — et les
  // voilà exigés par les deux mêmes égalités.
  const step = stepUnique('syntaxe', 'node --check', 'appeler node --check');
  const corps = corpsDuRun(step);
  const tube = analyserTubeDuCheck(corps);
  assert.ok(
    tube,
    'le corps du run: du node --check ne porte AUCUN tube « | ». Ce lecteur n’a alors plus ' +
      'rien à épingler, et les deux formes qui restent sont justement celles que ce cas ' +
      'refuse : un `find -exec`, qui ne peut pas échouer, ou une liste de fichiers écrite à ' +
      'la main, qui cesse de couvrir le dépôt dès le fichier suivant',
  );
  assert.deepEqual(
    tube.predicat,
    ['-name', "'*.js'", '-print0'],
    `les jetons du find après la liste des répertoires valent ${JSON.stringify(tube.predicat)} : ` +
      `« -name '*.js' -print0 », exactement, est attendu. Tout jeton EN PLUS restreint le ` +
      `lot, et un lot vide rend 0 sans rien contrôler ; un jeton en moins découple -print0 ` +
      `du -0 de xargs ou ouvre le lot à d’autres fichiers. Étendre ce contrôle demande de ` +
      `justifier le nouveau prédicat, pas de le laisser passer`,
  );
  assert.deepEqual(
    tube.aval,
    ['xargs', '-0', '-n1', 'node', '--check'],
    `les jetons après le « | » valent ${JSON.stringify(tube.aval)} : ` +
      `« xargs -0 -n1 node --check », exactement, est attendu. Ce bord-là se vide aussi par ` +
      `AJOUT, et sans toucher au find : mesuré sous Node v24.19.0, avec un scripts/casse.js ` +
      `bien réel, « node --check --help » rend le tube 0, comme « --version » et « -v » ; ` +
      `« -n2 » à la place de « -n1 » absout SELON LE RANG du fichier cassé dans le lot — ` +
      `mesuré : cassé en premier, le tube rend 1 ; cassé en second, il rend 0, « node ` +
      `--check » ne lisant que son premier argument. EXCEPTION, nommée pour que ce message ` +
      `n’accuse pas la mauvaise cause : « xargs ` +
      `-P 4 » et « node --check -p 1 » sont mesurés à 1, ils n’absolvent rien, et l’égalité ` +
      `les refuse quand même — aucun motif ne distingue de façon fiable un jeton ajouté qui ` +
      `contrôle d’un jeton ajouté qui absout. Épingler un seul bord du tube ne ferme rien : ` +
      `les deux le sont, par égalité`,
  );
  assert.equal(
    /-exec/.test(corps),
    false,
    '`find -exec` ne peut pas faire échouer ce contrôle — voir la mesure ci-dessus',
  );
});

test('le node --check couvre scripts et test', () => {
  // Une liste écrite à la main dans le YAML est précisément ce qui a laissé trois
  // suites hors CI. `test` retiré d'ici, une suite qui ne se charge plus ne serait
  // signalée que par son propre échec — et une suite renommée par personne.
  const corps = corpsDuRun(stepUnique('syntaxe', 'node --check', 'appeler node --check'));
  const find = analyserTubeDuCheck(corps);
  assert.ok(find, 'aucun tube « find … | xargs … » dans le step de node --check');
  // Par inclusion ici, et non par égalité comme pour le prédicat : ajouter un répertoire
  // à parcourir AGRANDIT le lot contrôlé — `scripts/lib` un jour, ou un `bin/` — alors
  // qu'ajouter un prédicat le restreint. Les deux sens sont opposés, les deux contrôles
  // aussi.
  for (const attendu of ['scripts', 'test']) {
    assert.ok(
      find.repertoires.includes(attendu),
      `« ${attendu} » n’est pas parcouru par le find du node --check (parcourus : ` +
        `${JSON.stringify(find.repertoires)})`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 et 7 — `actionlint` : version, condensat, ordre
// ═════════════════════════════════════════════════════════════════════════════

// Recopiées de `plan/contrat.md` et de rien d'autre. Les comparer AUSSI à des
// littéraux est ce qui rend le contrôle d'accord utile : deux fichiers mutés de la
// même façon resteraient d'accord entre eux, et faux tous les deux.
const VERSION_ACTIONLINT = '1.7.12';
const SHA256_ACTIONLINT = '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
const VERSION_CHECKOUT = 'v5';

test('la version et le condensat d’actionlint sont ceux de plan/contrat.md', () => {
  // Une version épinglée dans un seul des deux endroits dérive sans que rien ne
  // rougisse. Et un condensat qui ne correspond plus à l'archive fait rougir le
  // job en accusant la mauvaise cause, d'où l'accord contrôlé ici.
  // Pas d'action tierce : mesuré, `rhysd/actionlint` ne publie AUCUN `action.yml`
  // — raw.githubusercontent.com/rhysd/actionlint/v1.7.12/action.yml rend 404.
  assert.equal(ACTIONLINT_CONTRAT.version, VERSION_ACTIONLINT, 'plan/contrat.md contre ce harnais');
  assert.equal(ACTIONLINT_CONTRAT.condensat, SHA256_ACTIONLINT, 'plan/contrat.md contre ce harnais');

  const step = stepUnique('syntaxe', 'sha256sum', 'installer actionlint');
  assert.ok(step.env, 'le step d’installation d’actionlint ne déclare pas de bloc env:');
  assert.equal(
    step.env.get('VERSION_ACTIONLINT'),
    ACTIONLINT_CONTRAT.version,
    'VERSION_ACTIONLINT du workflow contre plan/contrat.md',
  );
  assert.equal(
    step.env.get('SHA256_ACTIONLINT'),
    ACTIONLINT_CONTRAT.condensat,
    'SHA256_ACTIONLINT du workflow contre plan/contrat.md',
  );
  // L'URL lit la variable, elle ne redit pas le numéro : sinon les deux divergent.
  const corps = corpsDuRun(step);
  assert.match(corps, /\$\{VERSION_ACTIONLINT\}/, 'l’URL doit interpoler ${VERSION_ACTIONLINT}');
  assert.equal(
    corps.includes(ACTIONLINT_CONTRAT.version),
    false,
    'le numéro de version est écrit en dur dans le corps du run: — il doit venir de env:',
  );
  // `-f` : sans lui, curl enregistre une page d'erreur HTML, le condensat échoue,
  // et le message accuse la mauvaise cause.
  assert.match(corps, /curl\s+-[A-Za-z]*f/, 'curl doit porter -f pour rougir sur une erreur HTTP');
});

test('le condensat est contrôlé avant l’extraction de l’archive', () => {
  // Une archive extraite PUIS vérifiée a déjà écrit ses fichiers sur le disque.
  // Attention en relisant ce cas : `actionlint.tar.gz` contient la sous-chaîne
  // `tar`. La commande d'extraction est donc cherchée ANCRÉE en début de ligne, et
  // non n'importe où dans le corps — un contrôleur écrit sans cette précaution
  // trouve « tar » dès la première ligne et se croit en faute.
  // La commande de contrôle est lue UNE fois, et sa position sert à l'ordre : le
  // `corps.indexOf('sha256sum -c')` qui tenait ce rôle ne regardait que la présence de la
  // sous-chaîne, et l'ARGUMENT de `-c` est justement ce qui décide si la commande contrôle
  // quoi que ce soit. Mesuré avec le vrai GNU sha256sum :
  //   `echo "<condensat>  f.txt" | sha256sum -c /dev/null` rend 0 sans une ligne de sortie
  //   — le condensat attendu part sur stdin, que la commande ne lit plus ;
  //   `… | sha256sum -c -` rend 1 sur un condensat faux.
  // Le step gardait toute son apparence, et c'était la mutation la plus silencieuse qui
  // restait dans ce fichier. Le texte change, donc elle est fermable.
  const corps = corpsDuRun(stepUnique('syntaxe', 'sha256sum', 'installer actionlint'));
  const condensat = corps.match(/^[^\n]*\|[ \t]*sha256sum[ \t]+-c[ \t]+-[ \t]*$/m);
  assert.ok(
    condensat,
    'le step d’installation ne porte pas de ligne « … | sha256sum -c - ». Le « - » désigne ' +
      'stdin, où le condensat attendu est écrit : tout autre argument fait lire un FICHIER, ' +
      'et mesuré, « sha256sum -c /dev/null » rend 0 en silence',
  );
  const positionCondensat = condensat.index;
  const positionExtraction = corps.search(/^\s*tar\s/m);
  assert.notEqual(positionExtraction, -1, 'aucune commande « tar » en début de ligne');
  assert.ok(
    positionCondensat < positionExtraction,
    `le « sha256sum -c » (offset ${positionCondensat}) doit précéder le « tar » ` +
      `(offset ${positionExtraction})`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 bis — un step LANCE le binaire installé
// ═════════════════════════════════════════════════════════════════════════════

test('un step de syntaxe lance le binaire actionlint extrait, sans aucun argument', () => {
  // Le contrat fait dire à `syntaxe` que « .github/workflows/** passe actionlint ».
  // Rien ne l'exigeait : mesuré, le step qui LANCE actionlint supprimé et
  // l'installation gardée, ce harnais restait à 21 cas sur 21 — l'archive était
  // téléchargée, son condensat vérifié, l'archive extraite, et aucun workflow n'était
  // analysé. Le cas 8 ne dit que « si un step le mentionne, il ne lui passe pas
  // action.yml », et le cas 6 ne contrôle que l'installation.
  //
  // Le chemin du binaire n'est pas écrit ici : il est LU sur la commande d'extraction,
  // pour que déplacer l'un sans l'autre rougisse au lieu de laisser un step lancer un
  // binaire absent — mode de panne bruyant, mais dont le message accuse la mauvaise
  // cause.
  const installation = corpsDuRun(stepUnique('syntaxe', 'sha256sum', 'installer actionlint'));
  // Le nom du membre extrait — `… -C "$RUNNER_TEMP" actionlint` — est OPTIONNEL dans ce
  // motif : `tar -xzf "$archive" -C "$RUNNER_TEMP"` extrait toute l'archive, ce qui est
  // une édition légitime. Le motif précédent l'exigeait et faisait alors rougir en
  // accusant l'absence du `-C`, qui était pourtant là. Seule chose exigée ici, et seule
  // chose dont ce cas a besoin : le répertoire de destination, nommé par une variable,
  // pour le comparer au step qui lance le binaire.
  const extraction = installation.match(
    /^\s*tar\s+[^\n]*-C\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?(?:[^\n]*\bactionlint)?\s*$/m,
  );
  assert.ok(
    extraction,
    'la commande « tar » du step d’installation ne pose pas de « -C "$VARIABLE" » lisible : ' +
      'ce harnais y lit le répertoire où le binaire actionlint est extrait, pour le ' +
      'confronter au step qui le lance. Un chemin en dur, ou un -C absent, découplerait ' +
      'les deux',
  );
  const repertoire = extraction[1];
  const invocation = new RegExp(`^ *"?\\$\\{?${repertoire}\\}?/actionlint"? *([^\\n]*)$`, 'm');

  const job = PAR_ID.get('syntaxe');
  assert.ok(job, 'le job « syntaxe » n’existe pas');
  const lancements = job.steps
    .map((step) => corpsDuRun(step).match(invocation))
    .filter(Boolean);
  assert.equal(
    lancements.length,
    1,
    `un seul step de « syntaxe » doit lancer « $${repertoire}/actionlint » en tête de ` +
      `commande, ${lancements.length} trouvé(s) — installer le binaire ne l’exécute pas`,
  );
  // ZÉRO argument, pas « des arguments acceptables ». Un argument suffit à vider ce
  // contrôle en gardant l'apparence, et pas seulement les options : mesuré,
  // `"$RUNNER_TEMP/actionlint" .github/workflows/test.yml` est vert et le job cesse
  // d'analyser tout workflow FUTUR, alors que le contrat lui fait prouver que
  // « .github/workflows/** passe actionlint ». `--version` et `--help` rendent 0 sans
  // rien analyser du tout. Sans argument, actionlint trouve seul `.github/workflows`
  // depuis la racine du dépôt : c'est la forme livrée, et celle que le commentaire du
  // workflow justifie.
  const arguments_ = lancements[0][1].trim();
  assert.equal(
    arguments_,
    '',
    `actionlint est lancé avec « ${arguments_} » : il doit l’être sans AUCUN argument. Un ` +
      `chemin explicite restreint l’analyse aux fichiers nommés aujourd’hui et laisse tout ` +
      `workflow ajouté ensuite hors contrôle ; « --version » ou « --help » rendent 0 sans ` +
      `analyser quoi que ce soit. Voir « un argument passé à actionlint » dans plan/contrat.md.`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 ter — aucun fichier de configuration d'`actionlint` sur le disque
// ═════════════════════════════════════════════════════════════════════════════

test('ni .github/actionlint.yaml ni .github/actionlint.yml n’existe dans le dépôt', () => {
  // SEUL cas de ce fichier qui regarde ailleurs que `CI_YML` — et donc le seul que la
  // trappe `CI_YML` ne pilote pas : il lit le dépôt où ce harnais vit, parce que c'est
  // là qu'actionlint cherche sa configuration.
  //
  // Mesuré avec le binaire 1.7.12, sur un workflow portant une vraie erreur
  // (« unexpected key "inexistant" for "job" section ») : sans fichier de
  // configuration, code 1 et l'erreur est signalée ; avec un `.github/actionlint.yaml`
  // de six lignes portant `paths: {".github/workflows/**": {ignore: [".*"]}}`, code 0
  // et plus rien. Tout le job `syntaxe` est neutralisé depuis un fichier qu'aucun autre
  // contrôle ne lit — le condensat vérifié, le binaire lancé, et zéro diagnostic.
  for (const nom of ['actionlint.yaml', 'actionlint.yml']) {
    const chemin = path.join(RACINE, '.github', nom);
    assert.equal(
      fs.existsSync(chemin),
      false,
      `${chemin} existe : un fichier de configuration d’actionlint peut faire taire ` +
        `l’intégralité du job « syntaxe » sans qu’aucun autre contrôle ne le voie. ` +
        `Mesuré : six lignes de « paths: … ignore: [".*"] » font rendre 0 sur un ` +
        `workflow qui contient une vraie erreur. Voir plan/contrat.md avant d’en ajouter un.`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 — `actionlint` ne voit jamais `action.yml`
// ═════════════════════════════════════════════════════════════════════════════

test('actionlint n’est jamais lancé sur action.yml', () => {
  // Mesuré : actionlint lit `action.yml` comme un WORKFLOW et rend huit erreurs
  // absurdes — « "jobs" section is missing in workflow », « unexpected key
  // "inputs" for "workflow" section », … Sans argument, il trouve seul
  // `.github/workflows` depuis la racine du dépôt. La cohérence statique
  // d'`action.yml` est contrôlée par `test/action.test.js`, que le job `suites`
  // lance.
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    const corps = corpsDuRun(step);
    if (!corps.includes('actionlint')) continue;
    assert.equal(
      corps.includes('action.yml'),
      false,
      `le step « ${nomDuStep(job, step, index)} » passe action.yml à actionlint`,
    );
  }
  // Et le fichier entier, pour la forme sur une seule ligne que le découpage en
  // steps ci-dessus ne saurait pas juger si elle vivait ailleurs qu'en `run:`.
  assert.equal(/actionlint[^\n]*action\.yml/.test(TEXTE), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9 et 10 — aucune expression `${{ … }}` dans un `uses:` ni dans un `run:`
// ═════════════════════════════════════════════════════════════════════════════

test('aucune expression ${{ … }} dans un uses:', () => {
  // Mesuré : `actionlint` rend « context "github" is not allowed here. no context
  // is available here ». La référence distante `owner/repo@${{ github.sha }}` que
  // proposait le lot 5 pour obtenir l'écart entre `GITHUB_ACTION_PATH` et
  // `GITHUB_WORKSPACE` aurait donc fait rougir notre propre job `syntaxe`. La forme
  // locale `uses: ./copie-action` donne le même écart, et marche en plus sur une PR
  // de fork, sans commit poussé.
  const uses = TOUS_LES_STEPS.filter(({ step }) => step.cles.has('uses'));
  assert.ok(uses.length > 0, 'aucun step uses: trouvé — le fichier a changé de forme');
  for (const [index, { job, step }] of uses.entries()) {
    assert.equal(
      /\$\{\{/.test(step.cles.get('uses')),
      false,
      `le step « ${nomDuStep(job, step, index)} » interpole une expression dans son uses:`,
    );
  }
});

test('aucune expression ${{ … }} dans le corps d’un run:', () => {
  // Motif R6/R7 du dépôt : les valeurs passent par l'`env:` du step, jamais par
  // interpolation dans le script. Mesuré : sur une sortie de step, actionlint ne
  // dit RIEN — il ne relève que les contextes qu'il sait non fiables
  // (`${{ github.event.issue.title }}` dans un `run:` → « is potentially
  // untrusted »). La discipline ne tient donc qu'à elle-même, ce qui est une raison
  // de plus de ne pas y faire l'exception « celle-là est sûre » : c'est par cette
  // exception que le motif revient.
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    assert.equal(
      /\$\{\{/.test(corpsDuRun(step)),
      false,
      `le step « ${nomDuStep(job, step, index)} » interpole une expression dans le ` +
        `corps de son run: — la valeur doit passer par env:`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 11 — le job `suites` ferme les deux sens
// ═════════════════════════════════════════════════════════════════════════════

test('le job suites lance les suites par le glob test/*.test.js, sans nullglob', () => {
  // Le sens « suite AJOUTÉE » : elle est lancée sans que personne y pense. C'est une
  // liste écrite à la main qui avait laissé `texte`, `action` et `compte-rendu` hors
  // CI.
  // Pas de `nullglob` : mesuré, sans correspondance bash passe le motif littéral à
  // `node`, qui rend `MODULE_NOT_FOUND` et un code non nul. « Plus aucune suite »
  // est donc un cas bruyant ; avec `nullglob`, la boucle ne tournerait pas et le
  // job serait vert.
  const step = stepUnique('suites', 'test/*.test.js', 'lancer les suites par le glob');
  const corps = corpsDuRun(step);
  // L'en-tête de la boucle et le `node` sont lus ENSEMBLE, sur la même variable, et le
  // `node` est cherché dans le CORPS de la boucle. Deux assertions indépendantes —
  // « une boucle existe » d'une part, « un node "$…" existe » d'autre part — étaient
  // satisfaites par une boucle qui ne faisait qu'`echo` plus un `node "$premiere"` sur
  // une seule suite : 21 cas sur 21 verts, et le job passait de 195 cas à 11.
  const boucle = boucleFor(corps, 'test/*.test.js');
  assert.match(
    boucle.corps,
    new RegExp(`^ *node +"\\$${boucle.variable}" *$`, 'm'),
    `le corps de la boucle doit lancer « node "$${boucle.variable}" » — la variable de ` +
      `la boucle elle-même, et la commande seule sur sa ligne : un « || true », une ` +
      `redirection ou un tube en fin de ligne avaleraient le code de retour de la suite`,
  );
  // La variable de boucle ne doit pas être RÉAFFECTÉE dans le corps. Mesuré, une seule
  // ligne `suite=test/chemins.test.js` insérée entre l'`echo` et le `node` : ce harnais
  // restait à 31 cas sur 31 et `actionlint` à 0, la boucle tournait bien sept fois, et
  // lançait sept fois `test/chemins.test.js`. Six suites cessaient d'être exercées sans
  // qu'aucun motif de ce fichier ne bouge — l'en-tête, le corps et le `node "$suite"`
  // étaient tous à leur place. C'est la même famille que le reste : garder l'apparence,
  // retirer le travail.
  assert.equal(
    new RegExp(`^ *${boucle.variable}=`, 'm').test(boucle.corps),
    false,
    `le corps de la boucle réaffecte « ${boucle.variable} », la variable de la boucle ` +
      `elle-même : les tours suivants lanceraient tous la même suite, et le nombre de ` +
      `tours ne changerait pas`,
  );
  assert.equal(
    /nullglob/.test(TEXTE),
    false,
    '`nullglob` rendrait le cas « plus aucune suite » silencieux et vert',
  );
});

test('le job suites contrôle l’existence des sept suites recensées par le contrat', () => {
  // Le sens inverse : un glob ne peut pas voir une suite SUPPRIMÉE ou RENOMMÉE, il
  // lance ce qu'il trouve et se tait. La liste est donc comparée à celle de
  // « Suites de test du dépôt » de plan/contrat.md — seul endroit qui les recense —,
  // y compris `test/ci.test.js`, que ce harnais est : c'est la seule façon de faire
  // signaler sa propre disparition.
  assert.equal(
    SUITES_CONTRAT.length,
    7,
    'plan/contrat.md doit recenser sept suites, celle-ci comprise',
  );
  const corps = corpsDuRun(stepUnique('suites', '-f "$suite"', 'contrôler l’existence des suites'));
  const nommees = [...corps.matchAll(/test\/[A-Za-z0-9_.-]+\.test\.js/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(nommees)].sort(),
    [...SUITES_CONTRAT].sort(),
    'la liste du job suites et celle de plan/contrat.md ont divergé',
  );
});

test('le step d’existence des suites porte un ::error:: et une sortie qui peut être non nulle', () => {
  // Le nom de ce cas dit ce qu'il LIT, et pas « rend un code non nul quand une suite
  // manque » : cela, aucun lecteur statique ne peut le prouver. Mesuré,
  // `if [ ! -f "$suite" ] && false; then` laisse en place le motif `-f "$suite"`, le
  // `::error::`, le `manquantes=1` et l'`exit "$manquantes"` — tout ce que ce cas
  // regarde — et le step rend 0 quelles que soient les suites absentes. C'est la
  // sémantique du shell qui change, pas le texte. Limite inscrite dans plan/contrat.md,
  // « Ce qu'aucun lecteur statique ne peut fermer » ; la fermer demanderait d'exécuter
  // le corps du step contre un arbre truqué.
  //
  // Ce que ce cas ferme, lui : mesuré, la seule ligne `exit "$manquantes"` retirée, ce
  // harnais restait à 21 cas sur 21 et le step devenait un contrôle sans pouvoir
  // d'échouer. Un `::error::` sur stdout n'échoue PAS un step — il annote le run et le
  // job reste vert. Le sens « suite supprimée ou renommée », que le contrat déclare
  // fermé, s'ouvrait en silence : c'est exactement ce que le glob du step suivant ne
  // peut pas voir.
  const corps = corpsDuRun(stepUnique('suites', '-f "$suite"', 'contrôler l’existence des suites'));
  assert.match(corps, /::error::/, 'l’absence d’une suite doit être annotée par « ::error:: »');
  const sorties = [...corps.matchAll(/^ *exit +(\S+) *$/gm)].map((m) => m[1]);
  assert.ok(
    sorties.length >= 1,
    'aucune commande « exit » dans le step : un « ::error:: » seul laisse le step vert',
  );
  // Une sortie sur variable n'échoue que si cette variable peut valoir autre chose que
  // zéro : le drapeau doit être posé à une valeur non nulle quelque part dans le step.
  let peutEchouer = false;
  for (const valeur of sorties) {
    const m = valeur.match(/^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/);
    if (!m) {
      if (/^[1-9][0-9]*$/.test(valeur)) peutEchouer = true;
      continue;
    }
    if (new RegExp(`^ *${m[1]}=[1-9]`, 'm').test(corps)) peutEchouer = true;
  }
  assert.ok(
    peutEchouer,
    `aucune des sorties ${JSON.stringify(sorties)} ne peut être non nulle : il faut soit ` +
      `un « exit <non nul> », soit un « exit "$drapeau" » dont le drapeau est affecté à ` +
      `une valeur non nulle dans le step`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 12 — les trappes de test restent fermées
// ═════════════════════════════════════════════════════════════════════════════

test('la CI ne pose ni GH_CLI, ni AIDER_CLI, ni AIDER_STUB_*', () => {
  // Mesuré : les poser ne change RIEN —
  // `AIDER_CLI=/bin/true GH_CLI=/bin/true node test/boucle.test.js` rend 58/58,
  // parce que chaque suite construit l'environnement des sous-processus qu'elle
  // lance au lieu d'hériter du sien. Une variable d'environnement sans effet est
  // pire qu'absente : elle fait croire que la CI pilote les stubs, alors que c'est
  // le harnais qui les pilote — dont le cas
  // « R7 — sans AIDER_CLI, la trappe AIDER_STUB_* est FERMÉE », qui vérifie
  // l'inverse et rougirait si la CI posait `AIDER_CLI`.
  for (const nom of ['GH_CLI', 'AIDER_CLI', 'AIDER_STUB']) {
    assert.equal(
      new RegExp(`\\b${nom}`).test(TEXTE),
      false,
      `« ${nom} » est une trappe de test : la CI ne doit pas la poser en contenu`,
    );
  }
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    for (const cle of step.env ? step.env.keys() : []) {
      assert.equal(
        /^(GH_CLI|AIDER_CLI|AIDER_STUB)/.test(cle),
        false,
        `le step « ${nomDuStep(job, step, index)} » câble la trappe de test « ${cle} »`,
      );
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 13 et 14 — les `uses:` du fichier
// ═════════════════════════════════════════════════════════════════════════════

test('aucun actions/setup-node, et un run: du job syntaxe lance node --version', () => {
  // Node n'est pas épinglé et il ne doit pas l'être. `setup-node` ferait passer les
  // suites sur un Node que l'action ne rencontre jamais, chez le consommateur comme
  // ici, et masquerait le jour où l'image change de version majeure. Le job
  // `syntaxe` journalise `node --version` pour que la valeur du run soit au dossier.
  assert.equal(/setup-node/.test(TEXTE), false, '`actions/setup-node` est présent en contenu');
  // Cherché dans le `run:` d'un step du job `syntaxe`, et à cet endroit seulement.
  // Mesuré : `assert.match(TEXTE, /node --version/)` est satisfaite par n'importe
  // quelle occurrence en contenu — `run: node --version` remplacé par `run: true`
  // plus un step `name: node --version` laissait ce harnais à 21 cas sur 21, et plus
  // rien n'était journalisé.
  const step = stepUnique('syntaxe', 'node --version', 'journaliser la version de Node');
  assert.match(
    corpsDuRun(step),
    /^\s*node\s+--version\s*$/m,
    '« node --version » doit être une commande à lui seul, pas un fragment de ligne',
  );
});

test('les uses: appartiennent à l’ensemble connu, et checkout est à la version du contrat', () => {
  // `checkout@v4` déclare `using: node20`, retiré des runners le 2026-09-16 :
  // mesuré, `v5` déclare `using: node24`. Une action tierce ajoutée ici s'exécute
  // dans le même job que les smokes, qui montent une action capable de pousser et
  // de commenter — l'ensemble est donc fermé, pas seulement épinglé.
  assert.equal(CHECKOUT_CONTRAT, VERSION_CHECKOUT, 'plan/contrat.md contre ce harnais');
  const connus = new Set([`actions/checkout@${CHECKOUT_CONTRAT}`, './', './copie-action']);
  const uses = TOUS_LES_STEPS.map(({ step }) => step.cles.get('uses')).filter(Boolean);
  assert.ok(uses.length > 0, 'aucun uses: trouvé');
  for (const reference of uses) {
    assert.ok(
      connus.has(reference),
      `« uses: ${reference} » n’est pas dans l’ensemble connu ${JSON.stringify([...connus])}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 15 et 16 — les deux montages de l'action
// ═════════════════════════════════════════════════════════════════════════════

test('smoke-local monte ./ et smoke-sous-repertoire monte ./copie-action, chacun avec un id:', () => {
  // Ces deux jobs sont les seuls contrôles du dépôt qui refusent un `action.yml`
  // malformé : le runner le CHARGE. `actionlint` ne lit pas `action.yml`, et le
  // lecteur de blocs de `test/action.test.js` ne valide pas le YAML — mesuré, un
  // guillemet non fermé dans une `description:` le laisse vert.
  // L'`id:` n'est pas décoratif : sans lui, les `outputs` du step sont
  // INATTEIGNABLES, `${{ steps.action.outputs.poursuivre }}` s'évalue en chaîne
  // vide, et l'assertion du step suivant ne prouve plus rien.
  for (const [idJob, reference] of [
    ['smoke-local', './'],
    ['smoke-sous-repertoire', './copie-action'],
  ]) {
    const job = PAR_ID.get(idJob);
    assert.ok(job, `le job « ${idJob} » n’existe pas`);
    const montages = job.steps.filter((step) => step.cles.get('uses') === reference);
    assert.equal(
      montages.length,
      1,
      `le job « ${idJob} » doit monter l’action une fois par « uses: ${reference} »`,
    );
    assert.ok(
      montages[0].cles.get('id'),
      `le step « uses: ${reference} » de « ${idJob} » n’a pas d’id: — ses outputs ` +
        `seraient inatteignables et les assertions du job ne prouveraient rien`,
    );
  }
});

test('smoke-sous-repertoire n’a qu’un seul checkout, avec path: copie-action', () => {
  // Le cœur de ce job. `ActionManager.cs:699-705` du runner : pour une référence
  // locale, `actionDirectory` part de `GITHUB_WORKSPACE` puis y JOINT le chemin de
  // la référence. `uses: ./` donne `GITHUB_ACTION_PATH == GITHUB_WORKSPACE` et
  // laisse donc passer un chemin relatif ; `uses: ./copie-action` donne
  // `GITHUB_WORKSPACE/copie-action`, où un `node scripts/garde.js` relatif ne
  // résout plus. Un SECOND checkout à la racine du workspace ferait tomber juste
  // ce chemin relatif par accident, et le job ne prouverait plus rien.
  // Mesuré : actionlint reste vert quand le répertoire visé n'existe pas — il lit
  // l'`action.yml` local quand il le trouve et se tait sinon. Seul le runner refuse,
  // et seulement à l'exécution : d'où l'accord contrôlé ici.
  const job = PAR_ID.get('smoke-sous-repertoire');
  assert.ok(job, 'le job « smoke-sous-repertoire » n’existe pas');
  const checkouts = job.steps.filter((step) => /^actions\/checkout@/.test(step.cles.get('uses') || ''));
  assert.equal(
    checkouts.length,
    1,
    `un seul checkout attendu dans « smoke-sous-repertoire », ${checkouts.length} trouvé(s) : ` +
      `un checkout à la racine du workspace rendrait ce job incapable de faire rougir ` +
      `un chemin relatif`,
  );
  const chemin = checkouts[0].avec && checkouts[0].avec.get('path');
  assert.ok(chemin, 'le checkout de « smoke-sous-repertoire » ne pose pas de with: path:');
  const montage = job.steps.find((step) => /^\.\//.test(step.cles.get('uses') || ''));
  assert.ok(montage, 'aucun montage local de l’action dans « smoke-sous-repertoire »');
  assert.equal(
    montage.cles.get('uses'),
    `./${chemin}`,
    'le « uses: ./<répertoire> » et le « path: » du checkout doivent désigner le même répertoire',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 17 — accord entre les `env:` des smokes et les `outputs:` d'`action.yml`
// ═════════════════════════════════════════════════════════════════════════════

test('toute sortie steps.<id>.outputs.<nom> citée par un smoke existe dans action.yml', () => {
  // Une sortie mal nommée ne lève pas : elle s'évalue en CHAÎNE VIDE. Le job reste
  // vert et le smoke ne contrôle plus rien — il compare deux chaînes vides. Même
  // motif que l'accord des versions ci-dessus, entre deux fichiers cette fois.
  // Rappel : la sortie d'un step SAUTÉ vaut aussi la chaîne vide, ce que les
  // smokes exploitent volontairement pour `succes` et `numero-pr` ; c'est
  // justement pourquoi une faute de frappe y est indiscernable à l'exécution.
  assert.ok(OUTPUTS_ACTION.size > 0, 'action.yml ne déclare aucun output');
  let citations = 0;
  for (const [index, { job, step }] of TOUS_LES_STEPS.entries()) {
    const identifiants = new Set(
      job.steps.map((autre) => autre.cles.get('id')).filter((id) => typeof id === 'string'),
    );
    for (const [cle, valeur] of step.env ? step.env : new Map()) {
      const m = valeur.match(/^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/);
      if (!m) continue;
      citations += 1;
      const [, id, sortie] = m;
      assert.ok(
        identifiants.has(id),
        `« ${cle} » du step « ${nomDuStep(job, step, index)} » lit steps.${id}.outputs.` +
          `${sortie}, mais aucun step de « ${job.id} » ne porte l’id: « ${id} »`,
      );
      assert.ok(
        OUTPUTS_ACTION.has(sortie),
        `« ${cle} » du step « ${nomDuStep(job, step, index)} » lit la sortie ` +
          `« ${sortie} », qui n’est pas déclarée dans le bloc outputs: d’action.yml ` +
          `(déclarées : ${JSON.stringify([...OUTPUTS_ACTION])})`,
      );
    }
  }
  assert.ok(
    citations >= 1,
    'aucun env: de smoke ne lit une sortie de l’action — les deux jobs de smoke ne ' +
      'contrôleraient alors que le fait que le montage n’explose pas',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 18 — chaque job de smoke porte sa propre assertion
// ═════════════════════════════════════════════════════════════════════════════

test('chaque job de smoke lit une sortie de l’action dans son env:, la relit dans son run: et porte un exit non nul', () => {
  // Le cas 17 compte les citations sur TOUS les jobs à la fois : `smoke-sous-repertoire`
  // le satisfaisait donc à lui seul. Mesuré : le step d'assertion entièrement retiré de
  // `smoke-local`, ce harnais restait à 21 cas sur 21 — le job montait l'action et ne
  // regardait plus rien de ce qu'elle remontait, exactement le contrôle vide que ce
  // fichier existe pour refuser.
  // Trois choses par job de smoke : une sortie citée dans un `env:`, cette variable
  // RELUE dans le corps du `run:`, et un `exit` non nul dans ce corps. Sans le
  // troisième, comparer deux valeurs ne fait rien échouer.
  // Ce cas ne prétend PAS que l'assertion s'exécutera : mesuré, un `&& false` ajouté à
  // son `if` laisse les trois motifs en place et rend le step vert. Même limite que pour
  // le step d'existence des suites, inscrite dans plan/contrat.md.
  assert.equal(JOBS_SMOKE.length, 2, 'plan/contrat.md doit recenser deux jobs de smoke');
  for (const idJob of JOBS_SMOKE) {
    const job = PAR_ID.get(idJob);
    assert.ok(job, `le job « ${idJob} » n’existe pas`);
    const assertions = job.steps.filter((step) => {
      const corps = corpsDuRun(step);
      if (!/^ *exit +[1-9][0-9]* *$/m.test(corps)) return false;
      for (const [cle, valeur] of step.env ? step.env : new Map()) {
        if (!/^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/.test(valeur)) {
          continue;
        }
        // `echapper` et non la clé brute : une clé d'`env:` peut porter un `.` ou un
        // `-`, qui deviendraient un joker et une plage dans l'expression rationnelle.
        // Sans effet sur les clés d'aujourd'hui — c'est justement pourquoi il faut
        // l'écrire maintenant.
        if (new RegExp(`\\$\\{?${echapper(cle)}\\b`).test(corps)) return true;
      }
      return false;
    });
    assert.ok(
      assertions.length >= 1,
      `le job « ${idJob} » ne porte aucun step qui lise une sortie de l’action dans son ` +
        `env:, la relise dans son run: et sorte en code non nul — monter l’action sans ` +
        `rien affirmer sur ce qu’elle remonte laisse le job vert quoi qu’il arrive`,
    );
  }
});
