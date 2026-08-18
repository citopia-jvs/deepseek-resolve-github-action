# Lot 2 — La garde d'entrée

**Dépend de** : lot 1. Lire [`contrat.md`](contrat.md) pour les noms de sorties et de
variables.

## Objectif

`scripts/garde.js` décide si l'action doit poursuivre. Il tourne **avant**
l'installation d'aider — ce qui économise plus d'une minute de runner à chaque
commentaire sans `@dseek` — et c'est lui qui porte le contrôle d'autorisation.

## Ce que cette garde fait, et ce qu'elle ne fait pas

Elle contrôle **qui déclenche**. Elle ne contrôle **pas** le texte de la consigne.

La version précédente de ce plan écrivait que cette garde était « la seule chose qui
sépare l'action d'une porte ouverte ». C'est faux, et la phrase était nuisible : elle
laissait croire le sujet clos. La consigne envoyée à aider contient le corps de
l'issue, qui peut avoir été rédigé par quelqu'un d'autre que l'auteur du `@dseek` —
c'est même le cas d'usage nominal. Voir R6 dans le plan maître, et son traitement au
lot 3b.

Cette garde reste indispensable : sans elle, n'importe qui capable de commenter fait
exécuter au runner du code écrit par un modèle, avec un token en écriture et une clé
API dans l'environnement. Sur un dépôt public, cela vise le monde entier.

## Comportement général

Le script sort **toujours en code 0**, même quand il refuse. Un refus n'est pas une
panne : un job en échec rouge à chaque commentaire anodin rendrait le dépôt illisible.
Le refus s'exprime par la sortie `poursuivre=false`.

Corollaire à écrire explicitement dans le code : **toute exception non prévue vaut
`poursuivre=false`**. Envelopper le corps du script dans un `try/catch` qui écrit la
sortie avant de sortir. Le comportement précédent était fail-closed par accident (une
exception faisait échouer le step, donc le `if:` des steps suivants était faux) ; avec
l'appel de permission de l'étape 5, il faut que ce soit fail-closed par intention —
un timeout réseau ne doit jamais valoir « autorisé ».

Autre corollaire : écrire `poursuivre=false` **dès le premier refus**, pas seulement
à la fin. La version précédente plaçait l'écriture des sorties après tous les
contrôles, donc un refus précoce laissait `poursuivre` vide.

## Séquence

### 1. Liste blanche d'événements

```js
if (!['issues', 'issue_comment'].includes(process.env.GITHUB_EVENT_NAME)) → refus
```

**Première ligne du script.** La version précédente déduisait l'événement de la
*forme* du payload, ce qui refusait `pull_request_target` par effet de bord — pas par
contrôle. Un contrôle explicite survit à un futur ajout de support des PR, et il
protège un consommateur qui écrirait `on: pull_request_target` sans avoir lu le
README. Trois lignes.

Journaliser le nom d'événement refusé : c'est le chemin qu'emprunte le smoke test du
lot 5.

### 2. Lire l'événement

`JSON.parse` du fichier `GITHUB_EVENT_PATH`. Deux formes :

- `payload.issue` sans `payload.comment` → événement `issues`. Texte = `issue.body`,
  acteur = `issue.user.login`, association = `issue.author_association`.
- `payload.comment` → `issue_comment`. Texte = `comment.body`,
  acteur = `comment.user.login`, association = `comment.author_association`,
  numéro = `payload.issue.number`.

Toute autre forme → refus.

### 3. Refuser les pull requests

Si `payload.issue.pull_request` est présent, l'objet est une PR, pas une issue.
Ce contrôle ne sert que pour `issue_comment` — sur un événement `pull_request`,
`payload.issue` est absent et l'étape 1 a déjà refusé.

### 4. Anti-rejeu

Deux contrôles, tous deux liés à R10 :

- **Sur `edited`** : si `payload.action === 'edited'` et que
  `payload.changes?.body?.from` contient déjà `@dseek`, refuser. La mention n'est pas
  nouvelle, il n'y a rien à faire. Sans ce contrôle, chaque édition d'un vieux
  commentaire relance un cycle complet — un compte autorisé qui édite en boucle vide
  la clé DeepSeek.
