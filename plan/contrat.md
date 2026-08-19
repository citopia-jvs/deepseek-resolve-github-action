# Contrat d'interface

**À lire en premier, avant tout lot.** Ce fichier est la seule source de vérité pour
les noms : sorties, variables d'environnement, inputs, signatures. Aucun lot ne
redéfinit un nom ; s'il faut en ajouter un, il s'ajoute **ici** d'abord.

Raison d'être : dans la version précédente de ce plan, ces noms n'existaient que
dans le lot 4, alors que les lots 2, 3a, 3b et 3c les consomment. Un agent écrivant
le lot 3b sans avoir lu le lot 4 inventait ses propres noms, et le lot 4 devait tout
renommer.

## Versions épinglées

Ces valeurs ne sont pas des points ouverts. Elles sont relevées et vérifiées.

| Quoi | Valeur | Pourquoi cette valeur |
| --- | --- | --- |
| `aider-chat` | `0.86.2` | dernière version sur PyPI (2026-02-12). 174 releases, rien depuis. |
| Python | `3.12` | `aider-chat` déclare `requires_python = "<3.13,>=3.10"`. |
| Modèle par défaut | `deepseek/deepseek-v4-pro` | seuls `deepseek-v4-pro` et `deepseek-v4-flash` existent côté API. |
| `actions/checkout` | `v5` | `v4` déclare `using: node20`, retiré des runners le 2026-09-16. Mesuré : `v5` déclare `using: node24`. |
| `actions/setup-python` | `v6` | même motif, et le lot 4 disait `v5`. Mesuré sur les `action.yml` publiés : `setup-python@v5` déclare `using: 'node20'`, `setup-python@v6` déclare `using: 'node24'`. Épingler `v5` reviendrait à livrer une action qui meurt le 2026-09-16 — la date même qui justifie `checkout@v5`. |
| Runner | `ubuntu-24.04` **en dur** | `ubuntu-latest` basculera sur 26.04, dont le Python 3.14.4 est hors borne. |

## Sorties de `scripts/garde.js` (dans `GITHUB_OUTPUT`)

| Sortie | Type | Valeur |
| --- | --- | --- |
| `poursuivre` | `'true'` \| `'false'` | écrite sur **tous** les chemins, y compris les refus |
| `issue` | entier décimal | numéro d'issue, validé `Number.isInteger` |
| `branche` | `fix-issue-<n>` | validée contre `/^fix-issue-\d+$/`. **Fait foi** : `resolve.js` ne la reconstruit pas |
| `motif` | chaîne courte | motif du refus. **Sans consommateur, et c'est voulu** : le step de compte rendu est conditionné à `poursuivre == 'true'`, donc un refus ne produit aucun commentaire — un bot qui répond sur chaque mention non autorisée est un bot qu'on finit par couper. Le motif sert le journal du job, où `garde.js` l'écrit déjà. Ne pas le câbler dans `action.yml` sans changer cette décision |
| `consigne-restreinte` | `'true'` \| `'false'` | écrite sur **tous** les chemins, refus compris — `'false'` par défaut, pour que le bloc de sorties soit de forme constante : un consommateur qui lit une sortie absente reçoit `''`, et `'' !== 'false'`. `'true'` = étage 2 bis du lot 2 a jugé l'auteur de l'issue non autorisé : le lot 3b ne prend que le commentaire comme consigne et fournit le corps de l'issue en données non fiables. Sans cette sortie, l'atténuation de R6 promise au lot 2 n'atteint jamais le lot 3b |

## Variables d'environnement lues par les scripts

Une composite action **n'expose pas** ses inputs en `INPUT_*` aux sous-processus.
Chaque valeur doit figurer dans le `env:` de son step. C'est l'oubli le plus
probable de tout le plan.

### `garde.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `GITHUB_OUTPUT` | runner |
| `GH_TOKEN` | input `github-token` |
| `ASSOCIATIONS_AUTORISEES` | input `allowed-associations` |
| `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` | input `require-trusted-issue-author` |
| `GH_CLI` | tests seulement — binaire `gh` injectable |

