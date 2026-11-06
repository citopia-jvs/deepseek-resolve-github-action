# Contrat d'interface

**À lire en premier.** Ce fichier est la seule source de vérité pour les noms :
sorties, variables d'environnement, inputs, signatures. S'il faut en ajouter un, il
s'ajoute **ici** d'abord.

Depuis la refonte « Claude Code + Scaleway » (phase 2, voie A), l'action n'appelle
plus aider. Elle entoure `anthropics/claude-code-action`, en mode agent, de ses propres
steps : garde, préparation, proxy, deux passages au plus du modèle, vérification,
conclusion. Le pourquoi de ce découpage est mesuré dans `plan/essai-claude-code.md`.

## Versions épinglées

Ces valeurs ne sont pas des points ouverts. Elles sont relevées et vérifiées.

| Quoi | Valeur | Pourquoi cette valeur |
| --- | --- | --- |
| `anthropics/claude-code-action` | `6b6870e649b5ff408753befeaee5fc7989d4e6a9` (v1.0.258) | épinglée par SHA : c'est elle qui exécute le modèle, avec le jeton GitHub dans son environnement. Elle installe Claude Code `2.1.308`. Comportements mesurés à cette version dans `plan/essai-claude-code.md` ; monter la version oblige à les remesurer |
| Modèle par défaut | `glm-5.3` | retenu au lot B, fenêtre de 256 000 tokens (valeur donnée par l'utilisateur, `/models` de Scaleway ne la publie pas) |
| `actions/checkout` | `v5` | `v4` déclare `using: node20`, retiré des runners le 2026-09-16. Mesuré : `v5` déclare `using: node24`. |
| Runner | `ubuntu-24.04` **en dur** | l'action n'est vérifiée que sur cette image. `ubuntu-latest` changera d'image sans prévenir |
| `actionlint` | `1.7.12`, archive `actionlint_1.7.12_linux_amd64.tar.gz`, SHA-256 `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` | dernière version publiée (2026-03-30). Installé par téléchargement de l'archive **et contrôle du condensat**, pas par une action tierce : mesuré, `rhysd/actionlint` ne publie **pas** d'`action.yml` — `https://raw.githubusercontent.com/rhysd/actionlint/v1.7.12/action.yml` rend 404. |
| `shellcheck` | **non épinglé**, celui de l'image du runner | `actionlint` intègre `shellcheck` **quand il le trouve**, et saute l'intégration sinon, sans un mot. Le poste de développement n'a pas `shellcheck` : **un `actionlint` vert en local est plus faible qu'un `actionlint` vert en CI** |
| Node | **non épinglé**, celui de l'image du runner | l'action appelle `node` tel que l'image du runner le fournit, chez le consommateur comme chez nous. Le job de syntaxe journalise `node --version` |

## Nom du dépôt et référence publiée

| Quoi | Valeur | Source |
| --- | --- | --- |
| Dépôt | `citopia-jvs/deepseek-resolve-github-action` | relevé sur `git remote get-url origin`. L'alias `github-pro` est un `Host` SSH du poste, pas le nom du dépôt |
| Référence dans un exemple copiable | `@v2` | tag flottant, à poser sur le premier `v2.x.y` vert de la refonte. `@v1` désigne l'ancienne action aider + DeepSeek et ne bouge plus |

## Déroulé de `action.yml`

| Step (`id`) | Condition | Rôle |
| --- | --- | --- |
| `garde` | toujours | `scripts/garde.js` : événement, auteur autorisé, anti-rejeu |
| `preparer` | `poursuivre == 'true'` | `scripts/preparer.js` : branche, commit vide, PR brouillon, consigne, sauvegarde de `.git/config` |
| `proxy` | `preparer` réussi | lance `scripts/proxy.js` en tâche de fond pour le reste du job |
| `claude1` | `proxy` réussi | claude-code-action, mode agent, **sans Bash** |
| `verifier1` | `always()` et `claude1` non sauté | `scripts/verifier.js`, passage 1 |
| `claude2` | `always()` et `verifier1.succes == 'false'` | seconde et dernière chance, la consigne porte la sortie des tests |
| `verifier2` | `always()` et `claude2` non sauté | `scripts/verifier.js`, passage 2 |
| `conclure` | `always()` et `numero-pr` non vide | `scripts/conclure.js` : commit, push, PR prête et revue, ou PR laissée en brouillon |

Les conditions lisent `steps.<id>.outcome`, jamais `job.status` : voir « Ce que vaut
`${{ job.status }}` dans une composite action ». Mesuré sur le runner (run
`42223323921`) : `steps.<id>.outcome` d'un `uses:` est bien lisible au step suivant.

### Pourquoi Claude Code n'a pas Bash

claude-code-action place le jeton GitHub dans l'environnement de Claude Code
(`GITHUB_TOKEN`, `GH_TOKEN` : `src/entrypoints/run.ts:190`), et réécrit l'URL du remote
avec ce jeton (`src/github/operations/git-config.ts:132`). Lu dans le code, pas
contournable par réglage. Tout code que Claude Code exécuterait — un test qu'il vient
d'écrire, lancé par `npm test` — pourrait donc le lire. Les règles `deny` n'y peuvent
rien : elles filtrent les commandes de Claude Code, pas ce que fait le code lancé.

D'où : `--allowedTools "Read,Edit,Write,Glob,Grep"`, `--disallowedTools
"Bash,WebFetch,WebSearch"`, et `deny` sur `./.git/**`. Les tests sont lancés par
`verifier.js`, qui ne reçoit pas le jeton, filtre l'environnement des tests et restaure
`.git/config` avant et après. Mesuré (run `42225255931`) : un test écrit par le modèle
ne voit ni `GH_TOKEN`, ni `GITHUB_TOKEN`, ni `INPUT_GITHUB_TOKEN`, ni jeton dans
`.git/config`.

**Risque résiduel, non fermé :** les tests exécutent du code du modèle sous le même
utilisateur que les steps suivants. Un processus laissé en tâche de fond par un test
pourrait lire `/proc/<pid>/environ` du step `conclure`, qui porte le jeton, ou réécrire
un script de l'action avant qu'il ne tourne. L'ancienne action avait le même risque.
Le fermer demanderait de lancer les tests dans un conteneur ou dans un job sans jeton.

## Sorties de `scripts/garde.js` (dans `GITHUB_OUTPUT`)

| Sortie | Type | Valeur |
| --- | --- | --- |
| `poursuivre` | `'true'` \| `'false'` | écrite sur **tous** les chemins, y compris les refus |
| `issue` | entier décimal | numéro d'issue, validé `Number.isInteger` |
| `branche` | `fix-issue-<n>` | validée contre `/^fix-issue-\d+$/`. **Fait foi** : `preparer.js` ne la reconstruit pas |
| `motif` | chaîne courte | motif du refus, pour le journal du job. Sans consommateur, et c'est voulu : un bot qui répond à chaque mention non autorisée est un bot qu'on finit par couper |
| `consigne-restreinte` | `'true'` \| `'false'` | `'true'` quand l'auteur de l'issue n'a pas le droit d'écriture : la consigne ne prend alors que le commentaire, et le corps de l'issue passe en données non fiables |

## Variables d'environnement lues par les scripts

Une composite action **n'expose pas** ses inputs en `INPUT_*` aux sous-processus.
Chaque valeur doit figurer dans le `env:` de son step.

### `garde.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `GITHUB_OUTPUT` | runner |
| `GH_TOKEN` | input `github-token` |
| `ASSOCIATIONS_AUTORISEES` | input `allowed-associations` |
| `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` | input `require-trusted-issue-author` |
| `GH_CLI` | tests seulement — binaire `gh` injectable |

### `preparer.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_OUTPUT`, `RUNNER_TEMP` | runner |
| `GH_TOKEN` | input `github-token` |
| `NUMERO_ISSUE` | sortie `issue` de la garde |
| `BRANCHE` | sortie `branche` de la garde |
| `BRANCHE_BASE` | input `base-branch` |
| `COMMANDE_VALIDATION` | input `validation-command`, citée dans la consigne |
| `CONSIGNE_RESTREINTE` | sortie `consigne-restreinte` de la garde |
| `GH_CLI` | tests seulement |

Sorties : `numero-pr`, `consigne`, `sauvegarde-config` (chemin de la copie de
`.git/config`, sous `RUNNER_TEMP`). Refuse un checkout qui a laissé le jeton dans la
configuration git : `persist-credentials: false` est exigé.

### `verifier.js`

| Variable | Source |
| --- | --- |
| `GITHUB_WORKSPACE`, `GITHUB_OUTPUT` | runner |
| `COMMANDE_VALIDATION` | input `validation-command` |
| `SAUVEGARDE_CONFIG` | sortie `sauvegarde-config` de `preparer` |
| `CONSIGNE` | sortie `consigne` de `preparer` |
| `PASSAGE` | `"1"` ou `"2"`, écrit en dur dans `action.yml` |

**Pas de `GH_TOKEN`**, à dessein. Sorties : `succes` (`'true'` \| `'false'`),
`consigne-reprise` (consigne + extrait de la sortie des tests, vide si succès),
`extrait` (fin de la sortie, nettoyée et courte, publiée dans le commentaire de
conclusion). Sort en 0 quand les tests ont pu tourner, verts ou rouges.

### `conclure.js`

| Variable | Source |
| --- | --- |
| `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_OUTPUT` | runner |
| `GH_TOKEN` | input `github-token` |
| `NUMERO_ISSUE`, `BRANCHE` | sorties de la garde |
| `NUMERO_PR`, `SAUVEGARDE_CONFIG` | sorties de `preparer` |
| `SUCCES`, `EXTRAIT` | sorties du dernier `verifier` qui a tourné |
| `PASSAGES` | `"1"` ou `"2"` |
| `ISSUE_CLAUDE` | `outcome` du dernier passage du modèle |
| `FICHIER_EXECUTION` | sortie `execution_file` du dernier passage : la dernière réponse du modèle y est lue et publiée |
| `RELECTEUR` | `github.actor`, l'auteur du déclenchement |
| `GH_CLI` | tests seulement |

Sortie : `succes`, `'true'` seulement si la validation est passée **et** le travail
poussé.

### `proxy.js`

Traducteur local Anthropic Messages → OpenAI Chat Completions, pour brancher Claude
Code sur un modèle Scaleway.

| Variable | Rôle |
| --- | --- |
| `SCW_MODELE` | modèle amont, **imposé à toutes les requêtes** ; le modèle demandé par le client est journalisé, jamais transmis. Obligatoire |
| `SCW_BASE_URL` | base de l'API amont, défaut `https://api.scaleway.ai/v1` |
| `SCW_CLE_FICHIER` | **chemin** d'un fichier contenant la clé amont, lu une fois au démarrage. Obligatoire. Jamais la clé elle-même en variable : sur Linux, `/proc/<pid>/environ` est lisible par tout processus du même utilisateur |
| `PROXY_JETON` | jeton exigé du client, en `x-api-key` ou `Authorization: Bearer`. Obligatoire |
| `PROXY_PORT` | port d'écoute, sur `127.0.0.1` seulement. Défaut `4000` ; `0` laisse le système choisir, et le port réel est écrit sur la première ligne de la sortie standard |
| `PLAFOND_MAX_TOKENS` | borne supérieure de `max_tokens`, défaut `16384` |
| `INTERVALLE_PING_MS` | intervalle des `ping` SSE, défaut `10000` |

### Ce que vaut `${{ job.status }}` dans une composite action

**L'action ne consomme plus cette expression.** Ce procès-verbal date de l'ancienne action aider, dont `resolve.js` et `rendre-compte.js` ont été supprimés ; ses conclusions sur le runner valent toujours. Ce qui suit reste écrit parce que la
manière dont on s'est trompé compte davantage que la conclusion : sans ce
procès-verbal, la même lecture d'`actions/runner` produira la même conclusion fausse
au prochain lot.

Le lot 5 a tranché **en lisant le runner**, parce qu'il exigeait un smoke test faisant
mourir `resolve.js` pour lever deux craintes qu'aucun test du dépôt ne pouvait mesurer.
Deux affirmations en sont sorties. **Une tient, l'autre est fausse.**

- **Elle n'est jamais vide — vrai.** `StepsRunner.cs:53` pose
  `jobContext.JobContext.Status = (jobContext.Result ?? TaskResult.Succeeded)` **avant**
  d'exécuter le premier step. La clé `status` existe donc dès le départ, et
  `StepsRunner.cs:155`, `:196` et `:278` la remettent à jour après chaque step. Confirmé
  à l'exécution : la valeur reçue était bien renseignée.
- **« Elle ne reste pas `success` dans une composite » — FAUX. Mesuré.** Run
  `32380365244` du dépôt d'essai, image `ubuntu-24.04`. Le step `resoudre` se termine en
  `conclusion=failure` ; le step suivant de la **même** composite démarre aussitôt et
  reçoit `STATUT_JOB: success`. `rendre-compte.js` en a conclu « le compte rendu a été
  publié par la boucle. Rien à publier ici », et **n'a rien publié** — dans le seul
  scénario pour lequel ce step existe.

  La lecture du code n'était pas absurde : un step embarqué reçoit ses contextes par
  copie (`ExecutionContext.cs:136-138`), et `CompositeActionHandler.cs` ne remplace que
  `inputs`, `steps`, `github` et `env` (`:144-158`, `:257-263`), donc l'enfant partage
  bien l'objet `JobContext` du job. Ce qu'elle n'autorisait pas, c'est d'en **déduire**
  que `status` refléterait l'échec d'un step déjà terminé du même job au moment où le
  step suivant lit son `env:`. Elle ne le fait pas.

**Leçon de méthode, et c'est le vrai contenu de cette section : une lecture du code du
runner ne remplace pas une mesure sur le runner.** C'est ce raccourci qui a fait
renoncer au smoke test que le lot 5 prévoyait (`plan/lot-5-ci.md:255-278`) — le seul
dispositif qui aurait attrapé le défaut. Le dépôt est resté vert pendant que l'action
ne démarrait pas.

Conséquence : le critère de silence du step de secours n'est plus « le job a-t-il
échoué ? » — un fait du runner qu'on ne sait pas lire — mais **« un compte rendu existe-
t-il déjà pour ce run ? »**, un fait que l'action écrit et relit elle-même, via le
marqueur (`porteeDuRun()`, `marqueurCompteRendu()`). Ce critère vit dans du code que
`test/compte-rendu.test.js` exerce en sous-processus, et non dans une expression du
YAML que `test/action.test.js` ne peut que comparer à une chaîne littérale.

**Un step `if: always()` d'une composite s'exécute bien JUSQU'AU BOUT dans un job déjà
rouge — mesuré, run `32462323017`.** C'était le dernier point en suspens, et il portait
les deux pistes : le run 32380365244 prouvait seulement le démarrage du step, qui s'était
ensuite tu volontairement. Levé en faisant lever `resoudreBase()` par un `base-branch`
inexistant : `resolve.js` meurt avant toute pull request et avant tout appel à aider, le
job est rouge, et le filet publie bien **un** commentaire sur l'issue, portant
`run=32462323017-1`. Le log ne contient **aucune** occurrence de `STATUT_JOB`.

Le silence, lui, est mesuré par le run `32462525547` : clé DeepSeek invalide, aider sort
non nul, la boucle publie son propre compte rendu, et le filet trouve le marqueur et ne
publie rien. Ce run est ressorti **vert** et non rouge comme prévu — à noter, parce que
la prévision inverse était fausse : `resolve.js` sort en 0 quand la boucle échoue
légitimement, une résolution ratée étant un résultat et non une panne. Le seul chemin
qui rougit le job est donc la panne, laquelle survient avant la publication de la boucle.

Ce qui n'est toujours pas mesuré, et il faut le dire : la combinaison « job rouge **et**
boucle ayant déjà publié ». Elle est peut-être quasi inatteignable pour la raison
ci-dessus, mais ce n'est pas démontré. Elle importe peu : depuis ce lot, le statut du job
n'est plus une entrée de la décision. Restent également non mesurés le job **annulé** et
le **timeout** du workflow appelant — le texte du corps ne les distingue plus, ce qui est
délibéré, mais que le step *tourne* dans ces conditions n'est pas établi.

Aucun test hors ligne ne peut prendre le relais sur ces points : les suites lancent
`rendre-compte.js` avec un environnement construit de zéro, elles ne voient jamais ce
qu'un step de composite reçoit.

### `uses: ./<sous-répertoire>` et `GITHUB_ACTION_PATH`

Relevé au lot 5, également dans `actions/runner`, et c'est ce qui permet de prouver
**localement** la règle « jamais de chemin relatif » du lot 4.

`ActionManager.cs:699-705` : pour une référence locale, `actionDirectory` part de
`GITHUB_WORKSPACE`, puis `Path.Combine(actionDirectory, repoAction.Path)` **si la
référence porte un chemin**. `CompositeActionHandler.cs:161` recopie ce répertoire dans
`github.action_path` de chaque step embarqué.

Donc : `uses: ./` donne `GITHUB_ACTION_PATH == GITHUB_WORKSPACE` — un `node
scripts/garde.js` relatif y passe — mais `uses: ./copie-action` donne
`GITHUB_WORKSPACE/copie-action`, où le chemin relatif ne résout plus. Un second job qui
checkoute le dépôt dans un sous-répertoire suffit donc à faire rougir la régression,
sans référence distante et sans commit poussé.

## Inputs de `action.yml`

| Input | Requis | Défaut | Exposé sous |
| --- | --- | --- | --- |
| `scaleway-api-key` | oui | — | `SCW_SECRET_KEY`, step `proxy` seulement, puis fichier supprimé |
| `scaleway-base-url` | non | `"https://api.scaleway.ai/v1"` | `SCW_BASE_URL` |
| `model` | non | `"glm-5.3"` | `SCW_MODELE`, `ANTHROPIC_*_MODEL`, `--model` |
| `context-window` | non | `"256000"` | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` |
| `max-turns` | non | `"30"` | `--max-turns` |
| `github-token` | non | `${{ github.token }}` | `GH_TOKEN`, `github_token` |
| `validation-command` | non | `"npm test"` | `COMMANDE_VALIDATION` |
| `base-branch` | non | `""` | `BRANCHE_BASE` |
| `allowed-associations` | non | `"OWNER,MEMBER,COLLABORATOR"` | `ASSOCIATIONS_AUTORISEES` |
| `require-trusted-issue-author` | non | `"true"` | `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` |

Tous les inputs sont des **chaînes**. Côté script, ne comparer qu'à `'true'`,
jamais à `'false'`.

## Outputs de `action.yml`

`poursuivre`, `branche`, `numero-pr`, `succes`. Un step sauté laisse sa sortie à
la chaîne vide : c'est ce que les smokes contrôlent.

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
brancheDistanteExiste(nom, prefixeAuth = [])       // booléen
                                                   // `prefixeAuth` va AVANT `ls-remote` : sous
                                                   // `persist-credentials: false`, un `ls-remote`
                                                   // nu sort en « could not read Username for
                                                   // 'https://github.com' » — mesuré sur runner
// chemins.js
estCheminInterdit(chemin)                          // booléen — liste du lot 3b
                                                   // refuse aussi `.claude/`, `CLAUDE.md`, `.mcp.json`,
                                                   // et tout `.aider*` (nom ET premier
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
// traduction.js — Anthropic Messages ↔ OpenAI Chat Completions, fonctions pures
requeteVersOpenAI(corps, { modele, plafondMaxTokens })  // corps Anthropic -> corps OpenAI
reponseVersAnthropic(corps, modeleDemande)         // réponse OpenAI complète -> message Anthropic
creerTraducteurFlux(modeleDemande)                 // { morceau(chunk) -> evenements[],
                                                   //   fin() -> evenements[] }
                                                   // un événement : { type, ...données } — le
                                                   // `type` est aussi le nom SSE
erreurVersAnthropic(statut, texte)                 // { type: 'error', error: { type, message } }
                                                   // message amont recopié, jamais réécrit// action.js — outils communs à preparer.js, verifier.js et conclure.js
lireEnv(nom)                                       // trimée, '' si absente
ecrireSorties({ nom: valeur })                     // forme à délimiteur, toujours
entrerDansEspaceTravail()                          // chdir GITHUB_WORKSPACE, exige un dépôt git
prefixeAuthentification(jeton)                     // ['-c', 'http.extraheader=…'] : le jeton ne
                                                   // touche jamais le disque. AVANT ls-remote,
                                                   // fetch ET push
SANS_HOOKS                                         // ['-c', 'core.hooksPath=/dev/null'] : sur commit
                                                   // et push, les tests ont pu poser un hook
restaurerConfigurationGit(sauvegarde)              // recopie la sauvegarde sur .git/config
```

## Suites de test du dépôt

Noms figés **ici** parce que `.github/workflows/test.yml` contrôle leur existence et que
rien d'autre ne les recense. Toutes tournent hors ligne, sans clé d'API ni réseau,
en `node test/<nom>` — pas de runner de test, pas de dépendance.

| Fichier | Ce qu'il couvre |
| --- | --- |
| `test/chemins.test.js` | `scripts/lib/chemins.js` |
| `test/texte.test.js` | `scripts/lib/texte.js` |
| `test/garde.test.js` | `scripts/garde.js` |
| `test/etapes.test.js` | `scripts/preparer.js`, `scripts/verifier.js`, `scripts/conclure.js` — dépôts jetables, remote local, stub `gh` |
| `test/action.test.js` | `action.yml` — cohérence statique |
| `test/ci.test.js` | `.github/workflows/test.yml` — cohérence statique |
| `test/traduction.test.js` | `scripts/lib/traduction.js` |
| `test/proxy.test.js` | `scripts/proxy.js` — faux amont local, hors ligne |

Le job `suites` les lance par le glob `test/*.test.js` : la liste ci-dessus n'est donc
pas ce qui décide de ce qui tourne, seulement ce dont la disparition est signalée.

### Pourquoi une suite pour le workflow lui-même

Ajoutée au lot 5, pour la même raison que `test/action.test.js` au lot 4 : le workflow
est le seul endroit qui lance les six autres suites, et **rien ne le surveillait**.

Deux défauts mesurés du lot 5 justifient à eux seuls la suite, parce que tous deux
laissaient la CI verte tout en ne contrôlant plus rien :

- `find … -exec node --check {} \;` rend 0 même sur un script cassé ;
- un `uses:` en chemin relatif au lieu de `$GITHUB_ACTION_PATH` passe `smoke-local`.

`test/ci.test.js` épingle donc les formes dont on a mesuré que l'écart est silencieux :
la forme `xargs` du `node --check`, l'absence d'expression dans un `uses:`, le runner en
dur, la version et le condensat d'`actionlint` — comparés à **ce fichier** —, le glob des
suites, `permissions: contents: read`, et l'absence de `${{ … }}` dans le corps d'un
`run:`.

Comme `test/action.test.js`, elle ne lit pas du YAML en général : elle lit les blocs à
indentation connue de **notre** fichier et lève sur une forme qu'elle ne reconnaît pas.
La validité YAML du workflow est prouvée par `actionlint` dans le job `syntaxe`, et celle
de `action.yml` par les deux jobs de smoke.

Trappe de test, comme `ACTION_YML` au lot 4 : la variable `CI_YML` désigne le fichier
lu, `.github/workflows/test.yml` par défaut. Sans elle, aucune mutation ne peut être
essayée sans modifier le vrai workflow du dépôt — et un test qu'on ne peut pas faire
rougir ne prouve rien.

#### La famille de mutations qui compte : vider le travail, garder l'apparence

Relevé par la revue du lot 5, après deux batteries de mutations — 31 côté exécutant,
23 côté chef de lot — qui **n'avaient rien vu**. Les deux ne muaient que des *formes* :
un mot remplacé par un autre. Cinq mutations d'une autre famille laissaient les 21 cas
verts et `actionlint` à 0 :

| Mutation | Ce qui cessait d'être contrôlé |
| --- | --- |
| `-name '*.js'` → `'*.mjs'` | tout. Mesuré : le tube rend 0 avec **zéro** fichier contrôlé |
| le step qui **lance** `actionlint` supprimé, l'installation gardée | tous les workflows |
| corps de la boucle des suites découplé de sa variable | 195 cas sur 206 |
| `exit "$manquantes"` retiré | le sens « suite supprimée » : un `::error::` seul ne fait pas rougir un step |
| step d'assertion de `smoke-local` supprimé | le job ne fait plus que « ne pas planter » |

Règle pour tout harnais de ce dépôt : la mutation à essayer n'est pas « remplacer un mot
par un autre » mais **retirer le travail en gardant l'apparence** — supprimer le step,
vider le corps de la boucle, couper le lien entre la déclaration et l'usage, neutraliser
le code de sortie, ajouter un `\|\| true`.

Et un ban de **graphies** ne ferme pas cette famille. Première correction : `\|\| true` et
`set +e` interdits. Mesuré, restaient verts : `sha256sum -c - \|\| :`, `sha256sum -c - ; true`,
et `set +o errexit` en tête du step des suites — cette dernière rendant le job vert avec
195 cas sur 206 rouges (mesuré en shell : `set -eo pipefail; set +o errexit; for f in un
deux trois; do false; done` déroule tous les tours et rend 0). D'où les interdits par
**propriété** de la table ci-dessous, et non par liste.

##### Ce qu'aucun lecteur statique ne peut fermer

Limite mesurée, à ne pas prétendre couvrir. `if [ ! -f "$suite" ] && false; then` laisse en
place le motif `-f "$suite"`, le `::error::`, le `manquantes=1` et l'`exit "$manquantes"` —
tout ce qu'un harnais peut voir — et le step rend 0 quelles que soient les suites absentes.
Même chose sur l'assertion de `smoke-local` avec un `&& false`.

Deuxième forme mesurée, la plus discrète des deux : une **fonction shell** qui masque une
commande, définie plus haut dans le même `run:` — `find() { return 0; }` en trois lignes,
sans `;`, sans `||`, sans `set +`. Le tube rend 0 avec un script cassé sur le disque, et le
texte attendu est intact d'un bout à l'autre. Une définition de fonction ressemble beaucoup
moins à un sabotage qu'un `&& false`.

C'est la **sémantique** du shell qui change, pas le texte. La fermer demanderait d'exécuter
le corps du step contre un arbre truqué ; poursuivre par des motifs de plus en plus fins
ajouterait de la complexité contre une famille infinie. Aucun cas de `test/ci.test.js` ne
doit donc laisser croire qu'elle est couverte.

#### Ce que `test/ci.test.js` interdit désormais, et qui contraint les éditions futures

Ces interdits ne sont pas des préférences de style : chacun ferme une mutation mesurée.

| Interdit | Pourquoi |
| --- | --- |
| `shell:` sur un step, et `defaults:` au niveau d'un job | `shell: sh` sur le step du tube ramène l'échec de `find` avalé faute de `pipefail`. Un ban limité aux steps se contourne par un `defaults:` de job |
| `\|\|` tout court, `set +` désarmant le shell, et tout `;` hors `for … ; do` / `while … ; do` / `if … ; then` | trois **propriétés**, pas trois graphies. Le workflow n'a aucun `\|\|` aujourd'hui, et aucun step n'a de raison d'avaler un code de retour : c'est la façon la plus courte de rendre un job vert à vide. Mesuré : le ban limité à `\|\| true` et `set +e` laissait passer `\|\| :`, `; true` et `set +o errexit` |
| un fichier `.github/actionlint.yaml` ou `.yml` | mesuré : six lignes portant `paths: {".github/workflows/**": {ignore: [".*"]}}` font rendre **0** à `actionlint` sur un workflow qui contient une vraie erreur. Tout le job `syntaxe` est neutralisé, depuis un fichier que le harnais ne lit pas. C'est le seul contrôle de `test/ci.test.js` qui regarde ailleurs que `CI_YML` |
| `sha256sum -c` avec autre chose que `-` | le condensat attendu part sur stdin : `-c` doit donc lire `-`, sans quoi la commande vérifie une **autre** liste et l'archive téléchargée n'est plus contrôlée. Mesuré dans `ubuntu:24.04`, l'image du runner, avec GNU coreutils 9.4 et un condensat qui ne correspond pas : la forme livrée rend **1** ; `-c /dev/null` rend **1** aussi, avec `no properly formatted checksum lines found` — bruyant, donc pas de la famille silencieuse ; mais `-c <un fichier de sommes valide et sans rapport>` rend **0**, et c'est la mutation qui compte. Le `/sbin/sha256sum` de Darwin est inutilisable pour cette mesure : il rend 0 même sur un condensat faux avec `-c -` |
| tout écart aux jetons `-name '*.js' -print0` d'un côté du tube, et `xargs -0 -n1 node --check` de l'autre | le trou s'est rouvert **trois fois par ajout**, jamais par substitution : `-name '*.mjs'`, puis `-path nulle-part` devant le prédicat, puis `node --check --help`. Mesuré : `--help`, `--version` et `-v` font sortir node en **0** avant tout contrôle ; `xargs -0` sans `-n1` rend **0**, un seul fichier étant contrôlé par lot ; `-n2` rend 0 ou 1 **selon le rang** du fichier cassé dans le lot. D'où l'égalité des deux listes de jetons, et non la présence des motifs. Les répertoires, eux, restent en inclusion : en ajouter un agrandit le lot |
| toute occurrence de `secrets.` en contenu | c'est l'absence de secret dans ce workflow qui autorise `set -x`. Sans ce ban, un futur `env: TOKEN: ${{ secrets.X }}` rendrait la permission fausse sans que rien ne bouge |
| un argument passé à `actionlint` | lancé sur `.github/workflows/test.yml`, il cesse d'analyser tout workflow futur, alors que le contrat lui fait prouver que `.github/workflows/**` passe |
| `if:` et `continue-on-error:`, sur un job comme sur un step | les quatre identifiants sont les checks obligatoires d'une branche protégée : un job sauté ou toléré remonte **vert**, et la protection ne protège plus |
| un filtre `paths:` sur `pull_request` | une PR qui ne touche pas `scripts/**` ne serait plus contrôlée du tout |

Un step qui aurait un vrai besoin de l'un d'eux devra changer cette décision **ici**
d'abord, comme tout le reste.

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

## Jobs de `.github/workflows/test.yml`

Noms figés **ici** au lot 5 : ce sont les noms des checks obligatoires d'une branche
protégée, donc des noms qu'on ne renomme pas sans une décision. Tous en
`runs-on: ubuntu-24.04` en dur, `permissions: contents: read` au niveau du workflow.

| Job | Ce qu'il prouve |
| --- | --- |
| `syntaxe` | tout `scripts/**.js` et `test/**.js` se charge (`node --check`), et `.github/workflows/**` passe `actionlint`. Journalise `node --version` |
| `suites` | toutes les suites de « Suites de test du dépôt » passent, hors ligne |
| `smoke-local` | l'action **se monte** en `uses: ./` : `runs:` valide, `shell:` présents, `uses:` internes résolus, `outputs:` remontés. Contrôle `poursuivre == 'false'` |
| `smoke-sous-repertoire` | `GITHUB_ACTION_PATH` n'est pas `GITHUB_WORKSPACE` : checkout dans un sous-répertoire, `uses: ./<sous-répertoire>`. Fait rougir tout chemin relatif |

Ce que la CI ne prouve pas, et qui reste pour la vérification de bout en bout :
l'appel réel à claude-code-action et au modèle. Les smokes s'arrêtent à la garde. **Aucune clé Scaleway dans les secrets de ce dépôt.**

### Pourquoi un seul job pour toutes les suites

Le lot 5 en prévoyait un par suite, et n'en recensait que trois. Deux mesures ont
tranché : les six suites du lot 4 prennent **23 s** au total (`boucle` 17 s, `compte-rendu` 5 s,
les quatre autres moins d'une seconde chacune), donc le parallélisme n'achète rien ; et
une liste de suites écrite à la main dans le YAML est précisément ce qui a laissé
`texte`, `action` et `compte-rendu` hors CI.

Le job boucle donc sur `test/*.test.js` — une suite ajoutée est lancée sans que
personne y pense — et contrôle en plus que les fichiers nommés dans ce contrat
existent. Les deux sens sont fermés, et l'oubli ne peut rendre la CI que **plus**
rouge : une suite ajoutée est exécutée, une suite supprimée ou renommée est signalée.

Mesuré : le glob n'a pas besoin de `nullglob` pour être sûr. Sans correspondance, bash
passe le motif littéral à `node`, qui rend `MODULE_NOT_FOUND` et un code non nul — le
cas « plus aucune suite » est bruyant, pas silencieux.

### La CI ne pose pas `GH_CLI`

Mesuré du temps de l'ancienne action : poser `GH_CLI` dans le workflow ne change rien,
chaque suite construit l'environnement des sous-processus qu'elle lance au lieu
d'hériter du sien. Une variable d'environnement sans effet est pire qu'absente : elle
fait croire que la CI pilote les stubs, alors que c'est le harnais qui les pilote.
