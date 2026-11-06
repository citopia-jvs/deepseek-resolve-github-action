# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ce qu'est ce dépôt

Composite action GitHub qui tente de résoudre une issue avec Claude Code, branché sur
un modèle Scaleway. Déclencheur : `@ag-resolve` dans une issue ou un commentaire d'issue,
écrit par quelqu'un qui a le droit d'écriture. L'action prend l'issue en charge, crée
la branche `fix-issue-<n>`, ouvre une PR brouillon sur un commit vide, fait passer
Claude Code, lance elle-même les tests, donne **une** seconde chance au modèle en cas
d'échec, puis passe la PR en prête et demande la revue — ou la laisse en brouillon.

**Ce dépôt n'implémente pas de boucle d'agent.** Le modèle est exécuté par
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action),
en mode agent, épinglée par SHA. Le dépôt fournit ce qui l'entoure : garde,
préparation, proxy Anthropic → OpenAI vers Scaleway (`scripts/proxy.js`),
vérification, conclusion. Jusqu'à `v1`, le moteur était aider + DeepSeek ; le nom du
dépôt en vient. Le pourquoi de la refonte et ses mesures : `plan/essai-claude-code.md`.

`README.md` documente l'usage côté consommateur. Ce fichier documente ce qu'un agent
qui édite ce dépôt ne peut pas déduire du code seul.

## Commandes

Aucune dépendance, aucun build, aucun linter installé — bibliothèque standard Node
seule (voir « Architecture »).

```bash
# syntaxe — un appel par fichier, jamais -exec
find scripts test -name '*.js' -print0 | xargs -0 -n1 node --check

# toutes les suites, hors ligne, sans clé API ni réseau
for suite in test/*.test.js; do node "$suite"; done
```

Ces deux commandes sont vérifiées, telles qu'écrites, à la racine du dépôt.

Ne jamais écrire `find … -exec node --check {} \;` : mesuré, cette forme rend **0**
même sur un script syntaxiquement cassé — un code de sortie non nul de l'utilitaire
lancé par `-exec … ;` n'est pas remonté par `find` comme une erreur. La forme
`-exec … +` ne vaut pas mieux : `node --check bon.js casse.js` ne rend que le verdict
du premier fichier, node ignorant silencieusement les suivants. Seule la forme
`xargs -0 -n1` fait un appel par fichier et remonte l'échec. `.github/workflows/test.yml`
utilise cette même forme, et `test/ci.test.js` l'y épingle jeton par jeton — mais
**rien ne lit ce fichier-ci** : aucun test ne contrôle que les deux restent d'accord.
Éditer le tube du workflow oblige donc à revenir corriger ce bloc à la main.

Les suites sont celles de « Suites de test du dépôt » dans `plan/contrat.md`. Les
lancer par le glob `test/*.test.js`, jamais par une liste de noms écrite à la main —
une suite ajoutée doit être exercée sans que personne y pense. Ne pas maintenir de
compte — de cas de test, de steps, d'inputs, d'outputs ou de jobs — nulle part dans ce
fichier : un chiffre figé ici finit par mentir sans que rien ne le signale.

`validation-command` (défaut `npm test`) s'applique au dépôt **consommateur** de
l'action, jamais à celui-ci : il n'y a pas de `npm test` ici, et ce n'est pas un oubli.

Pour exercer un script isolément hors des suites, remplacer `gh` par le stub versionné
via `GH_CLI` — jamais `GH_CLI=/bin/true` (voir « Pièges »). `test/etapes.test.js`
montre comment monter un dépôt jetable avec un `origin` local.

Rien de ce qui touche à claude-code-action ou au modèle ne se teste hors ligne. Pour le
mesurer, il faut un runner : le dépôt d'essai privé `citopia-jvs/dsr-bac-a-sable` a
servi à toutes les mesures de `plan/essai-claude-code.md`.

## Architecture

```
action.yml                # using: composite — le déroulé est dans plan/contrat.md
scripts/garde.js          # événement, autorisation, anti-rejeu
scripts/preparer.js       # branche, commit vide, PR brouillon, consigne, sauvegarde de .git/config
scripts/proxy.js          # proxy local Anthropic → OpenAI, lancé en tâche de fond par action.yml
scripts/verifier.js       # commande de validation, SANS le jeton GitHub
scripts/conclure.js       # commit sur liste blanche, push, PR prête + revue, ou brouillon
scripts/lib/              # gh, git, chemins, texte, traduction, action — stdlib seule
__fixtures__/             # payloads d'événements + stub gh
test/                     # les suites, lancées par le glob test/*.test.js
.github/workflows/test.yml # la CI du dépôt : plusieurs jobs, hors ligne
plan/                     # contrat.md — source des noms — et mesures des essais
```