### `resolve.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_ACTION_PATH`, `GITHUB_OUTPUT` | runner — `GITHUB_OUTPUT` est écrite par le lot 3c |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` | runner — portée du marqueur de compte rendu. Absentes hors Actions : le marqueur est alors écrit sans portée |
| `DEEPSEEK_API_KEY` | input `deepseek-api-key` |
| `GH_TOKEN` | input `github-token` |
| `NUMERO_ISSUE` | sortie `issue` de la garde |
| `BRANCHE` | sortie `branche` de la garde |
| `MODELE` | input `model` |
| `MAX_ITERATIONS` | input `max-iterations` |
| `COMMANDE_VALIDATION` | input `validation-command` |
| `BRANCHE_BASE` | input `base-branch` |
| `MAP_TOKENS` | input `map-tokens` |
| `SANS_PUBLICATION` | input `no-publish` |
| `MINUTES_MAX_APPEL_AIDER` | input `aider-call-timeout-minutes` |
| `CONSIGNE_RESTREINTE` | sortie `consigne-restreinte` de la garde |
| `GH_CLI`, `AIDER_CLI` | tests seulement — binaires injectables |
| `AIDER_STUB_*` | tests seulement — pilotage du stub aider, héritées **uniquement si `AIDER_CLI` est posée** (voir ci-dessous) |

### `rendre-compte.js`

