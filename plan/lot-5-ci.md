# Lot 5 — Intégration continue

**Dépend de** : lots 2, 3c et 4.
**Fichier** : `.github/workflows/test.yml`, aujourd'hui vide (0 octet).

## Objectif

Vérifier l'action à chaque PR, **sans clé API DeepSeek** et sans réseau vers l'API. Ce
qui est testable gratuitement doit l'être — et grâce au stub `AIDER_CLI` du lot 1, cela
inclut maintenant la boucle, ce qui n'était pas le cas dans la version précédente du
plan.

## Déclencheurs

```yaml
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
```

`permissions: contents: read` au niveau du workflow : aucun de ces jobs n'a besoin
d'écrire, et le défaut du dépôt est peut-être plus permissif.

Tous les jobs sur `runs-on: ubuntu-24.04`, pas `ubuntu-latest` : le smoke test doit
tourner sur la même image que celle recommandée aux consommateurs (R11).

## Job 1 — Syntaxe et workflows

```yaml
- run: find scripts test -name '*.js' -exec node --check {} \;
- uses: rhysd/actionlint@…      # ou le binaire
```

**Ces deux lignes sont fausses toutes les deux. Mesuré en écrivant le lot.**

`find … -exec node --check {} \;` rend **0 même quand un script a une erreur de
syntaxe** : un code non nul de l'utilitaire lancé par `-exec … ;` n'est pas une erreur
pour `find`. Sur un `scripts/casse.js` contenant `const a = ;` :

| Forme | Code de sortie |
| --- | --- |
| `find … -exec node --check {} \;` | **0** |
| `find … -exec node --check {} +` | dépend du **rang** du fichier cassé dans le lot |
| `find … -print0 \| xargs -0 -n1 node --check` | 1 |

C'est-à-dire que le contrôle censé attraper la faute de frappe **ne pouvait pas
échouer**.

La deuxième forme est plus insidieuse que « non portable », comme je l'ai d'abord écrit :
elle propage bien le code, mais elle ne contrôle qu'un fichier. Mesuré :
`node --check bon.js casse.js` rend **0** — `node --check` ne lit que son **premier**
argument et ignore les suivants sans un mot. Grouper les fichiers avec `+` ne contrôle
donc qu'un fichier par lot, et le résultat dépend de l'ordre rendu par `find`.

La forme retenue est le tube vers `xargs -0 -n1`, un appel par fichier, avec
`shell: bash` pour avoir `pipefail`. Ce que `pipefail` couvre ici n'est pas l'échec de
`node` — `xargs` est le dernier maillon, son code remonte de toute façon — mais l'échec
de **`find`** : mesuré sur un arbre sain plus un répertoire inexistant,
`find scripts test absent … | xargs …` rend **0** sans `pipefail` et **1** avec, après
avoir écrit `find: absent: No such file or directory`. Sans `pipefail`, un répertoire
renommé fait cesser le contrôle en le laissant vert.

`uses: rhysd/actionlint@…` **n'existe pas** : le dépôt ne publie pas d'`action.yml`
(404 sur `raw.githubusercontent.com/rhysd/actionlint/v1.7.12/action.yml`). Le binaire
est donc la seule voie ; version et condensat SHA-256 sont épinglés dans « Versions
épinglées » du contrat, et le condensat est contrôlé **avant** extraction.

`actionlint` sur `.github/workflows/**` : la version précédente de ce plan avait raison
de dire qu'il ne valide pas `action.yml`, mais elle en avait conclu qu'il fallait
abandonner l'outil. Il reste utile sur ce fichier-ci et sur l'exemple copiable du lot 6.

Ne **jamais** lui passer `action.yml` en argument : mesuré, il le lit comme un workflow
et rend huit erreurs absurdes, dont `"jobs" section is missing in workflow` et
`unexpected key "inputs" for "workflow" section`. Lancé sans argument depuis la racine,
il trouve seul `.github/workflows` et ne regarde que lui.

