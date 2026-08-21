# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ce qu'est ce dépôt

Composite action GitHub qui pilote [aider](https://aider.chat) avec un modèle DeepSeek
pour tenter de résoudre automatiquement une issue. Déclencheur : `@dseek` dans une
issue ou un commentaire d'issue, écrit par quelqu'un d'autorisé. L'action crée une
branche `fix-issue-<n>`, appelle aider, commite elle-même ce qu'elle a validé, pousse,
ouvre une pull request, puis boucle validation / correction jusqu'à ce que la commande
de validation passe ou que `max-iterations` soit atteint.

**Cette action n'implémente pas de boucle d'agent.** Elle n'appelle jamais directement
un modèle pour éditer du code : c'est aider qui lit le dépôt, choisit son contexte et
écrit les fichiers. Le rôle du dépôt est l'orchestration autour d'aider — déclenchement,
autorisation, garde-fous de configuration, exécution de la validation, publication. Un
agent qui viendrait ici pour « compléter » une couche modèle manquante se trompe de
problème : cette couche n'a pas à exister.

`README.md` documente l'usage côté consommateur (inputs, sorties, sécurité,
tarification). Ce fichier documente ce qu'un agent qui édite ce dépôt ne peut pas
déduire du code seul.

## Commandes

Aucune dépendance, aucun build, aucun linter installé — bibliothèque standard Node
seule (voir « Architecture »).