Contraintes à connaître avant de toucher au code, parce qu'elles ne se lisent pas
dans un seul fichier :

- **Bibliothèque standard Node seule, CommonJS.** Aucune dépendance npm : pas de
  `package.json`, pas de `node_modules`, pas de bundling, pas de `dist/`. C'est un
  invariant à préserver, pas un oubli à corriger.
- **Les inputs d'une composite action ne sont pas exposés en `INPUT_*`** aux
  sous-processus. Toute valeur qu'un script doit lire figure dans le `env:` de son
  step. Une faute de frappe dans `${{ inputs.* }}` s'évalue en chaîne vide **sans
  erreur** : c'est pour ça que `test/action.test.js` contrôle la cohérence
  `inputs:` ↔ `${{ inputs.* }}` et le bloc `env:` exact de chaque step.
- **`$GITHUB_ACTION_PATH`, jamais un chemin relatif**, pour atteindre `scripts/*.js`.
  En `uses: ./`, cette variable vaut `GITHUB_WORKSPACE` : un chemin relatif y
  passerait sans se faire remarquer, et casserait chez un consommateur. C'est le job
  `smoke-sous-repertoire` de la CI qui attrape cette régression.
- **Une composite action n'a ni `timeout-minutes`, ni `concurrency`, ni `pre:`/`post:`.**
  Ces garde-fous sont renvoyés au workflow consommateur. Les steps qui doivent tourner
  après un échec portent `always()` et lisent `steps.<id>.outcome`.

### `plan/contrat.md` est la source de vérité des noms

Tout nom qu'un fichier consomme — sortie de la garde, variable d'environnement d'un
script, signature d'une primitive de `scripts/lib/` — s'ajoute **là** avant le code.
Deux suites s'appuient dessus, et **pas de la même façon** — la distinction compte :

- `test/ci.test.js` **lit le fichier** et compare, donc il rougit dès que le workflow et
  le contrat divergent, y compris sur la forme exacte des tableaux qu'il analyse (la
  liste des suites, la version et le condensat d'`actionlint`, les identifiants de
  jobs). Aligner le contrat suffit à le faire repasser au vert, et le casser suffit à le
  faire rougir ;
- `test/action.test.js`, lui, **transcrit** les tables du contrat en dur dans son code —
  il ne les relit pas. Modifier le contrat seul ne le fera donc ni rougir ni verdir : il
  faut éditer la suite aussi. C'est un piège, pas une élégance.

Dans les deux cas, l'échec est **bruyant** : une suite rouge, pas un comportement qui
change en silence. C'est justement ce qu'on veut.

### Interdits dans `.github/workflows/test.yml`, et pourquoi

`test/ci.test.js` interdit plusieurs formes dans le workflow. Ce ne sont pas des choix
de style : chacune ferme une mutation mesurée qui laissait la CI verte sans plus rien
contrôler. À connaître avant d'éditer ce fichier, sous peine de les recréer en croyant
corriger un test trop strict :