Le contrôle de cohérence `inputs:` ↔ `${{ inputs.* }}` **n'est plus à écrire ici** : le
lot 4 l'a livré comme `test/action.test.js`, en Node et sans dépendance, parce que le
bloc Python que ce lot demandait de reprendre était inexécutable (`pyyaml` absent) et,
surtout, **sortait en 0 même quand il trouvait des différences**. Voir « Suites de test
du dépôt » dans `contrat.md`. Il suffit donc de lancer la suite avec les autres.

Ce que ce remplacement perd, et qu'il faut couvrir ici : `yaml.safe_load()` validait
`action.yml` **en tant que YAML**. Le lecteur de blocs de `test/action.test.js` ne le
fait pas — mesuré, un guillemet non fermé dans une `description:` le laisse vert. Le
seul contrôle réel est un job qui **utilise** l'action : le runner refuse un
`action.yml` malformé au chargement. C'est le smoke test ci-dessous, et c'est une raison
de plus de ne pas s'en passer.

Les suites du dépôt sont recensées dans « Suites de test du dépôt » de
`contrat.md` : `chemins` (11), `texte` (22), `garde` (27), `boucle` (58), `action` (13),
`compte-rendu` (43) — **174 cas** à la fin du lot 4, auxquelles ce lot ajoute
`test/ci.test.js`. Ce lot n'en énumérait que trois :
`texte`, `action` et `compte-rendu` n'étaient recensés nulle part côté CI, et une suite
qu'aucun job ne lance ne protège rien.

### Les jobs 2, 3 et 4 sont fusionnés en un seul job `suites`

Décidé au lot 5, sur deux mesures.

Le découpage un job par suite n'achète pas de temps : les six suites du lot 4 prennent **23 s**
en tout — `boucle` 17 s, `compte-rendu` 5 s, `garde` 1 s, les trois autres moins d'une
seconde. Le seul coût réel est l'amorçage d'un runner par job.

Et surtout, une liste de suites écrite à la main dans le YAML est **exactement** ce qui
a laissé trois suites hors CI. Le job boucle donc sur `test/*.test.js` — sens « suite
ajoutée », fermé par le glob — et contrôle en plus l'existence des six fichiers nommés
par le contrat — sens « suite supprimée ou renommée », qu'un glob ne peut pas voir. Un
oubli ne peut alors rendre la CI que **plus** rouge.

Ce que le découpage perdait par ailleurs : rien. Un échec nomme la suite dans le journal
du step, et le job rougit.

Ce que ce lot demandait en plus, et qui est mesuré inutile : préfixer le job de la
boucle par `AIDER_CLI=… GH_CLI=…`. Les suites construisent l'environnement de leurs
sous-processus ; `AIDER_CLI=/bin/true GH_CLI=/bin/true node test/boucle.test.js` rend
58/58, donc ces variables ne changent rien. Elles ne sont pas posées : voir « La CI ne
pose ni `GH_CLI` ni `AIDER_CLI` » dans le contrat.

Les sections « Job 2 », « Job 3 » et « Job 4 » qui suivent gardent leur intérêt
documentaire — ce que chaque suite couvre et pourquoi — mais ne décrivent plus des jobs
distincts.

### Le workflow surveille les suites, et rien ne surveillait le workflow

Ce lot livre donc une **septième** suite, `test/ci.test.js`, sur le modèle de
`test/action.test.js` au lot 4. Elle est justifiée par les deux défauts mesurés de ce
lot, qui ont exactement la même forme : la CI reste verte et ne contrôle plus rien.

`find … -exec node --check {} \;` rend 0 sur un script cassé. Un `uses:` en chemin
relatif passe `smoke-local`. Dans les deux cas, aucun test du dépôt ne rougissait.

La suite épingle donc les formes dont l'écart est silencieux — la forme `xargs`, le
runner en dur, la version et le condensat d'`actionlint` comparés au contrat, le glob des
suites, l'absence d'expression dans un `uses:` et dans un corps de `run:` — et elle porte
la trappe `CI_YML` pour qu'on puisse la faire rougir sans toucher au vrai workflow. Voir
« Pourquoi une suite pour le workflow lui-même » dans le contrat.

Ce qu'`actionlint` attrape, et ce qu'il laisse passer — mesuré sur des mutants, parce que
c'est ce partage qui décide de ce que la suite doit contenir :