| Variable | Source |
| --- | --- |
| `GITHUB_REPOSITORY` | runner |
| `GH_TOKEN` | input `github-token` |
| `NUMERO_ISSUE` | sortie `issue` de la garde |
| `BRANCHE` | sortie `branche` de la garde |
| `STATUT_JOB` | `${{ job.status }}` |
| `SANS_PUBLICATION` | input `no-publish` |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` | runner — portée du marqueur, même règle que `resolve.js` |
| `GH_CLI` | tests seulement — binaire `gh` injectable |

`GH_CLI` est ajoutée au lot 4. Sans elle, `test/compte-rendu.test.js` ne peut pas
exercer ce script hors ligne, et l'idempotence — sa seule raison d'être — n'est alors
prouvée par rien. `garde.js` et `resolve.js` ont déjà cette trappe, pour ce motif.

Pas de `NUMERO_PR` : le script résout la PR par `BRANCHE`, comme `publierTour`. Une
sortie de plus à câbler serait une sortie de plus à oublier, et surtout le step
`if: always()` doit tourner **même quand `resolve.js` est mort avant d'écrire ses
sorties** — c'est exactement le cas que ce step existe pour couvrir.

**Code de sortie : 0 sur tous les chemins**, échec de publication compris. Ce script
est le dernier step du job, sous `if: always()` : rougir ici ferait passer au rouge un
job dont la validation est passée, et masquerait le verdict déjà rendu par le code de
sortie de `resolve.js`. Un échec de publication s'annonce par `::error::`, comme dans
la garde.

## Inputs de `action.yml`

| Input | Requis | Défaut | Exposé sous |
| --- | --- | --- | --- |
| `deepseek-api-key` | oui | — | `DEEPSEEK_API_KEY` |
| `github-token` | non | `${{ github.token }}` | `GH_TOKEN` |
| `max-iterations` | non | `"2"` | `MAX_ITERATIONS` |
| `validation-command` | non | `"npm test"` | `COMMANDE_VALIDATION` |
| `base-branch` | non | `""` | `BRANCHE_BASE` |
| `model` | non | `"deepseek/deepseek-v4-pro"` | `MODELE` |
| `aider-version` | non | `"0.86.2"` | interpolé dans l'install |
| `python-version` | non | `"3.12"` | `actions/setup-python` |
| `map-tokens` | non | `"2048"` | `MAP_TOKENS` |
| `allowed-associations` | non | `"OWNER,MEMBER,COLLABORATOR"` | `ASSOCIATIONS_AUTORISEES` |
| `require-trusted-issue-author` | non | `"true"` | `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` |
| `no-publish` | non | `"false"` | `SANS_PUBLICATION` |
| `aider-call-timeout-minutes` | non | `"15"` | `MINUTES_MAX_APPEL_AIDER` |

`github-token` n'est **pas** `required: true` : `required` avec un `default` est
contradictoire, et GitHub n'applique de toute façon pas `required` sur les inputs
d'action.

Tous les inputs sont des **chaînes**. Côté script, ne comparer qu'à `'true'`,
jamais à `'false'`.

## Outputs de `action.yml`

`poursuivre`, `numero-pr`, `branche`, `iterations`, `succes`. Sans eux, un
consommateur ne peut rien enchaîner et le smoke test du lot 5 n'a rien à contrôler.

## Sorties écrites par `resolve.js` (lot 3c)

Dans `GITHUB_OUTPUT`, sur **tous** les chemins de sortie, y compris les refus — même
règle que la garde, et pour la même raison : un consommateur qui lit une sortie absente
reçoit `''`.

| Sortie | Type | Valeur |
| --- | --- | --- |
| `numero-pr` | entier décimal ou `''` | vide quand aucune PR n'a été ouverte : chemin R4, échec technique avant push, ou `no-publish` |
| `iterations` | entier décimal | nombre de tours de validation **effectués**. `0` si la boucle n'a jamais tourné |
| `succes` | `'true'` | `'false'` | `'true'` uniquement si la commande de validation est passée |

### Code de sortie du processus

Trois issues, deux codes. C'est la distinction que le lot 2 a déjà tranchée pour la
garde : un **résultat** n'est pas une **panne**.

| Issue | Code | Pourquoi |
| --- | --- | --- |
| Validation passée | 0 | succès |
| `max-iterations` atteint, validation toujours rouge | **0** | l'action a fait son travail et rend son verdict : `succes=false`, un `::error::` dans le résumé du job, un compte rendu sur la PR. Rougir ici mettrait une croix rouge sur le dépôt à chaque issue difficile, et apprendrait à l'équipe à ignorer la croix |
| aider rend un code non nul, ou une opération d'infrastructure échoue (push, `gh`) | **non nul** | là, quelque chose est cassé : clé refusée, crédit épuisé, jeton sans droits. Le job doit rougir |
| Chemin R4 — aider n'a rien commité | 0 | explicitement écrit dans le lot 3c : « ce n'est pas une panne de l'action, c'est un résultat » |

### Le compte rendu final porte un marqueur

`publierCompteRendu` termine son corps par une ligne
`<!-- deepseek-resolve:compte-rendu run=<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT> -->`.

Quand l'une des deux variables de run est absente — exécution locale, harnais de test —
le marqueur est écrit **sans** le suffixe ` run=…`, et reconnu sous cette forme nue.

### Pourquoi le marqueur porte la portée du run

Ajouté au lot 4, après mesure. Le marqueur nu ne suffit pas, et le trou est
exactement celui que le step `if: always()` existe pour couvrir.

R9 prévoit qu'un même couple issue / branche serve à **plusieurs runs** : un second
`@dseek` sur la même issue reprend `fix-issue-<n>` et la même PR. Le compte rendu du
run précédent y est donc déjà, marqueur compris. Mesuré : avec un commentaire portant
le marqueur nu sur la PR et `STATUT_JOB=failure`, `rendre-compte.js` répond
« Un compte rendu est déjà présent sur la pull request #7 : rien à republier » et sort
en 0. L'utilisateur du run 2 ne reçoit **rien**, alors que le job vient de mourir.

`GITHUB_RUN_ID` et `GITHUB_RUN_ATTEMPT` sont fournies d'office par le runner à tous
les steps : la portée ne coûte aucune ligne d'`env:` dans `action.yml`, donc aucune
ligne de plus à oublier.

Conséquence voulue sur la relance d'un job (`Re-run failed jobs`) :
`GITHUB_RUN_ATTEMPT` s'incrémente, la portée change, et le compte rendu de la nouvelle
tentative est publié — c'est un nouveau verdict, pas un doublon. Deux exécutions du
même step dans **la même** tentative gardent la même portée, et restent donc
idempotentes.

Les deux fichiers écrivent cette forme, et rien ne garantit qu'ils restent d'accord :
deux formes divergentes font publier un second compte rendu à chaque job rouge, sans
qu'aucun test ne rougisse. `scripts/resolve.js` exporte donc `marqueurCompteRendu()`
— sans argument, elle lit l'environnement — pour que `test/compte-rendu.test.js`
compare les deux, caractère par caractère, sous plusieurs environnements. Côté
`rendre-compte.js`, la portée est passée en **argument** (`marqueurCompteRendu(portee)`,
`porteeDuRun()`), parce que le corps publié et la reconnaissance doivent parler de la
même portée sans relire l'environnement deux fois.

Règle de reconnaissance, côté `rendre-compte.js` : portée connue → seul le marqueur de
**cette** portée compte comme « déjà publié ». Portée inconnue → repli sur le marqueur
nu, et n'importe quel compte rendu compte. Le seul environnement sans portée est local
ou de test.

Raison d'être : `rendre-compte.js` (lot 4) doit être **idempotent** — il publie le
compte rendu quand le job meurt avant `publierCompteRendu`, et ne doit rien republier
sinon. Reconnaître un compte rendu à son emoji serait fragile ; ce marqueur est stable,
invisible dans le rendu GitHub, et c'est **nous** qui l'écrivons, pas un tiers.

Ce que `rendre-compte.js` en fait, tranché au lot 4 : il cherche le marqueur dans les
commentaires de la **PR de `BRANCHE` si elle existe, et dans ceux de l'issue sinon** —
`publierCompteRendu` publie sur l'un ou sur l'autre selon `bilan.numeroPr`, donc
chercher d'un seul côté republierait sur le chemin R4, où le compte rendu part sur
l'issue.

Le compte rendu de secours porte **lui aussi** le marqueur : deux exécutions du step
`if: always()` — reprise de job, relance manuelle — ne doivent pas laisser deux
commentaires.

## Signatures exportées par `scripts/lib/`

```js
// Tous les appels git passent `GIT_LITERAL_PATHSPECS=1`. Mesuré : les chemins viennent
// du modèle, et git les lit comme des pathspecs — un fichier réellement nommé « * »
// faisait que `git add -- '*'` stageait tout l'arbre sale, `.env` refusé compris.
// gh.js
gh(args, { json = false, tolererEchec = false })   // --repo ajouté par l'appelant
// git.js
git(args, { tolererEchec = false })                // stdout trimmé
aDesCommits(base)                                  // booléen
etatFichiers()                                     // [{ statut, chemin }] — pas juste des chemins
                                                   // `--porcelain -z -uall` : sans `-uall`, git
                                                   // replie un répertoire non suivi en UNE entrée
                                                   // « ?? sous/ » et `git add -- sous/` emporte
                                                   // tout son contenu, interdits compris
                                                   // renommage ou copie : la destination garde le
                                                   // statut brut de git ('R ', 'RM', 'C '),
                                                   // l’origine porte la sentinelle 'R<'