- aucun `||`, aucun `set +` qui désarme la détection d'échec (`set +e`, `set +o
  errexit`), aucun `;` hors forme composée (`for … ; do`, `if … ; then`) — trois
  façons différentes de rendre un job vert sans que le travail qu'il prétend faire ait
  eu lieu ;
- aucun `if:` ni `continue-on-error:` sur un job ou un step — les quatre jobs sont les
  checks obligatoires d'une branche protégée, un job sauté ou toléré remonterait vert
  quand même ;
- aucun `shell:` sur un step ni `defaults:` de job qui l'écraserait — **dans ce
  workflow seulement** : dans `action.yml`, la règle est inverse, `shell:` est
  obligatoire sur chaque `run:` d'une composite et `test/action.test.js` l'exige — le défaut du
  dépôt (`bash --noprofile --norc -eo pipefail`) est ce qui fait remonter l'échec du
  premier maillon d'un tube ;
- aucun `secrets.` ni `github.token` en contenu — c'est cette absence, et elle seule,
  qui autorise `set -x` dans ce workflow. Le ban attache la permission à sa prémisse :
  sans lui, un futur `env: TOKEN: ${{ secrets.X }}` la rendrait fausse sans que rien
  ne rougisse.

La table complète, avec la mesure qui justifie chaque ligne, est dans
`plan/contrat.md`. Une limite assumée y est aussi notée : aucun lecteur statique ne
peut fermer une mutation qui change la **sémantique** du shell sans changer son texte
(une fonction shell qui masque une commande, par exemple). Ce n'est pas prétendu couvert.

### Ce que vaut `${{ job.status }}` dans une composite

**L'action ne consomme pas cette expression, et ne doit pas la consommer.** Mesuré sur
le run `32380365244`, du temps de l'ancienne action : un step qui suit un step de la
**même** composite terminé en `failure` reçoit `job.status == 'success'`. Les
conditions des steps lisent donc `steps.<id>.outcome` — mesuré lisible au step
suivant, run `42223323921`. Procès-verbal complet dans `plan/contrat.md`.

Leçon de méthode, qui vaut pour tout ce dépôt : **une lecture du code du runner — ou de
claude-code-action — ne remplace pas une mesure sur le runner.** Ce raccourci a déjà
laissé le dépôt vert pendant que l'action ne publiait rien.

## Pièges vérifiés

Heures de débogage économisées ; aucun ne se devine à la lecture du code seul.

- **claude-code-action met le jeton GitHub à portée du modèle, par construction.** Elle
  le place dans l'environnement de Claude Code (`GITHUB_TOKEN`, `GH_TOKEN` :
  `src/entrypoints/run.ts:190` au SHA épinglé) et réécrit l'URL du remote avec
  (`https://x-access-token:<jeton>@…`, `src/github/operations/git-config.ts:132`).
  Mesuré au lot C : avec Bash, `cat .git/config` passe sans être dans la liste
  blanche — Claude Code autorise d'office les lectures dans le répertoire de travail.
  D'où **Claude Code sans Bash** (`--disallowedTools "Bash,…"`) et `deny` sur
  `./.git/**`. Ne pas rendre Bash au modèle pour « qu'il puisse lancer les tests » : un
  test qu'il écrit est du code qui lit l'environnement, et aucune règle `deny` ne filtre
  ce que fait le code lancé. Les tests, c'est `verifier.js`.
- **`.git/config` est restauré depuis la sauvegarde de `preparer.js`**, avant et après
  les tests, et au début de `conclure.js`. Avant : effacer le jeton que
  claude-code-action y a mis. Après : défaire ce qu'un test a pu y poser
  (`core.fsmonitor` est exécuté par `git status`, donc dans `conclure.js`, qui porte
  le jeton). `commit` et `push` passent en plus `-c core.hooksPath=/dev/null`
  (`SANS_HOOKS`) : un test peut déposer un hook. Les deux sont exercés par
  `test/etapes.test.js`.
- **`persist-credentials: false` est exigé du consommateur, et vérifié.**
  `preparer.js` refuse un checkout qui a laissé un `extraheader` ou un `include.path`
  dans la configuration git. Toutes les commandes git distantes — `ls-remote`,
  `fetch`, `push` — portent `prefixeAuthentification()` (`scripts/lib/action.js`).
  Ne l'avoir mis que sur le push a déjà tué un run réel en `could not read Username`.
- **`--allowedTools` veut des virgules.** Mesuré au lot C : `"Read Edit Write"`
  arrive comme **une seule** entrée, et la restriction voulue n'est pas appliquée.
  `test/action.test.js` épingle la liste découpée par virgules.
- **En mode agent, claude-code-action ne publie rien** : ni commentaire de suivi, ni
  branche, ni PR. C'est voulu ici — nos steps s'en chargent —, mais la réponse finale du
  modèle n'existe que dans `execution_file`. `conclure.js` la lit et la publie,
  nettoyée et bornée. Ce fichier n'est écrit qu'en fin de session.