| Mutation | `actionlint` |
| --- | --- |
| expression dans un `uses:` | **rouge** — `no context is available here` |
| nom de sortie inexistant sur une action typée | **rouge** — `property "…" is not defined in object type {…}` |
| nom d'input inexistant dans un `with:`, y compris sur `./` | **rouge** — `input "…" is not defined in action` |
| `${{ github.event.issue.title }}` dans un `run:` | **rouge** — `potentially untrusted` |
| `runs-on: ubuntu-latest` | vert |
| suppression de `defaults: run: shell: bash` | vert |
| `${{ steps.<id>.outputs.<nom> }}` dans un `run:` | vert |
| suppression d'un `shell:` d'un step composite de `action.yml` | vert — il ne lit pas `action.yml` |
| `uses: ./copie-action` sans le répertoire | vert |

Les quatre dernières lignes sont exactement le périmètre de `test/ci.test.js` et des deux
jobs de smoke. Sans eux, la moitié des décisions de ce lot ne tiendraient qu'à la
relecture.

Première version de cette suite : 21 cas, deux batteries de mutations — 31 et 23 — toutes
rouges. La revue en a quand même vidé cinq contrôles du workflow en les laissant verts,
parce que les deux batteries ne muaient que des **formes**. Voir « La famille de mutations
qui compte » dans le contrat : c'est la leçon la plus utile du lot, et elle vaut pour tous
les harnais du dépôt.

Cinq passes de correction ont été nécessaires, chacune ouverte par la revue. La première a fermé les cinq contrôles
vidés (21 → 28 cas). La contre-visite a montré que le ban des échecs avalés restait une
liste de **graphies** : `sha256sum -c - || :`, `; true` et `set +o errexit` passaient, ce
dernier rendant le job vert avec 195 cas sur 206 rouges. La suite compte **32 cas**, et
les interdits sont désormais posés comme des propriétés — voir la table du contrat.

La troisième a fermé un contrôle qui portait sur la **présence** d'un motif et non sur son
exclusivité : `find scripts test -path nulle-part -name '*.js' -print0` garde le prédicat
attendu, vide le lot, et rend 0 sur un script cassé. Elle a aussi corrigé un ban trop
large — `if [ -n "$X" ]; then echo x; fi` sur une seule ligne était refusé, alors qu'un ban
qui refuse le légitime est un ban qu'on finit par retirer en entier.

Une limite reste ouverte et documentée : `if [ ! -f "$suite" ] && false; then` laisse tous
les motifs en place et rend 0. Aucun lecteur statique ne peut la fermer.

Les quatrième et cinquième passes ont fermé le même trou aux deux endroits suivants : le
prédicat du `find` et le côté `xargs` du tube. Trois réouvertures, toutes **par ajout** et
jamais par substitution — `-name '*.mjs'`, puis `-path nulle-part` devant le prédicat, puis
`node --check --help`, qui fait sortir node en 0 avant tout contrôle. La cinquième passe a
aussi accroché la permission accordée à `set -x` à sa prémisse : un ban de `secrets.` en
contenu, sans quoi un futur `env: TOKEN: ${{ secrets.X }}` la rendrait fausse en silence.

Bilan de méthode, qui vaut plus que le fichier livré : **cinq** passes, **quatre** revues,
et chacune a trouvé un défaut que les précédentes n'avaient pas vu — dont quatre bloquants.
Toutes de la même famille : le contrôle a l'air d'être là, et il ne contrôle plus rien.
Deux enseignements à garder pour les lots suivants :

- **contrôler par égalité, pas par présence.** Un motif attendu peut être présent et
  neutralisé par un voisin ajouté. C'est la forme qu'a prise la réouverture, trois fois ;
- **un ban trop large finit retiré en entier.** Le ban du `;` refusait
  `if [ -n "$X" ]; then echo x; fi` sur une seule ligne, une édition parfaitement
  ordinaire. Un contrôle qui gêne le travail légitime ne survit pas.

## Job 2 — La bibliothèque

