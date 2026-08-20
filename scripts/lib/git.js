'use strict';

// Wrapper autour de `git`, plus les trois questions que l'action pose au dépôt.
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const { spawnSync } = require('node:child_process');
const { masquerSecrets, tronquer } = require('./texte.js');

const BINAIRE = 'git';

// 64 Mio : `git status -z` sur un gros dépôt sale dépasse le défaut de 1 Mio.
const TAILLE_MAX_SORTIE = 64 * 1024 * 1024;

// Séparateur de `git status --porcelain -z`. Écrit par code de caractère plutôt
// qu'en échappement, pour que ce fichier reste du texte sans octet nul.
const NUL = String.fromCharCode(0);

// Statut porté par le chemin d'ORIGINE d'un renommage ou d'une copie. Ce n'est pas
// un statut git : c'est le marqueur imposé par `contrat.md` pour distinguer les
// deux côtés d'un renommage, que git rend sur deux entrées consécutives.
const STATUT_ORIGINE = 'R<';

/**
 * Lance `git` avec un tableau d'arguments et renvoie le résultat brut.
 * Usage interne : `git()` en dérive la version trimmée, `etatFichiers()` a besoin
 * de la sortie non trimmée (un chemin peut commencer ou finir par une espace).
 * @param {string[]} args
 * @param {{ tolererEchec?: boolean }} [options]
 * @returns {{ code: number, stdout: string, stderr: string }|null}
 */
function lancer(args, { tolererEchec = false } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('git() attend un tableau de chaînes en premier argument');
  }

  // Jamais `shell: true` : une partie des arguments (message de commit, nom de
  // branche, chemins) dérive de texte rédigé par un tiers. `encoding: 'utf8'`,
  // sinon stdout est un Buffer.
  //
  // `GIT_LITERAL_PATHSPECS=1` n'est pas une précaution théorique, c'est mesuré : les
  // chemins passés à `add`, `checkout`, `ls-files` et `diff` sont choisis par le
  // modèle, et git les interprète par défaut comme des PATHSPECS, pas comme des noms
  // de fichiers. Un fichier réellement nommé « * » suffisait : `git add -- '*'`
  // stageait tout l'arbre sale, dont un `.env` que `commiterTravail` venait
  // explicitement de refuser, et `git ls-files -- 'Dockerfile*'` déclarait « suivi »
  // un fichier qui n'existait pas. La variable rend la littéralité globale : aucun
  // appel de ce dépôt n'a besoin de la magie de pathspec.
  const resultat = spawnSync(BINAIRE, args, {
    encoding: 'utf8',
    maxBuffer: TAILLE_MAX_SORTIE,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });

  // `git -c http.extraheader=...` porte le jeton de push dans son argv, et une
  // erreur de remote recopie l'URL d'origine : tout ce qui part en message
  // d'erreur passe donc par le masquage.
  const commande = masquerSecrets([BINAIRE, ...args].join(' '));
  const stderr = masquerSecrets(String(resultat.stderr || '').trim());

  // Échec de lancement : `error` est peuplé et `status` vaut `null`.
  if (resultat.error || resultat.status === null) {
    if (tolererEchec) return null;
    const cause = resultat.error
      ? masquerSecrets(resultat.error.message)
      : `interrompu par le signal ${resultat.signal}`;
    throw new Error(`Lancement de « ${commande} » impossible : ${cause}`);
  }

  if (resultat.status !== 0) {
    if (tolererEchec) return null;
    throw new Error(
      `« ${commande} » a échoué (code ${resultat.status})` +
        (stderr ? `\n${tronquer(stderr, 4000)}` : ''),
    );
  }

  return {
    code: resultat.status,
    stdout: String(resultat.stdout || ''),
    stderr,
  };
}

/**
 * Lance `git` et renvoie stdout trimmé, ou `null` si l'échec est toléré.
 * Toujours mettre un `--` avant une liste de chemins.
 * @param {string[]} args
 * @param {{ tolererEchec?: boolean }} [options]
 * @returns {string|null}
 */
function git(args, { tolererEchec = false } = {}) {
  const resultat = lancer(args, { tolererEchec });
  return resultat === null ? null : resultat.stdout.trim();
}

/**
 * Y a-t-il au moins un commit entre `base` et HEAD ? Traite R4 : sans ce
 * contrôle, `git push` ne pousse rien puis `gh pr create` échoue sur
 * « No commits between ». Exact dans un clone `--depth=1`.
 * @param {string} base
 * @returns {boolean}
 */
