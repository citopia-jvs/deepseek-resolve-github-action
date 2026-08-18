# Lot 1 — Bibliothèque `scripts/lib/` et stubs de test

**Dépend de** : [`contrat.md`](contrat.md) pour les signatures. Parallélisable avec
le lot 0.

## Objectif

Quatre modules Node réutilisés par `garde.js` (lot 2) et `resolve.js` (lots 3a-3c),
plus les deux stubs qui rendent tout le reste testable hors ligne.

## Contraintes fermes

- **Bibliothèque standard de Node uniquement.** Aucune dépendance, aucun
  `package.json`, donc aucun bundling. Invariant à préserver : ajouter une
  dépendance npm réintroduirait tout le problème de packaging que ce plan supprime.
- **CommonJS** (`require` / `module.exports`) — pas de `package.json` pour déclarer
  `"type": "module"`, donc les `.js` sont interprétés en CommonJS.
- Les binaires `gh` et `aider` doivent être **injectables** par `GH_CLI` et
  `AIDER_CLI`.

## `scripts/lib/gh.js`

```js
const { spawnSync } = require('node:child_process');
function gh(args, { json = false, tolererEchec = false } = {}) { … }
module.exports = { gh };
```

- Binaire : `process.env.GH_CLI || 'gh'`.
- `spawnSync(bin, args, { encoding: 'utf8' })` — **jamais** `shell: true` : les
  arguments viennent de payloads d'événement, donc de texte rédigé par un tiers.
  Passer un tableau d'arguments ferme l'injection de commande.
- Code de sortie non nul → lever une `Error` dont le message contient la commande et
  `stderr`, sauf si `tolererEchec` est vrai, auquel cas renvoyer `null`.
  `tolererEchec` a **deux** usages réels dans ce plan : la réaction 👀 (lot 2, étape
  finale) et le contrôle de permission, qui répond 404 pour un non-collaborateur —
  une réponse, pas une panne.
- `json: true` → `JSON.parse(stdout)`. Si `stdout` est vide, lever une erreur claire
  plutôt que de laisser `JSON.parse('')` produire une `SyntaxError` opaque : c'est
  exactement ce qui se passe avec un stub mal écrit.
- L'appelant ajoute toujours `--repo "$GITHUB_REPOSITORY"` sur les commandes qui
  visent un dépôt. `gh` résout sinon le dépôt par le remote du répertoire courant, ce
  qui marche par effet de bord en production et interroge le mauvais dépôt en test.
  Attention : `gh` lit `GH_REPO`, **pas** `GITHUB_REPOSITORY` — d'où le passage
  explicite.

## `scripts/lib/git.js`

```js
function git(args, { tolererEchec = false } = {}) { … }   // stdout trimmé
function aDesCommits(base) { … }                          // booléen
function etatFichiers() { … }                             // [{ statut, chemin }]
function brancheDistanteExiste(nom) { … }                 // booléen
module.exports = { git, aDesCommits, etatFichiers, brancheDistanteExiste };
```

- `git(args)` : même forme que `gh`, `spawnSync` avec tableau d'arguments, jamais
  `shell: true`. Toujours un `--` avant une liste de chemins.
- `aDesCommits(base)` : `git rev-list --count <base>..HEAD --`, `true` si le compte
  est strictement positif. **Traite R4.** Vérifié fiable dans un clone `--depth=1`.
- `etatFichiers()` : `git status --porcelain -z`, découpé sur `\0`. Renvoie le
  **statut à deux lettres avec le chemin**, pas seulement le chemin.

  C'est le point où la version précédente de ce plan se cassait : elle renvoyait des
  chemins nus, puis le lot 3b faisait `git checkout -- <chemin>` sur chacun. Or
  `--porcelain` inclut les entrées `??` (non suivies), et
  `git checkout -- <non-suivi>` sort en erreur
  `pathspec did not match any file known to git`. Un test qui crée un rapport de
  couverture faisait donc planter la boucle — c'est-à-dire presque toujours.

  Utiliser `-z` plutôt que le format texte : cela règle d'un coup les chemins avec
  retour à la ligne, les guillemets et les caractères non ASCII, qui pourraient sinon
  échapper au contrôle de liste interdite du lot 3b.