`node test/chemins.test.js`, ajouté en écrivant le lot 3b. Il exerce `estCheminInterdit`
et `normaliser` directement, sans dépôt jetable ni sous-processus.

Pourquoi un test à part alors que `boucle.test.js` exerce déjà des chemins interdits :
celui-ci n'en traverse que cinq (`.github/workflows/**`, `.aider.conf.yml`, `.env`,
`package.json`, `Makefile`). Retirer `Jenkinsfile`, `renovate.json` ou
`.github/actions/**` de la liste ne faisait rougir aucun cas — relevé en mesurant les
mutations, pas en lisant le code.

## Job 3 — La garde

`node test/garde.test.js`, livré par le lot 2 avec ses dix fixtures.

Le harnais contient aussi des cas qui **n'ajoutent pas de fixture** : ils réutilisent un
payload existant avec un scénario du stub `gh`. C'est nécessaire, pas décoratif — les
garde-fous fail-closed de l'étage 2 dépendent de la *réponse* de l'API, pas du payload,
et on peut donc les retirer sans faire rougir un seul cas piloté par fixture. Vérifié en
relecture du lot 2.

| Fixture | `poursuivre` |
| --- | --- |
| `issue-avec-dseek.json` | `true` |
| `commentaire-avec-dseek.json` | `true` |
| `issue-auteur-non-de-confiance.json` | `true` (mode consigne restreinte) |
| `issue-sans-dseek.json` | `false` |
| `commentaire-sur-pr.json` | `false` |
| `commentaire-non-autorise.json` | `false` |
| `commentaire-reedite.json` | `false` |
| `evenement-push.json` | `false` |
| `issue-mention-cachee.json` | `false` |
| `commentaire-reedite-mention-cachee.json` | `false` |

Contrôler **deux choses** par cas : la valeur de `poursuivre`, et que le code de sortie
vaut **0 partout**, y compris les refus. Un refus n'est pas une panne, et une action qui
échoue en rouge à chaque commentaire anodin serait inutilisable.

`GH_CLI=__fixtures__/gh-stub.sh` — le stub versionné, qui écrit `[]`. Pas `/bin/true` :
stdout serait vide et `JSON.parse('')` lèverait.

## Le smoke test doit faire mourir `resolve.js`, pas seulement passer la garde

Relevé en relisant le lot 4. R12 — le step `if: always()` qui publie le compte rendu de
secours — repose entièrement sur `${{ job.status }}` tel qu'une composite action le voit,
et **rien dans le dépôt ne peut le mesurer** : les deux smoke jobs prévus s'arrêtent à la
garde, donc le step porteur du `if: always()` y est justement sauté.

Deux modes de panne, tous deux silencieux :

- si `job.status` valait toujours `success` dans ce contexte, `rendre-compte.js` sortirait
  en tête sur tous les runs et R12 serait vide, sans qu'aucun test rougisse ;
- si elle était vide, il publierait « statut inattendu (`(vide)`) » à chaque run — mesuré
  en lançant le script avec `STATUT_JOB` absente.

Il faut donc un smoke job qui **fait échouer `resolve.js`** — un `validation-command`
inexistant ne suffit pas, c'est un résultat et non une panne ; viser un jeton sans droits
ou un `MODELE` refusé — et qui contrôle qu'un commentaire de secours est publié, une fois
et une seule.

### Ce job n'est pas écrit : les deux modes de panne sont écartés à la source

Décidé en exécutant le lot 5. Ce que ce job devait lever, `actions/runner` le tranche,
et une lecture de son code vaut mieux qu'un job de trois minutes qui installe aider pour
mesurer une variable :

- **jamais vide** : `StepsRunner.cs:53` pose
  `jobContext.JobContext.Status = (jobContext.Result ?? TaskResult.Succeeded)` **avant**
  le premier step, et `:155`, `:196`, `:278` la remettent à jour après chaque step ;
- **jamais bloquée sur `success` dans une composite** : `ExecutionContext.cs:136-138`
  recopie chaque paire de `ExpressionValues` dans le contexte enfant, et
  `CompositeActionHandler.cs` ne remplace que `inputs`, `steps`, `github` et `env`
  (`:144-158`, `:257-263`). La clé `job` n'est pas remplacée, donc un step embarqué lit
  **le `JobContext` du job**.

