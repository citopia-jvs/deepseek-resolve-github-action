'use strict';

// Nettoyage du texte rédigé par un tiers, masquage des secrets, troncature.
// Traite R6 (injection par bloc invisible) et R7 (fuite de secrets par les
// commentaires de PR, les prompts et les logs du job).
//
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const MARQUEUR_SECRET = '[SECRET RETIRÉ]';

// Commentaires HTML, y compris un bloc jamais refermé : dans le rendu GitHub il
// avale tout ce qui suit, c'est donc le vecteur le plus discret.
const COMMENTAIRE_HTML = /<!--[\s\S]*?-->/g;
const COMMENTAIRE_HTML_NON_FERME = /<!--[\s\S]*$/;

// Caractères de contrôle C0 ET C1, sauf \t (U+0009) et \n (U+000A). \r est retiré :
// il ne fait pas partie des exceptions, et sa disparition normalise les fins de
// ligne. Les classes sont écrites en \u pour que le fichier reste du texte lisible.
const CONTROLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// Caractères invisibles à la lecture : marques bidirectionnelles (U+202A-U+202E,
// U+2066-U+2069), espaces et jointures de largeur nulle (U+200B-U+200F, U+2060) et
// BOM (U+FEFF). Le critère de R6 est « invisible dans le rendu », pas
// « bidirectionnel » : ils permettent tous d'afficher un texte anodin tout en
// envoyant autre chose au modèle.
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

// Masquage STRUCTUREL, appliqué avant les motifs par forme : ici c'est la position
// du secret qui le désigne, pas son apparence. Indispensable parce que les motifs
// par forme dépendent d'une longueur — un jeton de moins de 34 caractères produit un
// en-tête base64 de moins de 65 caractères, qui échappait au bloc base64 ci-dessous
// et partait en clair dans un message d'erreur de git.
//
// Le `(?!\[SECRET)` n'est pas une précaution de style : sans lui, la fonction n'est pas
// IDEMPOTENTE, et elle est appliquée plusieurs fois de suite en pratique — `lib/git.js`
// masque déjà son stderr, puis l'appelant remasque avant de publier. Mesuré : le
// marqueur contient une espace, donc `\S+` ne consomme que « [SECRET » et laisse
// « RETIRÉ] » derrière, ce qui donnait « [SECRET RETIRÉ] RETIRÉ] RETIRÉ] » publié dans
// un commentaire de PR. Le marqueur est ainsi exclu de ce qui peut être masqué.
const MOTIFS_SECRET_STRUCTURELS = [
  // `git -c http.extraheader="AUTHORIZATION: basic <base64>"` du lot 3a.
  [/((?:authorization)\s*:\s*(?:basic|bearer)\s+)(?!\[SECRET)\S+/gi, `$1${MARQUEUR_SECRET}`],
  // La paire en clair, avant encodage.
  [/(x-access-token\s*:\s*)(?!\[SECRET)[^\s@]+/gi, `$1${MARQUEUR_SECRET}`],
  // Identifiants dans une URL de remote : git les recopie tels quels dans ses
  // messages d'erreur, et c'est la forme que pose `persist-credentials: true`.
  [/(https?:\/\/)[^/\s:@]+(?::[^/\s@]+)?@/g, `$1${MARQUEUR_SECRET}@`],
];

// Motifs de secrets, du plus spécifique au plus général. Le bloc base64 est
// délibérément large : il attrape un jeton encodé, qu'aucun motif nommé ne voit.
const MOTIFS_SECRET = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // jetons GitHub classiques, dont le ghs_ du runner
  /github_pat_\w+/g, // jetons à portée fine
  /sk-[A-Za-z0-9]{20,}/g, // clés de style OpenAI / DeepSeek
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, // JWT
  /AKIA[0-9A-Z]{16}/g, // clés d'accès AWS
  /[A-Za-z0-9+/]{65,}={0,2}/g, // bloc base64 de plus de 64 caractères
];

/**
 * Retire d'un texte tiers ce qui peut détourner le modèle ou le lecteur :
 * commentaires HTML, caractères de contrôle, marques bidirectionnelles.
 * @param {string} s
 * @returns {string}
 */
function nettoyerTexteTiers(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(COMMENTAIRE_HTML, '')
    .replace(COMMENTAIRE_HTML_NON_FERME, '')
    .replace(CONTROLES, '')
    .replace(INVISIBLES, '');
}

/**
 * Remplace tout motif de jeton connu par un marqueur. À appliquer à TOUT ce qui
 * part en commentaire de PR, en prompt, ou dans un message d'erreur journalisé :
 * `::add-mask::` ne voit ni un jeton encodé ni un jeton coupé en deux.
 * @param {string} s
 * @returns {string}
 */
function masquerSecrets(s) {
  if (typeof s !== 'string') return '';
  let sortie = s;
  for (const [motif, remplacement] of MOTIFS_SECRET_STRUCTURELS) {
    sortie = sortie.replace(motif, remplacement);
  }
  for (const motif of MOTIFS_SECRET) {
    sortie = sortie.replace(motif, MARQUEUR_SECRET);
  }
  return sortie;
}

/**
 * Tronque en gardant la tête ET la queue : la première erreur d'une sortie de
 * test est souvent plus informative que la dernière.
 * @param {string} s
 * @param {number} n longueur maximale du résultat, entier strictement positif
 * @returns {string}
 */
function tronquer(s, n) {
  if (typeof s !== 'string') return '';
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(
      `tronquer() attend un entier strictement positif, reçu ${JSON.stringify(n)}`,
    );
  }
  if (s.length <= n) return s;

  const marqueDe = (k) => `\n[… ${k} caractères retirés …]\n`;
  // On réserve la place du marqueur le plus long possible : le résultat ne
  // dépasse donc jamais n, même si le compte final s'écrit sur moins de chiffres.
  const restant = n - marqueDe(s.length).length;
  // `<= 1` et non `<= 0` : avec exactement un caractère de contenu à répartir,
  // `Math.ceil(1 / 2)` donnait toute la place à la tête et une queue vide, donc la
  // tête seule — précisément ce que le contrat interdit. Une seule valeur de `n`
  // était touchée (la longueur du marqueur plus un), et elle a été trouvée par un
  // balayage exhaustif, pas par relecture.
  if (restant <= 1) {
    // n trop petit pour loger le marqueur : on répartit quand même tête et queue.
    // Rendre la tête seule ferait perdre la fin de la sortie, que le contrat exige.
    const teteNue = Math.ceil(n / 2);
    return s.slice(0, teteNue) + s.slice(s.length - (n - teteNue));
  }

  const tete = Math.ceil(restant / 2);
  const queue = restant - tete;
  return (
    s.slice(0, tete) +
    marqueDe(s.length - restant) +
    (queue > 0 ? s.slice(s.length - queue) : '')
  );
}

// MARQUEUR_SECRET n'est pas exporté : `contrat.md` est la seule source des noms,
// et une constante d'implémentation n'a pas à y figurer.
module.exports = { nettoyerTexteTiers, masquerSecrets, tronquer };