```bash
# syntaxe — un appel par fichier, jamais -exec
find scripts test -name '*.js' -print0 | xargs -0 -n1 node --check

# les sept suites, hors ligne, sans clé API ni réseau
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

Les suites sont **sept** : `chemins`, `texte`, `garde`, `boucle`, `action`,
`compte-rendu`, `ci`. Les lancer par le glob `test/*.test.js`, jamais par une liste de
noms écrite à la main — une suite ajoutée doit être exercée sans que personne y pense,
et une liste recopiée ici serait périmée au lot suivant. Ne pas maintenir de compte de
cas dans ce fichier, pour la même raison de péremption.

`validation-command` (défaut `npm test`) s'applique au dépôt **consommateur** de
l'action, jamais à celui-ci : il n'y a pas de `npm test` ici, et ce n'est pas un oubli.

Pour exercer `garde.js`, `resolve.js` ou `rendre-compte.js` isolément hors des suites,
remplacer `gh` et `aider` par les stubs versionnés via `GH_CLI` et `AIDER_CLI` — jamais
`GH_CLI=/bin/true` : `__fixtures__/gh-stub.sh` répond `[]` sur `gh pr list --json
number`, alors qu'un binaire muet laisserait `JSON.parse('')` lever dans le script.
Les tests le font déjà ; regarder l'en-tête de `__fixtures__/gh-stub.sh` et de
`__fixtures__/aider-stub.sh` pour le format des variables de scénario.

## Architecture

```
action.yml                # using: composite, 5 steps, 13 inputs, 5 outputs
aider.conf.yml            # config d'aider, maîtrisée par l'action, hors d'atteinte du modèle
aider-models.json         # métadonnées des modèles DeepSeek, absents de litellm
scripts/garde.js          # événement, autorisation, anti-rejeu — tourne avant l'install d'aider
scripts/resolve.js        # préparation de la branche, primitives, orchestration de la boucle
scripts/rendre-compte.js  # step if: always() — compte rendu, y compris quand resolve.js est mort
scripts/lib/              # gh.js, git.js, chemins.js, texte.js — stdlib seule
__fixtures__/             # payloads d'événements + stubs gh et aider
test/                     # sept suites, lancées par le glob test/*.test.js
.github/workflows/test.yml # la CI du dépôt : quatre jobs, hors ligne
plan/                     # le plan de refonte, dont contrat.md — source des noms
```

Les cinq steps de `action.yml`, dans l'ordre : garde, `actions/setup-python`,
installation d'aider par `pipx`, résolution (`resolve.js`), compte rendu en
`if: always() && …poursuivre == 'true'`.

Contraintes à connaître avant de toucher au code, parce qu'elles ne se lisent pas
dans un seul fichier :

- **Bibliothèque standard Node seule, CommonJS.** Aucune dépendance npm : pas de
  `package.json`, pas de `node_modules`, pas de bundling, pas de `dist/`. Ajouter une
  dépendance réintroduirait tout le problème de packaging qu'une composite action sans
  build supprime. C'est un invariant à préserver, pas un oubli à corriger.
- **Les inputs d'une composite action ne sont pas exposés en `INPUT_*`** aux
  sous-processus, contrairement à une action JS. Toute valeur qu'un script doit lire
  figure dans le `env:` de son step, dans `action.yml`. Une faute de frappe dans
  `${{ inputs.* }}` s'évalue en chaîne vide **sans erreur** : c'est l'oubli le plus
  probable à l'ajout d'un input, et c'est pour ça que `test/action.test.js` existe —
  il contrôle la cohérence `inputs:` ↔ `${{ inputs.* }}`, et le job `suites` de la CI
  le lance.
- **`$GITHUB_ACTION_PATH`, jamais un chemin relatif**, pour atteindre `scripts/*.js`.
  En `uses: ./`, cette variable vaut `GITHUB_WORKSPACE` (`ActionManager.cs:699-705` du
  runner) : un chemin relatif y passerait sans se faire remarquer. Chez un consommateur,
  l'action est déployée sous `_actions/<owner>/<repo>/<ref>`, où le même chemin relatif
  casse. C'est le job `smoke-sous-repertoire` de la CI qui attrape cette régression —
  pas `smoke-local`, où `GITHUB_ACTION_PATH` vaut justement le workspace et masquerait
  le défaut.
- **La garde tourne avant l'installation d'aider**, volontairement : `pipx install`
  amène 107 paquets tiers et prend plus d'une minute, pour un déclencheur qui, dans
  l'immense majorité des cas, sera refusé par la garde.
- **Une composite action n'a ni `timeout-minutes`, ni `concurrency`, ni `pre:`/`post:`.**
  Le schéma d'une composite ne connaît que `{using, steps}`. D'où le step
  `if: always() && …poursuivre == 'true'` pour le compte rendu de secours, et le renvoi au workflow consommateur
  pour `timeout-minutes` et `concurrency` — cette action ne peut pas les porter
  elle-même.

### `plan/contrat.md` est la source de vérité des noms

Tout nom qu'un fichier consomme — sortie de la garde, variable d'environnement d'un
script, signature d'une primitive de `scripts/lib/` — s'ajoute **là** avant le code.
Deux suites s'appuient dessus, et **pas de la même façon** — la distinction compte :

- `test/ci.test.js` **lit le fichier** et compare, donc il rougit dès que le workflow et
  le contrat divergent, y compris sur la forme exacte des tableaux qu'il analyse (la
  liste des sept suites, la version et le condensat d'`actionlint`, les identifiants de
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

Elle n'est jamais vide : `StepsRunner.cs:53` la pose **avant** le premier step. Cette
moitié tient, confirmée à l'exécution.

L'autre moitié — « elle n'est pas remise à `success` dans les steps d'une composite » —
était **fausse**, et ça s'est vu en run réel. Mesuré sur le run `32380365244`
(image `ubuntu-24.04`) : le step `resoudre` se termine en `conclusion=failure`, et le
step suivant de la **même** composite démarre en recevant `success`. Le compte rendu
de secours en a conclu — à tort — qu'un compte rendu avait déjà été publié par la
boucle, et il n'a rien publié, dans le seul scénario où ce step existe. C'est l'issue
#3 : job rouge, aucun compte rendu.

La lecture d'`ExecutionContext.cs:136-138` et de `CompositeActionHandler.cs:144-158`
qui a produit l'affirmation fausse n'était pas absurde en soi : un step embarqué reçoit
bien l'objet `JobContext` du job appelant, ces deux fichiers ne remplaçant que
`inputs`, `steps`, `github` et `env`. Mais partager l'objet n'autorisait pas à en
**déduire** que sa clé `status` refléterait l'échec d'un step déjà terminé du même job,
au moment où le step suivant lit son `env:`. Elle ne le fait pas.

**Conséquence : l'action ne consomme plus cette expression.** Le critère de silence du
step de secours n'est plus « le job a-t-il échoué ? » mais « un compte rendu existe-t-il
déjà pour ce run ? ». `rendre-compte.js` répond à cette question en cherchant un
marqueur : `<!-- deepseek-resolve:compte-rendu run=<id>-<tentative> -->`, qui porte
l'identifiant et la tentative du run, ou un marqueur **nu**, sans suffixe, quand la
portée est inconnue (exécution locale, harnais de test). La reconnaissance accepte les
deux formes (`porteeDuRun()`, `marqueurCompteRendu()` dans `scripts/resolve.js` et
`scripts/rendre-compte.js`) — sans quoi une relance de job republierait le compte rendu
du run précédent, ou l'inverse : le tairait à tort.

Leçon de méthode, pour tout agent qui serait tenté de trancher un point du runner en
lisant `actions/runner` plutôt qu'en le mesurant : **une lecture du code du runner ne
remplace pas une mesure sur le runner.** C'est ce raccourci qui a fait renoncer, au
lot 5, au smoke test qui aurait fait mourir `resolve.js` en CI — le seul dispositif du
dépôt qui aurait attrapé ce défaut avant un run réel. Le dépôt est resté vert pendant
que l'action ne publiait rien. Détail de la mesure et du raisonnement :
`plan/contrat.md`, section « Ce que vaut `${{ job.status }}` dans une composite
action ».

## Pièges vérifiés

Heures de débogage économisées ; aucun ne se devine à la lecture du code seul.

- **`aider-chat` est figé à `0.86.2`** et épingle `litellm==1.81.10`, dont la table de
  modèles ne connaît aucun modèle DeepSeek V4. Les seuls noms qu'aider connaît
  nativement côté DeepSeek, `deepseek-chat` et `deepseek-reasoner`, sont **inaccessibles
  depuis le 2026-07-24 15:59 UTC**. D'où `aider-models.json`, embarqué par l'action et
  passé en `--model-metadata-file`, pour décrire `deepseek/deepseek-v4-pro` et
  `deepseek/deepseek-v4-flash`. Monter `aider-version` oblige à revérifier ce fichier.
- aider lit `git config user.name` **hors** de son bloc `try` — `aider/repo.py:291`
  contre `:296` — donc sans identité git configurée, il plante net. `actions/checkout`
  ne configure pas d'identité.
- **aider ne commite pas par `git commit -a`.** Les deux appelants de `repo.commit`
  passent une liste de fichiers explicite — `aider/coders/base_coder.py:2383` et
  `:2419` — et la branche `cmd += ["-a"]` de `aider/repo.py:289` est morte dans ce
  flux. Le risque réel, plus étroit, est `--dirty-commits` (défaut `True`) sur un
  fichier que la validation vient de modifier et qu'aider édite ensuite — sans effet
  ici puisque l'action passe `--no-auto-commits` **et** `--no-dirty-commits`, et pose
  `dirty-commits: false` dans `aider.conf.yml` : les trois, pas seulement le premier —
  écrit autrement, `--no-dirty-commits` passe pour redondant et se fait retirer.
- **`--config`, `--env-file` et `--model-metadata-file` sont cherchés dans le git
  root** — c'est-à-dire le checkout du consommateur, là où le modèle écrit. Un
  `.aider.conf.yml` créé à l'itération 1 est donc lu à l'itération 2 et peut y fixer
  `lint-cmd`, exécuté puisque `--auto-lint` vaut `True` par défaut.

  **Et ces trois flags ne suffisent pas** — le code le dit en tête de
  `neutraliserDecouverteAider()` : `main.py:463-477` du wheel construit
  `default_config_files` quelle que soit la valeur de `--config`, et une clé absente de
  notre fichier retombe sur celui du dépôt. R8 repose donc sur **quatre** mécanismes,
  pas sur les flags :

  Dans l'ordre où `appelerAider` les exécute, ce qui en fait aussi une carte de cette
  fonction :

  1. `HOME` et les `XDG_*` sont pointés sur le répertoire privé du run quand
     l'environnement d'aider est construit, pour que la découverte dans le répertoire
     personnel ne trouve rien ;
  2. `neutraliserDecouverteAider()` supprime un `.aider.conf.yml` ou un
     `.aider.model.metadata.json` **non suivi** à la racine du checkout — ces deux
     fichiers-là, pas tous les `.aider*` ;
  3. `mettreEnvALAbri()` sort un `.env` non suivi du dépôt le temps de l'appel, et le
     remet en place dans un `finally` — la commande de validation du consommateur peut
     en avoir besoin ;
  4. `materialiserConfigurationAider()` écrit des **copies privées, réécrites à chaque
     appel**, dans un `mkdtemp` du run — hors du checkout **et hors de
     `$GITHUB_ACTION_PATH`**, parce que la commande de validation peut écrire dans le
     répertoire de l'action. Les flags pointent sur ces copies, et `--env-file` vaut
     `/dev/null`.

  Un cinquième mécanisme n'appartient pas à l'appel :
  `supprimerFichiersAiderNonSuivis()` retire **tous** les `.aider*` non suivis, et il
  est appelé **avant chaque validation** — le cache de la carte du dépôt compris, d'où
  sa reconstruction à chaque tour. Les portées du point 2 et de celui-ci sont
  différentes : les confondre conduit à supprimer l'un des deux appels comme un
  doublon.
- Défauts de flags en `0.86.2`, relevés dans `aider/args.py` du wheel, tous à `True` :
  `--gitignore`, `--auto-commits`, `--dirty-commits`, `--auto-lint`,
  `--suggest-shell-commands`, `--show-model-warnings`. Un seul à `False` :
  `--git-commit-verify` — aider commite donc avec `--no-verify`, et aucun hook
  `pre-commit` du dépôt consommateur ne peut faire échouer ce commit.
- **`--yes-always` refuse les commandes shell suggérées par le modèle** :
  `aider/coders/base_coder.py:2459` passe `explicit_yes_required=True`, et
  `aider/io.py:866-867` rend `"n"` dans ce cas précis. Une vraie protection, mais un
  détail d'implémentation amont sur lequel l'action ne s'appuie pas seule :
  `--no-suggest-shell-commands` est passé quand même.
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
- **Les TROIS commandes git distantes portent le préfixe d'authentification, pas
  seulement le push.** `construirePrefixeAuthentification()` sert à `ls-remote`
  (`scripts/lib/git.js`, R9), aux deux `fetch` de `resoudreBase` et
  `etablirBrancheTravail`, et au `push` de `pousser`. D'où l'ordre des étapes de
  `preparer()` : le préfixe est construit **avant** la résolution de la base, parce
  que les étapes suivantes en ont besoin. N'avoir authentifié que le push a été un
  vrai défaut, tenu jusqu'au premier déroulé sur un runner : sous
  `persist-credentials: false` — la configuration que le README recommande — le
  `ls-remote` sortait en `fatal: could not read Username for 'https://github.com'`
  et le job mourait avant le premier appel à aider. **Les sept suites étaient
  vertes**, et elles ne pouvaient pas ne pas l'être : les dépôts jetables du
  harnais ont un `origine` local, joignable sans jeton. C'est pour ça que le cas
  qui ferme ce trou (`test/boucle.test.js`, « R7 — tout appel git distant porte le
  préfixe ») est un **lecteur statique de source** et non une exécution. Il
  reconnaît deux formes de tableau — l'appel inline `git([...prefixeAuth, 'fetch',
  …])` et le tableau nommé `const argumentsPush = [...]` de `pousser()` — et un
  second cas exige d'en trouver au moins quatre, pour qu'un changement de forme le
  fasse rougir au lieu de le rendre vert et muet.
- **Le `GITHUB_TOKEN` n'a pas le droit « workflows ».** Toute écriture sous
  `.github/workflows/**` fait échouer le **push**, et le refus porte sur les commits
  poussés, pas sur l'état final de la branche : restaurer le fichier au tour suivant ne
  suffit donc pas, le commit fautif reste dans l'histoire. C'est toute la raison d'être
  de `scripts/lib/chemins.js` et du commit sur **liste explicite de chemins** plutôt que
  d'un `git commit -a`. Sans cette note, ces deux mécanismes paraissent gratuits.
- `git checkout -- <entrée « ?? »>` **échoue** en `pathspec did not match any file known
  to git` : un fichier non suivi n'a rien à restaurer. La restauration du travail refusé
  distingue donc suivi et non suivi, et n'utilise jamais `git checkout -- .`, qui
  écraserait aussi le travail légitime.
- **`author_association` n'est pas une permission**, et c'est pour ça que la garde a deux
  étages. `MEMBER` dit « membre de l'organisation », `COLLABORATOR` inclut `read` et
  `triage`, et GitHub ne renvoie qu'**une seule** valeur — donc un mainteneur qui a déjà
  commité est rapporté `CONTRIBUTOR`. Le second étage interroge
  `gh api repos/{o}/{r}/collaborators/{login}/permission` et exige `write`, `maintain`
  ou `admin`. Un agent qui « simplifierait » `garde.js` en retirant cet étage ouvrirait
  la porte à un compte en lecture seule.
- **`pipx` est préinstallé sur les images Ubuntu.** Ne pas ajouter d'étape
  d'installation, et surtout pas un `curl … | sh` : `action.yml` se contente de
  contrôler sa présence et d'expliquer l'absence sur un runner auto-hébergé.
- **R11 — le runner est épinglé en dur.** `actions/setup-python` installe le `3.12` de
  l'input `python-version`, et `pipx install --python "$(which python)"` s'en sert ; mais
  l'exemple du README impose `ubuntu-24.04` en dur, et `test/ci.test.js` interdit
  `ubuntu-latest` dans le workflow du dépôt — deux cas dédiés, dont un sur le contenu
  entier du fichier. Motif : `ubuntu-latest` basculera sur 26.04, dont le Python 3.14
  est hors de la borne `<3.13` d'aider-chat, et cette action n'est vérifiée que sur
  l'image 24.04.
- **R7 — rien de brut ne sort.** `scripts/lib/texte.js` porte les trois primitives que
  tout le reste utilise : `masquerSecrets` (idempotente, appliquée jusque dans la
  journalisation, y compris comme filet en sortie), `nettoyerTexteTiers` (commentaires
  HTML, caractères de contrôle, invisibles) et `tronquer` (tête **et** queue). Aucune
  sortie **brute** de validation ni de aider n'atteint un commentaire de PR. Ce qui y
  passe est masqué et borné, et rien d'autre : le nom du premier test en échec, les
  chemins refusés du tour, et un motif d'échec court et mono-ligne extrait de la sortie
  d'aider. Trois canaux étroits, pas zéro — et le README dit pourquoi ils restent un
  risque résiduel.

  **Un quatrième canal est délibéré, et ne doit pas être confondu avec une fuite** : le
  corps de la pull request initiale publie la **consigne exacte** envoyée à aider, texte
  tiers compris, dans un bloc `<details>`. C'est l'atténuation de R6 — sans elle, une
  injection cachée dans un `<!-- … -->` reste invisible au relecteur. Ne pas la retirer
  en croyant fermer une fuite : elle est là pour en révéler une. L'environnement de
  la commande de validation est filtré, celui d'aider est une liste blanche. Retirer un
  seul de ces appels ne fait rien planter — c'est exactement pourquoi
  `test/texte.test.js` et le cas R7 de `test/boucle.test.js` existent.
- **La garde protège le déclencheur, pas la consigne.** Le corps de l'issue peut
  avoir été écrit par quelqu'un d'autre que l'auteur du `@dseek` — c'est le cas
  d'usage nominal, pas une anomalie. Un bloc `<!-- … -->` y est invisible dans le
  rendu GitHub. Ne pas écrire, ni laisser croire, que la garde suffit à elle seule :
  une version antérieure de ce fichier le faisait, et cela clôturait la réflexion sur
  R6 avant même de la commencer.

## Langue

Code, commentaires, messages de commit, prompts DeepSeek et commentaires publiés
sur les PR : tout est en français. S'y tenir.