brancheDistanteExiste(nom)                         // booléen
// chemins.js
estCheminInterdit(chemin)                          // booléen — liste du lot 3b
                                                   // refuse aussi tout `.aider*` (nom ET premier
                                                   // segment) et toute entrée finissant par « / » :
                                                   // un dépôt git imbriqué reste replié même avec
                                                   // `-uall`, et `git add` en ferait un gitlink cassé
                                                   // impure : fait des lstat, donc à appeler
                                                   // depuis GITHUB_WORKSPACE
normaliser(chemin)                                 // refuse '..', absolus, liens
// texte.js
nettoyerTexteTiers(s)                              // retire commentaires HTML, contrôles, bidi
masquerSecrets(s)                                  // motifs de jetons -> [SECRET RETIRÉ]
tronquer(s, n)                                     // tête + queue — jamais la tête seule, même si n
                                                   // est trop petit pour un marqueur
```

## Objet `preparation` rendu par `preparer()` (lot 3a)

Les lots 3b et 3c le consomment sans le reconstruire. Il est gelé (`Object.freeze`).

| Champ | Contenu |
| --- | --- |
| `nomBrancheBase` | nom de la base, tel qu'il part en `gh pr create --base` |
| `referenceBase` | référence résolvable par git (`main` ou `origin/main`) |
| `shaBase` | SHA de la base. Sert au diff de la PR |
| `shaDepart` | SHA de `HEAD` **après** établissement de la branche de travail |
| `branche` | nom de la branche de travail — vient de la sortie `branche` de la garde |
| `reprise` | `'locale'` \| `'distante'` \| `false` |
| `prefixeAuthentification` | arguments à placer avant `push`. **Jamais journalisé** |

### Pourquoi `shaDepart` en plus de `shaBase`

R9 et R4 se marchent dessus, et le lot 3a l'a montré à l'exécution. Quand la branche
distante est reprise, elle porte déjà les commits du run précédent : compter
`shaBase..HEAD` rend un résultat non nul **avant** le premier appel à aider, donc le
contrôle R4 du lot 3c — « aider n'a rien commité, on ne publie pas » — ne détecte plus
rien.

Deux points de référence, deux questions différentes :

- `shaBase` répond à « qu'est-ce que cette PR ajoute à la base ? » — c'est le diff
  que verra le relecteur ;
- `shaDepart` répond à « **ce run** a-t-il produit quelque chose ? » — c'est le seul
  bon compteur pour R4.

Les deux coïncident quand la branche est créée. Ne pas les confondre.


## Signatures des primitives de `resolve.js` (lot 3b)

Le lot 3c les compose et n'en écrit aucune.

```js
construireConsigne(config, { logsEchec = '' } = {})  // -> string          R6
appelerAider(config, consigne)                       // -> { codeSortie, sortie }  masquée ET bornée
executerValidation(config)                           // -> { codeSortie, logs, premierEchec }
commiterTravail(message)                             // -> { commite: bool, refuses: string[] }
pousser(config, preparation, quoi)                   // -> void            push seul
publierInitial(config, preparation, prompt)          // -> { numeroPr }    pousser() + gh pr create
publierTour(config, i, resultat)                     // -> void            commentaire de PR
publierCompteRendu(config, bilan)                    // -> void
```

### Pourquoi `pousser` existe, ajouté en écrivant le lot 3c

Le contrat n'exposait que `publierInitial`, qui pousse **et** ouvre la PR — donc
irrappelable au tour 2. Le pseudo-code du lot 3c exige pourtant un push après chaque
commit de correction, et l'exécutant du lot 3c a dû écrire un pousseur interne : deux
copies de la même logique (push simple puis `--force-with-lease`, jamais `--force`,
plus le test de `sansPublication`), dont une seule serait corrigée le jour où elle
changera.

`pousser` est donc la huitième primitive du lot 3b, et `publierInitial` l'appelle au
lieu de pousser elle-même. `quoi` est un libellé court pour le journal du job
(« le premier commit », « la correction du tour 2 ») — sans lui, trois lignes de log
identiques ne se distinguent pas.

`config` et `preparation` sont passés en arguments plutôt que lus dans un état de
module : c'est ce qui permet à `test/boucle.test.js` d'exercer une primitive seule,
sans reconstruire tout l'environnement du runner.

### `construireConsigne` — pourquoi une fonction, et au lot 3b

Le lot 3c ne doit rédiger aucun texte destiné au modèle : toutes les règles de R6
(hiérarchie instruction / contexte, `nettoyerTexteTiers`, mode consigne restreinte,
lecture du titre et du corps **dans `GITHUB_EVENT_PATH`**) vivent ici. Le lot 3c
n'appelle que `construireConsigne(config)` au premier tour, puis
`construireConsigne(config, { logsEchec })` aux tours suivants avec les `logs`
rendus par `executerValidation`.

### La `sortie` d'`appelerAider` est bornée à la source

Relevé en écrivant le lot 3c : `appelerAider` masquait sa `sortie` mais ne la bornait
pas, alors que `publierCompteRendu` insère `bilan.motif` **dans une phrase**. Une
sortie d'aider de plusieurs mégaoctets partait donc dans un commentaire de PR.

La borne est posée dans `appelerAider` et non chez l'appelant : c'est elle qui sait que
cette chaîne est la sortie d'un sous-processus sans borne connue, et un deuxième
consommateur ne doit pas avoir à s'en souvenir. Le lot 3c en extrait par ailleurs un
motif mono-ligne court pour le compte rendu — les deux ne se contredisent pas, ils ne
servent pas le même endroit.

### `premierEchec`, troisième champ de `executerValidation`

Le contrat en portait deux. Le troisième est ajouté parce que le lot 3b interdit de
recopier une sortie de validation brute dans un commentaire de PR : le seul élément
publiable est le nom du premier test en échec. L'extraire ici plutôt qu'au lot 3c
évite que l'orchestrateur ait à lire `logs` — donc qu'il soit tenté de le publier.
Chaîne vide si rien n'est reconnu.

### Objet `resultat` de `publierTour`

| Champ | Contenu |
| --- | --- |
| `validationOk` | booléen — la commande de validation est passée |
| `codeSortieValidation` | entier, tel que rendu par le sous-processus |
| `premierEchec` | nom du premier test en échec, `''` si inconnu |
| `refuses` | chemins refusés à ce tour (`commiterTravail`) |
| `derniereIteration` | booléen — commande la phrase d'intention du tour suivant |

### Objet `bilan` de `publierCompteRendu`

| Champ | Contenu |
| --- | --- |
| `succes` | booléen |
| `iterations` | nombre de tours effectués |
| `maxIterations` | borne, pour la phrase d'échec |
| `motif` | cause de l'échec, chaîne vide si succès. Court et mono-ligne : il est inséré dans une phrase |
| `refuses` | cumul dédupliqué des chemins refusés sur tous les tours |
| `numeroPr` | numéro de PR, ou `null` si aucune PR n'a été ouverte |

Trois formulations d'échec, une par cas, chacune factuelle en une seule phrase :

| Cas | Phrase |
| --- | --- |
| `iterations === maxIterations` | la formulation **gelée** par le plan : « ❌ Échec après `<max>` itération(s). Cause : … » |
| `iterations === 0` | « ❌ Échec. Cause : … » — chemin R4 et échec technique : aucun tour n'a eu lieu, le compte n'apprend rien |
| entre les deux | « ❌ Échec après `<n>` itération(s) sur `<max>` autorisée(s). Cause : … » — arrêt avant la borne : un tour sans commit, un échec technique en cours de boucle |

Relevé en écrivant le lot 3c, où le compte rendu affichait « ❌ Échec après 2 itérations »
suivi de « Itérations effectuées : 0 ». La correction n'est pas d'ajouter la ligne du
compte réel sous la phrase gelée : deux nombres contradictoires dans le même commentaire
ne disent pas au lecteur lequel croire.

## Points tranchés au lot 3b

### R8 : ce que les flags ferment, et ce qu'ils ne ferment pas

**Relevé dans le wheel `aider-chat 0.86.2`, contre ce qu'affirmait le plan.** Les
trois flags ne « court-circuitent » pas la recherche dans le git root :

- `aider/main.py:463-477` construit `default_config_files` — répertoire courant,
  racine git, `$HOME` — **quelle que soit** la valeur de `--config`, et
  `configargparse` lit ces fichiers en plus du nôtre. Le nôtre gagne clé par clé,
  parce qu'il est le plus à droite avant la ligne de commande ; mais **toute clé
  absente de notre fichier retombe sur celui du dépôt**. Les options `store_true`
  (`lint`, `test`, `commit`) ne sont même pas neutralisables depuis un fichier, et
  `set-env` et `api-key` sont des options « append » : elles s'ajoutent, elles ne
  s'écrasent pas.
- `aider/main.py:361-387` et `:305-322` : `load_dotenv_files` charge
  `$HOME/.env`, **`<racine git>/.env`**, `./.env` puis la valeur de `--env-file`,
  liste renversée et chargée avec `override=True`. Un `.env` à la racine du
  checkout est donc chargé **après** `--env-file /dev/null` et gagne. Un
  `DEEPSEEK_API_BASE` déposé là exfiltre la clé et tous les prompts.

Conséquence : les flags sont nécessaires mais ne suffisent pas. `appelerAider`
neutralise donc, **avant chaque appel**, les cibles de découverte d'aider à la
racine du checkout — indépendamment de git, donc y compris quand le dépôt
consommateur les ignore :

| Fichier | Traitement | Pourquoi ce traitement |
| --- | --- | --- |
| `.aider.conf.yml`, `.aider.model.metadata.json` | supprimé s'il n'est **pas** suivi par git, avec un `::warning::` qui le nomme | aucun usage légitime pendant notre run, et un dépôt qui en trouve un a probablement subi une tentative d'injection : le relecteur doit le voir |
| `.env` | déplacé hors du dépôt avant l'appel, remis en place après (dans un `finally`) | une étape du workflow appelant peut légitimement en avoir créé un dont la commande de validation a besoin. Le supprimer casserait la validation |

Une version **suivie** de ces fichiers n'est pas touchée : c'est un choix versionné
du dépôt consommateur, et si le modèle la modifie, la modification apparaît dans
`git status` — les fichiers ignorés ne masquent que les fichiers **non suivis** —
donc `commiterTravail` la refuse et la restaure avant l'appel suivant.

### `etatFichiers()` passe `-uall`, et ce n'est pas décoratif

Corrigé dans `scripts/lib/git.js` en écrivant ce lot. Le défaut de git est
`-unormal`, qui replie un répertoire non suivi en **une** entrée : `?? sous/`.
`estCheminInterdit('sous/')` ne refuse rien, et `git add -- sous/` ajouterait tout
son contenu, `sous/package.json` compris. Mesuré : une configuration globale
`status.showUntrackedFiles=all` — courante sur un poste de dev — masque le
comportement du runner, qui a le défaut.

Ce qui reste écarté : l'option `--ignored`. Sur un dépôt consommateur qui ignore
`node_modules/`, elle rendrait des milliers d'entrées à filtrer à chaque tour, pour
un trou que la neutralisation ci-dessus ferme de façon ciblée.

À documenter au lot 6 : la liste de chemins interdits ne couvre pas les fichiers
ignorés par git ; un `.aider.conf.yml` ou un `.env` **suivi** par le dépôt
consommateur est lu par aider ; et l'action déplace un `.env` non suivi le temps de
l'appel à aider.
### Un `.env` non suivi est refusé mais pas supprimé

Exception unique à l'étape 5 de `commiterTravail` (« non suivi créé → supprimer le
fichier »). Appliquée à la lettre à `.env`, cette étape détruirait définitivement le
fichier que `appelerAider` vient de mettre à l'abri, et donc ce dont la commande de
validation du dépôt consommateur a peut-être besoin. Un `.env` ou `.env.*` non suivi
est donc **refusé, laissé en place, et signalé** par un `::warning::` — il n'est
jamais stagé, et aider ne le voit pas.

Aucune autre entrée ne mérite cette exception : un `package.json` déposé par le
modèle est, lui, **exécuté** par la validation du tour suivant. Il doit disparaître du
disque.

Conséquence assumée : un `.env` légitime réapparaît dans `refuses` à chaque tour, donc
dans chaque commentaire d'itération. Le bruit est préférable à l'invisibilité — si
c'est le modèle qui l'a déposé, le relecteur doit le voir. Le cumul de `bilan.refuses`
étant dédoublonné, le compte rendu final ne le cite qu'une fois.

### La trappe `AIDER_STUB_*`

L'environnement d'aider est une **liste blanche** (R7) : sans exception, elle
supprimerait aussi les variables qui pilotent `__fixtures__/aider-stub.sh`, et
`test/boucle.test.js` ne pourrait ni vérifier les flags, ni relire le prompt construit,
ni **compter les appels** — c'est-à-dire l'essentiel de la vérification des lots 3b et
3c.

Les variables `AIDER_STUB_*` sont donc héritées, mais **seulement quand `AIDER_CLI` est
posée** — variable que ce contrat réserve déjà aux tests. Sur un runner, `AIDER_CLI` est
absente et l'environnement reste exactement la liste blanche. Tout test du harnais doit
préfixer ses variables de pilotage `AIDER_STUB_`, et le harnais doit contrôler que la
trappe est bien **fermée** sans `AIDER_CLI`.

### `publierTour` adresse la PR par la branche

Le contrat ne lui passe pas `numeroPr` : le commentaire part donc sur
`gh pr comment <branche>`, que `gh` résout. `publierCompteRendu`, lui, reçoit
`bilan.numeroPr` : il va sur la PR si le numéro existe, sinon sur l'issue — le cas
« aucune PR ouverte » doit rester rapportable.

### Les payloads de `test/boucle.test.js` lui appartiennent

Les dix fixtures de la garde ne portent que les champs que `garde.js` lit : pas de
`issue.title`, pas de `issue.body` dans les fixtures de commentaire. Le lot 3b leur
ajoute des payloads séparés, préfixés `boucle-`, plutôt que de gonfler les
existantes — celles-ci documentent des cas d'autorisation, et y verser des champs que
la garde ne lit pas rendrait illisible ce que chacune démontre.

## Suites de test du dépôt

Noms figés **ici** parce que le lot 5 les liste dans `.github/workflows/test.yml` et
que rien d'autre ne les recense. Toutes tournent hors ligne, sans clé d'API ni réseau,
en `node test/<nom>` — pas de runner de test, pas de dépendance.

| Fichier | Ce qu'il couvre | Lot |
| --- | --- | --- |
| `test/chemins.test.js` | `scripts/lib/chemins.js` | 1 |
| `test/texte.test.js` | `scripts/lib/texte.js` | 1 |
| `test/garde.test.js` | `scripts/garde.js` | 2 |
| `test/boucle.test.js` | `scripts/resolve.js`, lots 3a à 3c | 3 |
| `test/compte-rendu.test.js` | `scripts/rendre-compte.js` | 4 |
| `test/action.test.js` | `action.yml` — cohérence statique | 4 |

### Pourquoi `test/action.test.js` est en Node et non en Python

Le lot 4 écrit son contrôle de cohérence `inputs:` ↔ `${{ inputs.* }}` en
`python3 - <<'PY' … import yaml`. Mesuré sur le poste de développement :
`python3 -c "import yaml"` rend `ModuleNotFoundError: No module named 'yaml'`. Un
contrôle qu'on ne peut pas lancer n'est pas un contrôle, et faire installer `pyyaml`
par la CI du lot 5 ferait dépendre la lecture de notre propre fichier d'un index de
paquets.

Il est donc réécrit en Node sans dépendance, dans la suite de test — donc lancé par la
CI avec les autres. Il n'analyse pas le YAML dans le cas général : il lit les clés d'un
bloc à indentation connue de **notre** fichier, et les compare à l'ensemble des
`inputs.<nom>` présents dans le texte. C'est assez pour attraper la faute de frappe qui
s'évalue en chaîne vide, qui est le seul défaut qu'aucun autre contrôle n'attrape.

## Fichiers de configuration livrés par l'action

Écrits par le lot 3b côté flags, par le lot 4 côté contenu. Chemins **à la racine du
dépôt de l'action**, donc atteints par `$GITHUB_ACTION_PATH` :

| Fichier | Rôle |
| --- | --- |
| `aider.conf.yml` | configuration maîtrisée d'aider, hors d'atteinte du modèle — R8 |
| `aider-models.json` | métadonnées des modèles DeepSeek V4, absents de `litellm` — R5 |

Ils ne portent **pas** le préfixe `.` : `.aider.conf.yml` à la racine de ce dépôt
serait à la fois le fichier livré et un chemin de la liste interdite.