function aDesCommits(base) {
  if (typeof base !== 'string' || base.trim() === '' || base.startsWith('-')) {
    throw new TypeError(
      `aDesCommits() attend une révision de base non vide, reçu ${JSON.stringify(base)}`,
    );
  }
  const sortie = git(['rev-list', '--count', `${base}..HEAD`, '--']);
  const compte = Number.parseInt(sortie, 10);
  if (!Number.isInteger(compte)) {
    throw new Error(`Compte de commits illisible pour ${base}..HEAD : ${JSON.stringify(sortie)}`);
  }
  return compte > 0;
}

/**
 * État du répertoire de travail : le statut à deux lettres AVEC le chemin, pas
 * seulement le chemin.
 *
 * Pourquoi le statut compte : `--porcelain` inclut les entrées `??` (non
 * suivies), et `git checkout -- <non-suivi>` sort en erreur
 * « pathspec did not match any file known to git ». Un simple rapport de
 * couverture ferait donc planter la boucle du lot 3b.
 *
 * `-uall` n’est pas décoratif : le défaut de git est `-unormal`, qui replie un
 * répertoire non suivi en UNE entrée (« ?? sous/ »). `estCheminInterdit()` ne
 * refuse pas « sous/ », et un `git add -- sous/` ajouterait alors tout son
 * contenu, y compris un `sous/package.json` que la liste interdit. Mesuré : la
 * configuration globale d’un poste de dev peut porter
 * `status.showUntrackedFiles=all` et masquer ce comportement — le runner, lui, a
 * le défaut.
 *
 * `-z` plutôt que le format texte : cela règle d'un coup les chemins avec retour
 * à la ligne, guillemets ou caractères non ASCII, qui pourraient sinon échapper
 * au contrôle de liste interdite.
 *
 * Renommage et copie : deux entrées, la destination avec le statut de git et
 * l'origine avec le statut « R< » (cf. `contrat.md`).
 *
 * @returns {{ statut: string, chemin: string }[]}
 */
function etatFichiers() {
  const brut = lancer(['status', '--porcelain', '-z', '-uall']).stdout;
  const morceaux = brut.split(NUL);
  const entrees = [];

  for (let i = 0; i < morceaux.length; i += 1) {
    const morceau = morceaux[i];
    if (morceau === '') continue; // dernier élément après le NUL final

    if (morceau.length < 4) {
      throw new Error(`Entrée de « git status -z » illisible : ${JSON.stringify(morceau)}`);
    }
    const statut = morceau.slice(0, 2);
    const chemin = morceau.slice(3);
    entrees.push({ statut, chemin });

    // Renommage ou copie : le chemin d'origine occupe l'entrée suivante. On le
    // renvoie aussi, pour que le lot 3b puisse stager les deux côtés du
    // renommage — ou refuser le chemin d'origine s'il est interdit.
    //
    // Convention de `contrat.md` : la destination garde le statut rendu par git
    // (« R  », « RM », « C  »), l'origine porte la sentinelle STATUT_ORIGINE
    // (« R< »). Sans ce marqueur, les deux côtés étaient indiscernables et le lot
    // 3b ne pouvait pas savoir lequel stager et lequel restaurer.
    if (statut.includes('R') || statut.includes('C')) {
      const origine = morceaux[i + 1];
      if (typeof origine === 'string' && origine !== '') {
        entrees.push({ statut: STATUT_ORIGINE, chemin: origine });
      }
      i += 1;
    }
  }

  return entrees;
}

/**
 * La branche existe-t-elle sur `origin` ? Traite R9 : sur un runner neuf il n'y a
 * aucune branche locale, donc `git switch -c` réussit et le push est rejeté en
 * non-fast-forward — après avoir tout consommé.
 * @param {string} nom
 * @returns {boolean}
 */
function brancheDistanteExiste(nom) {
  if (typeof nom !== 'string' || nom.trim() === '' || nom.startsWith('-')) {
    throw new TypeError(
      `brancheDistanteExiste() attend un nom de branche non vide, reçu ${JSON.stringify(nom)}`,
    );
  }
  const reference = `refs/heads/${nom}`;
  const sortie = git(['ls-remote', '--heads', 'origin', reference]);
  if (!sortie) return false;
  // `--heads <motif>` filtre par suffixe : on exige l'égalité exacte, sinon
  // `fix-issue-4` serait « trouvée » par `refs/heads/autre/fix-issue-4`.
  return sortie
    .split('\n')
    .some((ligne) => ligne.split('\t')[1] === reference);
}

module.exports = { git, aDesCommits, etatFichiers, brancheDistanteExiste };