- **`github_token` doit être passé à claude-code-action**, sinon elle tente un échange
  OIDC contre un jeton de sa GitHub App, absente des dépôts consommateurs.
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS` fixe la fenêtre d'un modèle non-Claude**, pas
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Sans elle, Claude Code suppose 200 000 tokens.
  D'où l'input `context-window`.
- **Le proxy impose son modèle.** `SCW_MODELE` remplace le modèle demandé par Claude
  Code, qui ne fait que le journaliser. La clé amont passe par un **fichier**
  (`SCW_CLE_FICHIER`), supprimé dès le démarrage, et le proxy tourne sous
  `env -u SCW_SECRET_KEY` : `/proc/<pid>/environ` est lisible par tout processus du
  même utilisateur.
- Le stub `gh` ne doit **jamais** être `/bin/true` : `__fixtures__/gh-stub.sh` répond
  `[]` par défaut, ce que `gh pr list --json number` attend. Un binaire qui ne rend
  rien fait lever `JSON.parse('')` dans le script appelant, pas dans le stub — l'échec
  remonte au mauvais endroit et égare la recherche.
- `git status --porcelain` sans `-uall` replie un répertoire non suivi en une seule
  entrée `?? sous/`, et `git add -- sous/` en stagerait tout le contenu, interdits
  compris. `scripts/lib/git.js` passe donc `-z -uall`. **Deux gardes, pas une** :
  `-uall` déplie les répertoires non suivis ordinaires ; le repli qui subsiste malgré
  lui — un dépôt git imbriqué, que git rend toujours en une entrée `?? imbrique/` —
  est refusé par `estCheminInterdit`, qui rejette toute entrée finissant par `/`
  (`scripts/lib/chemins.js:220`, cas dédié dans `test/chemins.test.js`). Mesuré :
  `estCheminInterdit('sous/')` rend `true`. Ne pas retirer cette garde comme
  redondante avec `-uall` : `git add` sur un dépôt imbriqué enregistrerait un gitlink
  vers un commit absent.
- **Le `GITHUB_TOKEN` n'a pas le droit « workflows ».** Toute écriture sous
  `.github/workflows/**` fait échouer le **push**, et le refus porte sur les commits
  poussés, pas sur l'état final de la branche : restaurer le fichier au tour suivant ne
  suffit donc pas, le commit fautif reste dans l'histoire. C'est toute la raison d'être
  de `scripts/lib/chemins.js` et du commit sur **liste explicite de chemins** dans
  `conclure.js`, plutôt que d'un `git commit -a`. Sans cette note, ces deux mécanismes paraissent gratuits.
- **`author_association` n'est pas une permission**, et c'est pour ça que la garde a deux
  étages. `MEMBER` dit « membre de l'organisation », `COLLABORATOR` inclut `read` et
  `triage`, et GitHub ne renvoie qu'**une seule** valeur — donc un mainteneur qui a déjà
  commité est rapporté `CONTRIBUTOR`. Le second étage interroge
  `gh api repos/{o}/{r}/collaborators/{login}/permission` et exige `write`, `maintain`
  ou `admin`. Un agent qui « simplifierait » `garde.js` en retirant cet étage ouvrirait
  la porte à un compte en lecture seule.
- **R7 — rien de brut ne sort.** `scripts/lib/texte.js` porte `masquerSecrets`,
  `nettoyerTexteTiers` (commentaires HTML, caractères de contrôle, invisibles) et
  `tronquer` (tête **et** queue). Ce qui atteint un commentaire de PR — fin de la sortie
  des tests, dernière réponse du modèle, chemins refusés — est nettoyé, masqué et
  borné. **Un canal est délibéré, et ne doit pas être confondu avec une fuite** : le
  corps de la PR publie la **consigne exacte** envoyée au modèle. Sans elle, une
  injection cachée dans un `<!-- … -->` resterait invisible au relecteur.
- **La garde protège le déclencheur, pas la consigne.** Le corps de l'issue peut
  avoir été écrit par quelqu'un d'autre que l'auteur du `@ag-resolve` — c'est le cas
  d'usage nominal, pas une anomalie. Un bloc `<!-- … -->` y est invisible dans le
  rendu GitHub. Ne pas écrire, ni laisser croire, que la garde suffit à elle seule :
  une version antérieure de ce fichier le faisait, et cela clôturait la réflexion sur
  R6 avant même de la commencer.
- **Risque résiduel, non fermé, à ne pas présenter comme couvert :** les tests tournent
  sous le même utilisateur que `conclure.js`. Un processus qu'un test laisse en tâche
  de fond peut lire `/proc/<pid>/environ` du step qui porte le jeton, ou réécrire un
  script de l'action avant qu'il ne tourne. Seuls un conteneur ou un job sans jeton le
  fermeraient.

## Langue

Code, commentaires, messages de commit, consignes envoyées au modèle et commentaires
publiés sur les PR : tout est en français. S'y tenir.