Le détail est dans « Ce que vaut `${{ job.status }}` dans une composite action » du
contrat, avec ce qui reste non prouvé : que le runner exécute bien un step `if: always()`
d'une composite dans un job déjà rouge. C'est un comportement du runner, pas notre code.

Ce que ce job aurait coûté, pour mémoire : faire passer la garde en CI demande de
surcharger `GITHUB_EVENT_NAME` et `GITHUB_EVENT_PATH` par l'`env:` du job — faisable,
`CompositeActionHandler.cs:259-263` fusionne bien l'environnement global dans chaque step
embarqué — puis de laisser la composite installer Python et les 107 paquets d'aider, puis
de faire remonter le verdict d'un job **volontairement rouge** vers un second job par
`needs`, `continue-on-error` et des sorties de job. Beaucoup de machinerie fragile pour
une variable que le runner documente dans son code.

**Constaté depuis, et c'est la seconde des deux réfutations ci-dessus qui est fausse.**
« Jamais vide » tient. « Jamais bloquée sur `success` dans une composite » ne tient pas :
mesuré sur le run `32380365244`, `job.status` valait `success` dans le step suivant
immédiatement un step de la **même** composite terminé en `conclusion=failure`. C'est
donc exactement le premier des deux modes de panne annoncés plus haut qui s'est produit
— `rendre-compte.js` sortait en tête, R12 était vide, aucun test ne rougissait.

Le renoncement à ce job de smoke en a été la cause immédiate : rien dans le dépôt ne
pouvait l'attraper avant un run réel, et c'est bien ce qui est arrivé. Mesure et
procès-verbal complets dans `plan/contrat.md`, section « Ce que vaut `${{ job.status }}`
dans une composite action ». Leçon, écrite là-bas et dans `CLAUDE.md` : une lecture du
code du runner ne remplace pas une mesure sur le runner.

## Job 4 — La boucle, hors ligne

**Nouveau.** C'est ce que le stub `AIDER_CLI` du lot 1 débloque.

`node test/boucle.test.js`, avec `AIDER_CLI=__fixtures__/aider-stub.sh` et
`GH_CLI=__fixtures__/gh-stub.sh`, sur un dépôt git jetable créé par le test. Couvre les
cinq scénarios du lot 3c et les quatre du lot 3b, dont :

- **R7** : une `validation-command` qui affiche `process.env.GH_TOKEN` doit afficher
  `undefined`. Le test de sécurité le plus important du dépôt.
- **R3** : le stub écrit `.github/workflows/ci.yml` → le chemin est refusé et
  n'apparaît pas dans `git log --name-only`.
- **R8** : le stub écrit `.aider.conf.yml` → refusé.
- **R8, chemin des fichiers ignorés** : un dépôt jetable dont le `.gitignore` porte
  `.aider*` et `.env`, dans lequel le stub dépose `.aider.conf.yml` et un `.env` :
  les deux sont invisibles à `git status`, et `appelerAider` doit tout de même avoir
  supprimé le premier et déplacé le second avant l'appel suivant. Sans ce cas, la
  neutralisation peut disparaître sans qu'aucun test ne rougisse.
- **Repli des répertoires non suivis** : le test doit tourner avec
  `GIT_CONFIG_GLOBAL=/dev/null` et `GIT_CONFIG_SYSTEM=/dev/null`. Le stub écrit
  `sous/dossier/package.json` dans un répertoire non suivi ; sans le `-uall`
  d'`etatFichiers()`, git rend une seule entrée `?? sous/` que la liste interdite ne
  refuse pas, et le chemin interdit est commité. Le harnais qui hérite de la
  configuration globale du poste — `status.showUntrackedFiles=all` est courant — ne
  voit pas le défaut.
- **R6** : une fixture avec un `<!-- … -->` → le bloc est absent du prompt construit.
- **R4** : le stub n'écrit rien → aucune PR, code de sortie 0.
- Le compte d'itérations, avec `MAX_ITERATIONS=2`.

