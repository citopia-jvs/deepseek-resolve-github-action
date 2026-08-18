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
| `actions/checkout` | `v5` | `v4` déclare `using: node20`, retiré des runners le 2026-09-16. |
| Runner | `ubuntu-24.04` **en dur** | `ubuntu-latest` basculera sur 26.04, dont le Python 3.14.4 est hors borne. |

## Sorties de `scripts/garde.js` (dans `GITHUB_OUTPUT`)

| Sortie | Type | Valeur |
| --- | --- | --- |
| `poursuivre` | `'true'` \| `'false'` | écrite sur **tous** les chemins, y compris les refus |
| `issue` | entier décimal | numéro d'issue, validé `Number.isInteger` |
| `branche` | `fix-issue-<n>` | validée contre `/^fix-issue-\d+$/`. **Fait foi** : `resolve.js` ne la reconstruit pas |
| `motif` | chaîne courte | motif du refus, pour le compte rendu. Vide si `poursuivre=true` |
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
| `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_ACTION_PATH` | runner |
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

### `rendre-compte.js`

`GH_TOKEN`, `GITHUB_REPOSITORY`, `NUMERO_ISSUE`, `BRANCHE`, `STATUT_JOB`
(`${{ job.status }}`), `SANS_PUBLICATION`.

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

## Signatures exportées par `scripts/lib/`

```js
// gh.js
gh(args, { json = false, tolererEchec = false })   // --repo ajouté par l'appelant
// git.js
git(args, { tolererEchec = false })                // stdout trimmé
aDesCommits(base)                                  // booléen
etatFichiers()                                     // [{ statut, chemin }] — pas juste des chemins
                                                   // renommage ou copie : la destination garde le
                                                   // statut brut de git ('R ', 'RM', 'C '),
                                                   // l’origine porte la sentinelle 'R<'
brancheDistanteExiste(nom)                         // booléen
// chemins.js
estCheminInterdit(chemin)                          // booléen — liste du lot 3b
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
appelerAider(consigne)          // -> { codeSortie, sortie }
executerValidation()            // -> { codeSortie, logs }   env filtrée
commiterTravail(message)        // -> { commite: bool, refuses: string[] }
publierInitial(prompt)          // -> { numeroPr }            push + gh pr create
publierTour(i, resultat)        // -> void                    commentaire de PR
publierCompteRendu(bilan)       // -> void
```