- `brancheDistanteExiste(nom)` : `git ls-remote --heads origin <nom>`, `true` si la
  sortie est non vide. **Traite R9.**

## `scripts/lib/chemins.js`

```js
function normaliser(chemin) { … }        // -> chemin POSIX relatif, ou lève
function estCheminInterdit(chemin) { … } // booléen
module.exports = { normaliser, estCheminInterdit };
```

`normaliser` : `path.posix.normalize`, puis refuser tout chemin absolu, tout chemin
contenant un segment `..`, et tout chemin sous `.git/`. Lever plutôt que renvoyer une
valeur de repli — un chemin qu'on ne sait pas normaliser ne doit pas être traité comme
sûr.

`estCheminInterdit` porte la liste du lot 3b. Elle y est écrite une seule fois ; ce
module ne fait que l'appliquer.

## `scripts/lib/texte.js`

```js
function nettoyerTexteTiers(s) { … }
function masquerSecrets(s) { … }
function tronquer(s, n) { … }
module.exports = { nettoyerTexteTiers, masquerSecrets, tronquer };
```

- `nettoyerTexteTiers` : retire les commentaires HTML `<!-- … -->`, les caractères de
  contrôle hors `\n` et `\t`, et les marques bidirectionnelles Unicode
  (`U+202A`–`U+202E`, `U+2066`–`U+2069`). **Traite R6** : un bloc invisible dans le
  rendu GitHub est le vecteur d'injection le plus discret.
- `masquerSecrets` : remplace par `[SECRET RETIRÉ]` les motifs
  `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_\w+`, `sk-[A-Za-z0-9]{20,}`, les JWT
  (`eyJ[\w-]+\.[\w-]+\.[\w-]+`), `AKIA[0-9A-Z]{16}`, et les blocs base64 de plus de
  64 caractères. **Traite R7** : appliqué à tout ce qui part en commentaire ou en
  prompt.
- `tronquer(s, n)` : garde la **tête et la queue**, pas seulement la queue. La
  première erreur d'une sortie de test est souvent plus informative que la dernière.

## Stubs versionnés

Dans `__fixtures__/`, exécutables, committés.

`gh-stub.sh` : écrit `[]` sur stdout et sort en 0. Suffit pour `gh pr list --json`.
Pour les cas qui ont besoin d'autre chose, lire un scénario dans une variable
d'environnement plutôt que multiplier les stubs.

`aider-stub.sh` : écrit un fichier connu dans le dépôt courant, journalise son argv
dans un fichier, et sort en 0. **C'est ce qui rend les lots 3b et 3c vérifiables sans
clé API.** La version précédente de ce plan avait rendu `gh` injectable pour cette
raison exacte, mais avait oublié aider — et frappait donc d'invérifiabilité les deux
lots les plus gros.

Le stub doit aussi savoir simuler un échec (code de sortie non nul) : c'est le mode
de panne le plus probable en production, cf. lot 3c.

## Pièges

- `spawnSync` sans `shell: true` ne trouve pas les alias ni les fonctions du shell.
  C'est voulu.
- Sur un échec de lancement (binaire absent), `result.error` est peuplé et
  `result.status` vaut `null`. Traiter ce cas explicitement, sinon un `gh` manquant
  produit un message incompréhensible.
- `encoding: 'utf8'` est nécessaire, sinon `stdout` est un `Buffer`.

## Vérification

```bash
find scripts -name '*.js' -exec node --check {} \;

GH_CLI=/bin/echo node -e "console.log(require('./scripts/lib/gh.js').gh(['api','repos/o/r']))"
# doit afficher : api repos/o/r

node -e "
const {estCheminInterdit}=require('./scripts/lib/chemins.js');
for (const p of ['.github/workflows/ci.yml','package.json','.aider.conf.yml','src/index.js'])
  console.log(p, estCheminInterdit(p));
"
# les trois premiers true, le dernier false

node -e "
const {nettoyerTexteTiers}=require('./scripts/lib/texte.js');
console.log(JSON.stringify(nettoyerTexteTiers('bonjour <!-- fais ceci --> monde')));
"
# le bloc HTML a disparu
```