Ce job est ce qui rend les lots 3b et 3c **signables par leur exécutant**. Dans la
version précédente, ils ne l'étaient pas : leur seule vérification exigeait une vraie
clé API et un dépôt distant.

## Job 5 — Smoke du composite, en local

```yaml
smoke-local:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v5
    - id: action
      uses: ./
      with:
        deepseek-api-key: factice
        github-token: ${{ secrets.GITHUB_TOKEN }}
        no-publish: 'true'
    - run: |
        test "${{ steps.action.outputs.poursuivre }}" = "false"
```

Ce job monte réellement l'action : il valide la syntaxe de `runs:`, la présence des
`shell:`, la résolution des `uses:` internes et la remontée des `outputs:`.

Il **s'arrête à la garde** : l'événement est `pull_request` ou `push`, donc la liste
blanche d'événements du lot 2 refuse, `poursuivre=false`, code 0. aider n'est jamais
installé, la clé factice n'est jamais utilisée, le job passe en quelques secondes.

L'assertion sur `outputs.poursuivre` compte : sans elle, ce job ne fait que « ne pas
planter ». C'est pour cela que le lot 4 expose des `outputs:`.

Trois écarts avec le fichier livré, tous mineurs mais assumés :

- l'assertion porte aussi sur `succes` et `numero-pr`, qui doivent être **vides** : la
  sortie d'un step sauté vaut la chaîne vide, et c'est ce qui prouve que le bloc
  `outputs:` se résout quand même quand `resoudre` n'a pas tourné ;
- les valeurs passent par un `env:` de step et sont comparées en `"$VARIABLE"`, pas
  interpolées dans le corps du `run:`. Elles viennent de notre garde, donc le risque est
  nul ici, mais l'interpolation d'une valeur dans un script shell est le motif que ce
  dépôt refuse partout ailleurs (R6, R7) — et l'écrire une fois « parce que c'est sûr »
  est la façon dont ce motif revient. Mesuré : `actionlint` **ne protège pas** cette
  discipline. Sur `${{ github.event.issue.title }}` dans un `run:`, il rend
  `is potentially untrusted. avoid using it directly in inline scripts` ; sur
  `${{ steps.<id>.outputs.<nom> }}` au même endroit, il ne dit rien. Seul
  `test/ci.test.js` la tient ;
- `github-token` n'est pas passé : son défaut est `${{ github.token }}`, une ligne de
  moins à garder juste.

**Ce que ce job ne valide pas**, contrairement à ce qu'affirmait la version précédente :

- **pas le câblage des `env:`** — les steps qui les portent sont sautés par le `if:`.
  C'est le contrôle programmatique du job 1 qui s'en charge.
- **pas la résolution de `$GITHUB_ACTION_PATH`** — en `uses: ./`, cette variable vaut
  `GITHUB_WORKSPACE` (`ActionManager.cs:697-704`). Un `node scripts/garde.js` en chemin
  **relatif** passerait ce job et casserait chez tout consommateur en
  `uses: owner/repo@v1`. D'où le job 6.

## Job 6 — Smoke du composite, par référence distante

```yaml
smoke-distant:
  if: github.event_name == 'push'
  runs-on: ubuntu-24.04
  steps:
    - uses: citopia-jvs/deepseek-resolve-github-action@${{ github.sha }}
      with:
        deepseek-api-key: factice
        no-publish: 'true'
```

Le seul job qui exerce `GITHUB_ACTION_PATH` avec sa vraie valeur,
`_actions/<owner>/<repo>/<ref>`. Sans lui, l'écart entre local et distant reste invisible
jusqu'au premier consommateur.

Restreint à `push` : une référence par SHA n'est résolvable qu'une fois le commit sur le
dépôt. Sur une PR de branche du même dépôt, `github.sha` fonctionne aussi ; sur une PR de
fork, non. Assumer, et le noter dans le fichier.

### Ce job est invalide comme écrit, et remplacé par `smoke-sous-repertoire`

Deux mesures.