- **Chercher `@dseek`** dans le texte, insensible à la casse. Absent → refus
  silencieux (log en `debug`, c'est le cas de très loin le plus fréquent).

### 5. Autoriser — deux étages

**Étage 1, gratuit** : `author_association` doit être dans
`ASSOCIATIONS_AUTORISEES` (défaut `OWNER,MEMBER,COLLABORATOR`). La valeur est dans le
payload, calculée par GitHub, **non falsifiable** par l'émetteur. Aucun appel réseau.

**Étage 2, obligatoire** : la permission effective.

```
gh api repos/{owner}/{repo}/collaborators/{login}/permission --jq .permission
```

N'accepter que `write`, `maintain` ou `admin`. **Fail-closed** sur erreur réseau, 404
ou valeur inattendue.

Pourquoi cet étage n'était pas dans la version précédente, et pourquoi il est
indispensable : `author_association` **n'est pas une permission**.

| Valeur | Ce que dit GitHub | Droit d'écriture sur *ce* dépôt ? |
| --- | --- | --- |
| `OWNER` | propriétaire du dépôt | oui |
| `MEMBER` | membre de l'**organisation** propriétaire | **non** — aucun rapport avec l'accès au dépôt |
| `COLLABORATOR` | a été **invité à collaborer** | **non** — inclut `read` et `triage` |
| `CONTRIBUTOR` | a **déjà commité** | non — une PR fusionnée suffit |

Sur un dépôt d'organisation de trois mille personnes, la liste par défaut autorise
trois mille déclencheurs potentiels d'un job à `contents: write`, plus tous les
collaborateurs en lecture seule.

Le piège aggravant : GitHub ne renvoie qu'**une seule** association, et elle est
prioritaire sur `CONTRIBUTOR`. Un membre d'organisation qui a déjà commité est
rapporté `CONTRIBUTOR`, donc refusé par la liste par défaut. Le réflexe du
consommateur sera d'ajouter `CONTRIBUTOR` à `allowed-associations` — et la porte
s'ouvre alors à quiconque a fait fusionner une correction de faute de frappe. La
bonne réponse à ce symptôme est l'étage 2, jamais l'élargissement de la liste. À
dire au lot 6.

L'appel n'a lieu que sur les payloads déjà porteurs de `@dseek` : le coût invoqué par
la version précédente pour l'éviter n'existe pas.

**Étage 2 bis** : si `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` vaut `'true'` (défaut) et que
l'événement est `issue_comment`, appliquer le même contrôle à `issue.user.login`. Si
l'auteur de l'issue n'est pas autorisé, ne pas refuser : passer en **mode consigne
restreinte**, signalé au lot 3b, où seul le texte du commentaire sert de consigne et
le corps de l'issue est fourni en données non fiables. C'est une atténuation de R6,
pas une barrière.

En cas de refus, journaliser explicitement qui a été refusé et pourquoi. Un refus muet
est indébogable. Renseigner la sortie `motif`.

### 6. Valider le numéro d'issue

```js
if (!Number.isInteger(n) || n <= 0) → refus
```

Puis construire `fix-issue-<n>` et le valider contre `/^fix-issue-\d+$/` avant tout
usage. En production `payload.issue.number` est un nombre JSON écrit par GitHub, donc
le risque est faible ; le coût du contrôle est nul et il ferme l'injection d'argument.

### 7. Refuser si le travail existe déjà

Deux contrôles, pas un :

```
gh pr list --repo "$GITHUB_REPOSITORY" --head fix-issue-<n> --state open --json number
gh api repos/{o}/{r}/git/ref/heads/fix-issue-<n>        # tolererEchec: 404 = absente
```

La version précédente ne regardait que les PR **ouvertes**. Une PR fermée sans
suppression de branche laisse la branche sur le remote, et le push du lot 3c est alors
rejeté en non-fast-forward — après avoir consommé toutes les itérations (R9).

Décision : si la branche existe côté distant **sans** PR ouverte, ne pas refuser ; le
lot 3a la réutilisera. Le refus ne concerne que la PR ouverte, avec un message qui la
pointe.

### 8. Écrire les sorties

`poursuivre`, `issue`, `branche`, `consigne-restreinte`, `motif` dans `GITHUB_OUTPUT`, une paire
`clé=valeur` par ligne. Pour une valeur susceptible de contenir un retour à la ligne
(`motif`), utiliser la forme à délimiteur :

```
motif<<EOF_MOTIF
…
EOF_MOTIF
```

Écrire les paires simples **avant** le bloc à délimiteur de `motif` : une paire
placée après le `EOF_MOTIF` fermant serait avalée par la valeur si le délimiteur se
fermait mal.

`consigne-restreinte` est la cinquième sortie, ajoutée au contrat après ce lot : sans
elle, le mode consigne restreinte de l'étage 2 bis reste un simple message de journal et
n'atteint jamais le lot 3b, donc l'atténuation de R6 promise plus haut est inopérante de
bout en bout.

`GITHUB_OUTPUT` est hérité par le process Node enfant ; `fs.appendFileSync` suffit.

### 9. Réaction 👀

Uniquement si on poursuit, et **après** le contrôle d'autorisation : accuser réception
d'une demande qui ne sera pas traitée est trompeur.

**Les deux endpoints diffèrent** — le code supprimé au lot 0 les confondait :

- commentaire : `POST /repos/{o}/{r}/issues/comments/{comment_id}/reactions`
- issue : `POST /repos/{o}/{r}/issues/{numéro}/reactions`

Corps `{"content":"eyes"}`. `issues: write` suffit pour les deux. Un échec de réaction
ne doit pas faire échouer la garde (`tolererEchec`).

## Fixtures

Dans `__fixtures__/`, minimales mais réalistes — ne garder que les champs réellement
lus. Un payload GitHub complet fait plusieurs centaines de lignes.

| Fichier | Contenu | `poursuivre` |
| --- | --- | --- |
| `issue-avec-dseek.json` | `issues`, body avec `@dseek`, `OWNER` | `true` |
| `commentaire-avec-dseek.json` | `issue_comment`, `@dseek`, `OWNER` | `true` |
| `issue-sans-dseek.json` | `issues`, body sans mention | `false` |
| `commentaire-sur-pr.json` | `issue_comment` avec `issue.pull_request` | `false` |
| `commentaire-non-autorise.json` | `issue_comment`, `@dseek`, `NONE` | `false` |
| `commentaire-reedite.json` | `edited`, `changes.body.from` contient déjà `@dseek` | `false` |
| `evenement-push.json` | `GITHUB_EVENT_NAME=push` | `false` |
| `issue-auteur-non-de-confiance.json` | `issue_comment` `OWNER` sur une issue d'un `NONE` | `true`, mode consigne restreinte |
| `issue-mention-cachee.json` | `issues`, `@dseek` **uniquement** dans un `<!-- … -->` | `false` |
| `commentaire-reedite-mention-cachee.json` | `edited`, `changes.body.from` porte `<!-- @dseek -->` | `false` |

`commentaire-avec-dseek.json` manquait dans la version précédente. C'était le seul cas
qui exerce l'endpoint de réaction **commentaire** — précisément le piège que ce lot
signale comme l'erreur de l'ancien code. Le piège identifié n'était couvert par aucun
test.

`evenement-push.json` manquait aussi, et c'est exactement le chemin qu'emprunte le
smoke test du lot 5.

Les deux dernières fixtures sont venues de la relecture, et chacune verrouille un
arbitrage qui sans elle pouvait être défait sans faire rougir un seul test :

- `issue-mention-cachee.json` — la mention du texte courant est cherchée dans le texte
  **nettoyé**, pour que la mention qui déclenche soit celle que le lecteur voit (R6).
  Sans cette fixture, retirer `nettoyerTexteTiers` laissait le harnais entièrement vert.
- `commentaire-reedite-mention-cachee.json` — sur `changes.body.from`, à l'inverse, la
  recherche se fait sur le texte **brut** : si l'ancienne version portait la mention dans
  un `<!-- … -->` et la nouvelle en clair, le contenu n'a pas changé, il n'y a rien à
  traiter (R10). Les deux règles sont opposées et c'est voulu — d'où deux fixtures.

## Harnais de test

`test/garde.test.js` est livré **par ce lot**, avec les fixtures. Le lot 5 ne fait que
l'appeler. Node, pas une accumulation de `if` en bash — préférence du projet.

Il doit contrôler **deux choses** par cas : la valeur de `poursuivre`, et que le code
de sortie vaut **0 dans tous les cas**, y compris les refus.

## Vérification

```bash
node --check scripts/garde.js
node test/garde.test.js
```

Le test injecte `GH_CLI=__fixtures__/gh-stub.sh`, qui écrit `[]` sur stdout.

**Ne pas utiliser `GH_CLI=/bin/true`** : stdout est alors vide, `JSON.parse('')` lève,
le script sort en code non nul, et le cas nominal échoue en contredisant la règle
« code 0 partout ». La version précédente de ce plan donnait `/bin/true` dans son bloc
de vérification tout en le corrigeant dans une note trois lignes plus bas — et la
commande fautive avait été recopiée dans les lots 6 et 7, donc promise à finir dans le
README et le `CLAUDE.md`.