**Une expression n'est pas permise dans un `uses:`.** `actionlint` sur ce bloc rend
`context "github" is not allowed here. no context is available here`. Autrement dit, le
job 6 aurait fait rougir notre propre job `syntaxe` — le plan se contredisait d'une
section à l'autre.

**Un sous-répertoire suffit à obtenir un `GITHUB_ACTION_PATH` différent du workspace.**
`ActionManager.cs:699-705` : pour une référence locale, `actionDirectory` part de
`GITHUB_WORKSPACE`, puis y **joint le chemin de la référence** s'il y en a un ;
`CompositeActionHandler.cs:161` recopie ce répertoire dans `github.action_path` de chaque
step embarqué. Donc `uses: ./copie-action` donne `GITHUB_WORKSPACE/copie-action`, où un
`node scripts/garde.js` relatif ne résout plus.

Le job retenu checkoute donc le dépôt dans `copie-action/` — **et rien à la racine du
workspace**, ce qui interdit à un chemin relatif de tomber juste par accident — puis monte
`uses: ./copie-action`. Il ne demande aucun commit poussé, tourne sur une PR de fork, et
fait rougir la même régression.

Ce qu'il ne reproduit pas : le préfixe `_actions/<owner>/<repo>/<ref>`. Ce qui est en jeu
n'est pas le préfixe mais l'inégalité `GITHUB_ACTION_PATH ≠ GITHUB_WORKSPACE`, et elle est
bien exercée.

## Ce qui n'est pas testable ici

La boucle avec un vrai modèle : elle demande une clé API et un vrai dépôt à modifier.
Elle relève de la vérification de bout en bout du plan maître.

**Ne pas mettre de clé DeepSeek dans les secrets de ce dépôt** : un workflow déclenché
depuis une PR de fork y aurait accès dans certaines configurations.

## Vérification

Les **quatre** jobs passent sur une PR — `syntaxe`, `suites`, `smoke-local`,
`smoke-sous-repertoire`. Ce bloc annonçait « cinq jobs » alors que le lot en décrit six ;
il en reste quatre après les deux corrections ci-dessus.

Vérifier aussi qu'ils **échouent** quand on les casse volontairement. Les renvois de job
étaient faux, et de la façon la plus gênante : ils désignaient le job qui ne voit rien.

| Mutation | Job qui rougit |
| --- | --- |
| une faute de syntaxe dans un script | `syntaxe` (`node --check`) |
| un nom d'input mal orthographié dans `action.yml` | `suites`, via `test/action.test.js` — plus le contrôle Python, retiré au lot 4 |
| retirer un `shell:` d'un step de `action.yml` | `suites` (`test/action.test.js`) **et** `smoke-local`, qui ne monte plus l'action |
| retirer le filtrage d'environnement de `executerValidation` | `suites`, cas R7 de `test/boucle.test.js` — et non « job 3 », qui était la garde |
| remplacer `$GITHUB_ACTION_PATH/scripts/garde.js` par `scripts/garde.js` | `suites` (mesuré : `test/action.test.js` rougit) **et** `smoke-sous-repertoire`, mais **pas `smoke-local`**, puisque `GITHUB_ACTION_PATH` y vaut le workspace : c'est toute la raison d'être du second job. Le bloc d'origine intervertissait les deux. Les deux contrôles ne prouvent pas la même chose — le statique dit « le texte est bon », le smoke dit « le runner résout » |

Les colonnes « `syntaxe` » et « `suites` » de ce tableau ont été **jouées à la main**
avant le commit, chaque mutation dans une copie du dépôt hors de l'arbre de travail :
script cassé → `xargs` rend 1 ; `env: process.env` à la place d'`environnementValidation()`
→ `boucle` 57/1 sur le seul cas R7 ; `inputs.map-token` pour `inputs.map-tokens` →
`action` 11/2 ; chemin relatif ou `shell:` retiré → `action` rougit. Les deux colonnes de
smoke ne sont pas jouables hors runner : elles restent à confirmer au premier run réel,
et c'est la seule partie de ce tableau qui ne soit pas mesurée.

Un test qui ne peut pas échouer ne teste rien — y compris le
`find … -exec node --check {} \;` que ce lot proposait, qui en était un.
