# DeepSeek Auto-Resolve Issue

GitHub Action qui pilote [aider](https://aider.chat) avec un modèle DeepSeek pour
tenter de résoudre automatiquement une issue. Ce n'est **pas** un client brut de
l'API DeepSeek : la lecture du dépôt, la sélection du contexte, l'édition des
fichiers et l'application des correctifs sont déléguées à aider ; l'action se
charge du déclenchement, de l'autorisation, de la publication et des
garde-fous de sécurité.

Quand une issue — ou un commentaire d'issue — contient `@dseek`, écrit par
quelqu'un d'autorisé, l'action crée une branche `fix-issue-<n>`, appelle aider,
commite elle-même ce qu'elle a validé, pousse et ouvre une pull request — dans
cet ordre : la PR n'existe qu'après le premier appel. Elle boucle ensuite :
commande de validation du dépôt, et nouvelle tentative en cas d'échec, jusqu'à ce
que la validation passe ou que `max-iterations` soit atteint.

> **⚠️ Projet en cours de développement.** Les versions `v1` et `v1.0.0` existent,
> et les quatre jobs de la CI de ce dépôt sont verts sur le commit qu'elles
> désignent. Mais le déroulé de bout en bout avec un vrai modèle DeepSeek n'a
> **jamais** été exécuté, pas une seule fois : ce que la CI prouve, ce sont les
> suites hors ligne et le montage de l'action, pas une résolution d'issue réelle.
> Lire la section [Sécurité](#sécurité) avant toute installation.

## Utilisation

Dans le dépôt à équiper, créer `.github/workflows/dseek.yml` :

```yaml
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: deepseek-resolve-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  resolve:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: citopia-jvs/deepseek-resolve-github-action@v1
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          validation-command: npm test
```

Cinq points de cet exemple ne sont pas de simples préférences de style :

- **`actions/checkout@v5`, pas `@v4`.** `v4` déclare `using: node20`, retiré
  des runners GitHub le 2026-09-16. Un workflow neuf écrit sur `@v4` serait
  déjà obsolète.
- **`persist-credentials: false`.** Avec le défaut (`true`), un jeton en
  écriture est écrit dans `.git/config` du checkout et devient lisible par
  n'importe quel code qui y tourne — y compris celui que le modèle vient
  d'écrire. L'action authentifie elle-même son push : elle fonctionne dans les
  deux cas, mais seul `false` ne laisse pas le jeton traîner sur disque.
- **`runs-on: ubuntu-24.04` en dur, pas `ubuntu-latest`.** `ubuntu-latest` change
  d'image sans préavis. L'action n'utilise pas le Python de l'image — elle installe
  celui de `python-version` — mais elle a besoin de `pipx`, que les images Ubuntu
  fournissent, et elle n'est vérifiée que sur celle-ci. Un basculement d'image est
  un changement d'environnement d'exécution qu'on ne veut pas subir un matin.
- **Le bloc `concurrency`.** Deux `@dseek` rapprochés sur la même issue
  donnent deux jobs qui créent la même branche `fix-issue-<n>` : la garde de
  l'action n'est pas un verrou, la PR n'existe que plusieurs minutes après le
  démarrage du job. `concurrency` n'existe pas dans une composite action —
  c'est donc au workflow consommateur de le porter, comme ci-dessus.
- **`types: [opened]` et `types: [created]` seulement, jamais `edited`.**
  Sinon, rééditer un vieux commentaire qui contient déjà `@dseek` relance un
  cycle complet. L'action se défend aussi de son côté, mais autant ne pas
  déclencher le job du tout.

À savoir aussi :

- `actions/checkout` est **obligatoire** : aider travaille dans le checkout du
  runner, pas via l'API GitHub.
- `timeout-minutes` sur le job est le vrai garde-fou de coût, plus fiable que
  `max-iterations` seul, qui borne le nombre d'appels mais pas leur taille.
- Si `validation-command` a besoin de dépendances installées (`npm ci`,
  `actions/setup-node`…), ces steps vont **avant** l'action.
- **Ne jamais interpoler de contexte GitHub dans `validation-command`.** Un
  `npm test -- --grep "${{ github.event.issue.title }}"` est une injection de
  script : le titre de l'issue est un texte de tiers.

## Entrées

| Nom | Requis | Défaut | Description |
| --- | --- | --- | --- |
| `deepseek-api-key` | oui | — | Clé API DeepSeek. À passer par un secret, jamais en clair. |
| `github-token` | non | `${{ github.token }}` | Jeton utilisé pour lire l'issue, pousser la branche et publier la PR. |
| `max-iterations` | non | `2` | Nombre maximum de tours d'appel à aider suivis d'une validation. Entier de 1 à 20 ; toute autre valeur retombe **silencieusement** sur `2`, avec un avertissement dans les logs du job. |
| `validation-command` | non | `npm test` | Commande exécutée dans le checkout pour valider la correction. Code de sortie `0` = succès. |
| `base-branch` | non | *(vide)* | Branche de base de la pull request. Vide : la branche du checkout. |
| `model` | non | `deepseek/deepseek-v4-pro` | Modèle passé à aider, au format LiteLLM. |
| `aider-version` | non | `0.86.2` | Version d'`aider-chat` installée par l'action. |
| `python-version` | non | `3.12` | Version de Python utilisée pour installer aider. |
| `map-tokens` | non | `2048` | Budget de jetons de la carte du dépôt construite par aider. |
| `allowed-associations` | non | `OWNER,MEMBER,COLLABORATOR` | Associations au dépôt autorisées à déclencher l'action, séparées par des virgules. |
| `require-trusted-issue-author` | non | `true` | Exiger que l'auteur de l'issue soit lui aussi de confiance pour que son corps serve de consigne. |
| `no-publish` | non | `false` | Ne rien pousser ni publier : voir [`no-publish` n'est pas un bac à sable](#no-publish-nest-pas-un-bac-à-sable). |
| `aider-call-timeout-minutes` | non | `15` | Durée maximale d'un seul appel à aider, en minutes. Nombre de minutes entre 0 et 1440 ; toute valeur hors de cette plage, 2000 comprise, retombe **silencieusement** sur `15` — elle n'est pas écrêtée à 1440. Avertissement dans les logs seulement. |

## Sorties

| Nom | Description |
| --- | --- |
| `poursuivre` | `"true"` si la garde a autorisé l'exécution, `"false"` sinon. |
| `branche` | Nom de la branche de travail, de la forme `fix-issue-<n>`. |
| `numero-pr` | Numéro de la pull request ouverte, vide si aucune ne l'a été. |
| `iterations` | Nombre de tours de validation effectués. |
| `succes` | `"true"` uniquement si la commande de validation est passée. |

### Choisir `model`

| Valeur | Contexte | Entrée (cache miss) / sortie, par million de jetons |
| --- | --- | --- |
| `deepseek/deepseek-v4-pro` (défaut) | 1 M | 0,66–1,32 $ / 1,98–3,96 $ |
| `deepseek/deepseek-v4-flash` | 1 M | 0,22–0,44 $ / 0,66–1,32 $ |

Tarification DeepSeek au moment de l'écriture. La fourchette basse est le
tarif heures creuses, la fourchette haute le tarif de pointe. **Les heures de
pointe sont 01:00–04:00 et 06:00–10:00 UTC** ; tout le reste est en heures
creuses, à la moitié du tarif de pointe.

`flash` coûte environ trois fois moins cher au jeton, mais dans une boucle
autonome une itération économisée pèse souvent plus que le rabais unitaire —
d'où le défaut sur `pro`.

`deepseek-chat` et `deepseek-reasoner`, les anciens noms de modèle, sont
**retirés de l'API depuis le 2026-07-24, 15:59 UTC**. Un vieux workflow qui les
référence encore ailleurs échouera pour cette raison.

## Fonctionnement

1. **Garde**, à deux étages : `author_association` de l'événement, puis la
   permission effective du compte via l'API (`write`, `maintain` ou `admin`).
   Un événement `edited` qui contenait déjà `@dseek` est refusé (anti-rejeu).
2. **Réaction 👀**, posée après l'autorisation seulement — jamais avant, pour
   ne pas laisser croire qu'une demande refusée sera traitée.
3. **Installation d'aider**, puis établissement de la branche `fix-issue-<n>`
   (nouvelle, ou reprise d'une branche distante existante).
4. **Premier appel à aider**, commit maîtrisé par l'action, push, ouverture de
   la PR. La consigne exacte envoyée à aider est publiée dans la PR.
5. **Boucle validation / correction**, jusqu'à `max-iterations` : la commande
   de validation est lancée **par l'action**, pas par le modèle — il ne décide
   jamais de son propre verdict. En cas d'échec, un nouvel appel à aider reçoit
   les logs et corrige.
6. **Compte rendu final**, sur la PR (ou sur l'issue si aucune PR n'a été
   ouverte) : succès ou échec, nombre d'itérations, cause.

Deux points structurants :

- aider tourne avec `--no-auto-commits` et `--yes-always` : c'est **l'action**
  qui commite, sur une liste de chemins qu'elle a validée — jamais aider
  directement.
- Ce commit passe `--no-verify` : les hooks `pre-commit` du dépôt consommateur
  ne s'exécutent pas dessus. Un linter ou un scanner de secrets local ne voit
  donc pas passer ces commits.

## Sécurité

Cette action fait **exécuter dans le runner du code écrit par un modèle, à
partir d'un texte que n'importe qui peut rédiger.** C'est vrai même quand
seuls des comptes de confiance peuvent déclencher l'action : le déclencheur et
l'auteur de la consigne ne sont pas la même personne.

### Ce que la garde fait, et ce qu'elle ne fait pas

Elle contrôle **qui déclenche**, en deux étages **cumulatifs** : l'association
déclarée par GitHub sur l'événement, **puis obligatoirement** la permission
effective de ce compte sur le dépôt — `write`, `maintain` ou `admin`. Les deux
doivent passer ; le second n'est pas un recours quand le premier échoue. Un refus
au premier étage est définitif, et le second n'est même pas consulté.

Elle ne contrôle **pas** le texte de la consigne. Le corps de l'issue peut
avoir été écrit par quelqu'un d'autre que l'auteur du `@dseek` — c'est le cas
d'usage nominal, pas une anomalie. Un inconnu peut donc glisser une consigne
dans un bloc `<!-- … -->`, invisible dans le rendu GitHub, qu'un mainteneur de
bonne foi fera exécuter en commentant simplement `@dseek`.

Ce que l'action fait contre ça : la consigne est prise en priorité dans le
commentaire de la personne autorisée, le corps de l'issue est fourni comme
donnée délimitée et étiquetée non fiable, les blocs cachés sont retirés, et le
prompt exact du **premier** appel à aider est publié dans la PR pour que le
relecteur voie le texte injecté s'il y en a un. Les consignes de correction des
tours suivants ne le sont pas — elles reprennent le même texte tiers, plus les
logs de la validation. **Aucune de ces mesures n'est une barrière.**
Elles réduisent la probabilité qu'une consigne cachée passe inaperçue ;
aucune ne rend la chose impossible. Le périmètre réel de cette action est :
*tout ce que le job peut faire, l'auteur du texte traité peut le faire.*

**Le cas `CONTRIBUTOR`.** GitHub ne renvoie qu'une seule valeur d'association par
événement, la plus spécifique : un mainteneur qui a déjà commité par le passé se
voit souvent rapporter `CONTRIBUTOR`, pas `OWNER` ni `MEMBER`. Comme les deux
étages sont cumulatifs, il est refusé au premier, et l'action ne fait rien — même
s'il a les pleins droits sur le dépôt.

Le seul moyen de le débloquer est d'ajouter `CONTRIBUTOR` à `allowed-associations`.
Ce n'est pas aussi risqué qu'il y paraît : le second étage reste exigé, donc un
inconnu dont une correction de faute de frappe a été fusionnée un jour est
rapporté `CONTRIBUTOR` **et** n'a que la permission `read` — il est refusé au
second étage. Ce que vous élargissez alors, c'est le premier filtre, pas la porte.

À décider en connaissance de cause : le premier étage est gratuit et non
falsifiable, le second dépend d'un appel à l'API GitHub qui peut échouer — et dans
ce cas l'action refuse, par sécurité.

### Consignes fermes

- **Jamais `pull_request_target`** avec cette action. Elle refuse d'elle-même
  tout événement autre que `issues` et `issue_comment`, mais ne pas s'y fier
  comme unique protection.
- `permissions:` minimal au niveau du workflow, comme dans l'exemple.
- **Aucun autre secret dans l'environnement du job.** L'environnement d'aider est
  une liste blanche, et la clé DeepSeek est la **seule valeur reprise du job** hors de
  cette liste — il la lui faut bien pour appeler l'API. L'action y ajoute aussi des
  variables qu'elle fabrique elle-même : un `HOME` privé au run, les `XDG_*` qui vont
  avec, et deux réglages d'affichage. Le jeton GitHub, lui, ne lui est
  pas transmis. La `validation-command`, elle, ne reçoit ni la clé, ni le jeton, ni
  les jetons OIDC. Mais l'action ne peut rien pour **vos** secrets si vous les
  exposez au job.
- Clé DeepSeek **dédiée** à cette action, avec un **plafond de dépense** côté
  DeepSeek. Obligatoire, pas conseillé : une consigne malveillante ou un bug
  d'aider peuvent multiplier les appels.
- `timeout-minutes` sur le job.
- `persist-credentials: false` sur le checkout.
- **Jamais d'auto-merge, jamais d'approbation automatique.** Protection de
  branche, `CODEOWNERS`, et « require review from code owners » sur la
  branche par défaut.
- Ne pas installer cette action sur un dépôt qui détient des secrets qui
  comptent, ou dont la branche par défaut part en production sans revue
  humaine.

### `no-publish` n'est pas un bac à sable

Le code est écrit dans le checkout du runner, l'action commite en local — aider
tourne toujours en `--no-auto-commits` — et la `validation-command` s'exécute
normalement. Seule la publication (push, PR,
commentaires) disparaît. **Aucun risque de sécurité décrit ci-dessus n'est
atténué par `no-publish`** : c'est une option de test local, pas un mode
d'exécution isolé.

### Deux arbitrages à faire avant d'installer cette action

1. **Le code source part chez DeepSeek** — carte du dépôt et contenu des
   fichiers, à chaque appel. Sur un dépôt privé, c'est un transfert vers un
   tiers hors UE. À valider avant usage, et probablement disqualifiant en
   contexte professionnel réglementé.
2. **L'injection de prompt n'a pas de correctif.** Les mesures ci-dessus
   réduisent la probabilité qu'une consigne cachée aboutisse, jamais la
   possibilité. Posture recommandée : dépôt privé, à faible enjeu, entre
   personnes qui ont déjà le droit d'écriture, sans autre secret dans le job,
   sans auto-merge, avec protection de branche sur la branche par défaut. Sur
   un dépôt public à enjeu, ne pas installer cette action.

## Limites connues

- **La CI de la PR ne démarre pas seule, et parfois pas du tout.** Une PR
  créée avec `GITHUB_TOKEN` produit, pour les workflows déclenchés par
  `pull_request` sur `opened`/`synchronize`/`reopened`, un run en état
  « approval required » : un bandeau apparaît et une personne à droits
  d'écriture doit cliquer « Approve workflows to run ». **Tout autre
  événement ne produit strictement aucun run**, sans bandeau ni bouton — une
  CI sur `on: push` ne démarrera jamais sur ces commits. Le contournement par
  jeton personnel (PAT) est à **déconseiller franchement** : un PAT porteur du
  scope `workflow` rend inopérant le refus des chemins de workflow de cette
  action ; les événements produits par un PAT déclenchent les workflows,
  donc le garde-fou anti-récursion de GitHub disparaît ; et un PAT classique
  donne accès à tous les dépôts de son porteur. Si un contournement est
  nécessaire, préférer un jeton d'installation de GitHub App restreint à ce
  dépôt, avec `contents:write`, `pull-requests:write`, `issues:write` et
  **sans** `workflows`.

- **`no-publish` n'est pas un bac à sable**, voir plus haut : à retenir
  spécifiquement si vous comptiez vous en servir comme isolation.

- **Certains chemins sont hors de portée de l'action.** Elle refuse d'écrire
  dans les fichiers exécutés ou interprétés automatiquement : répertoires de
  workflows et d'actions GitHub, configurations d'autres CI, hooks git,
  `action.yml`, `CODEOWNERS`, `package.json` et ses lockfiles, fichiers de
  configuration d'aider, et plusieurs autres — la liste vit dans
  `scripts/lib/chemins.js`. Elle **n'est pas exhaustive et ne peut pas
  l'être** : un code malveillant dans un fichier source ordinaire reste
  possible. C'est la relecture humaine du diff qui protège, pas cette liste.

  Elle ne couvre pas non plus les fichiers **ignorés par git** : la liste travaille
  sur ce que `git status` rapporte, et un fichier ignoré n'y figure pas.

  Deux cas distincts, souvent confondus. Un `.aider.conf.yml` ou un `.env`
  **versionné** dans votre dépôt **est lu par aider** : les fichiers de
  configuration livrés par l'action gagnent clé par clé, mais une clé qu'ils ne
  fixent pas retombe sur la vôtre. C'est votre choix versionné, l'action ne le
  défait pas. Un `.aider.conf.yml` ou un `.aider.model.metadata.json` **non suivi**
  est en revanche supprimé avant chaque appel, et un `.env` **non suivi** est
  déplacé le temps de l'appel puis remis en place — sauf si cette mise à l'abri
  échoue, cas où l'action vous avertit explicitement que le fichier sera lu.

- **Changer `aider-version` installe 107 paquets tiers** dans votre runner.
  C'est un changement de posture de sécurité, pas une mise à jour de
  routine : il oblige aussi à revérifier `aider-models.json`, embarqué par
  l'action pour décrire des modèles que la version épinglée d'aider ne
  connaît pas nativement.

- **Le compte rendu de secours porte un marqueur invisible**, lié au run en
  cours (identifiant et numéro de tentative). Un commentaire tiers qui
  imiterait ce marqueur pour la portée du run courant ferait taire le filet
  de sécurité qui publie un compte rendu quand le job meurt sans conclure
  normalement. Le coût, dans ce cas, est un commentaire de courtoisie perdu
  sur un job déjà rouge — le job reste rouge, l'information n'est simplement
  pas répétée en commentaire.

- **Le code source part chez DeepSeek**, voir la section Sécurité.

- **Ce qui est public sur un dépôt public.** Les logs du job ne portent pas le prompt :
  l'action le remplace par `<consigne de N caractères>`. La carte du dépôt, elle, n'y
  est jamais écrite du tout. En revanche le prompt du premier appel est **publié dans la pull
  request**, donc lisible de tous, et les logs portent la sortie d'aider, masquée et
  bornée mais issue d'un traitement du texte tiers.

- **Les hooks git du consommateur sont contournés.** L'action commite avec
  `--no-verify` ; un `pre-commit` qui lint ou cherche des secrets ne
  s'exécute pas sur ces commits.

- **Une seule PR par issue.** Un `@dseek` sur une issue qui a déjà une PR
  ouverte ne fait rien. Une branche `fix-issue-<n>` restée sur le remote sans
  PR est réutilisée.

- **Le nom du premier test en échec est publié, et c'est un canal résiduel.** Chaque
  commentaire d'itération porte le code de sortie et le nom du premier test en échec,
  jamais la sortie brute. Ce nom est masqué et borné, mais il est produit par du code
  que le modèle vient d'écrire : un secret découpé en deux morceaux sur deux
  itérations échappe au masquage, qui travaille motif par motif. Deux itérations
  suffisent. Le même commentaire publie aussi les **chemins refusés** du tour, choisis
  par le modèle et bornés : même canal, même faille en deux temps. C'est le prix d'un compte rendu exploitable ; il n'y a pas de correctif,
  seulement le fait de le savoir.

- **La `validation-command` peut réécrire les fichiers de l'action.** Elle tourne avec
  les droits du runner, donc `$GITHUB_ACTION_PATH` lui est accessible en écriture. La
  configuration d'aider est protégée — l'action la matérialise à chaque appel depuis
  une copie lue au démarrage — mais un step ultérieur du même job qui relirait un
  fichier de l'action n'a pas cette garantie. Sur un dépôt où ce risque compte,
  exécuter l'action dans un job dédié, sans autre secret que le sien.

- **La carte du dépôt est reconstruite à chaque tour.** Avant chaque validation,
  l'action retire les `.aider*` non suivis de la racine du checkout, parce qu'une
  commande de test qui globe peut les ramasser. Le cache de la carte du dépôt en fait
  partie : sur un gros dépôt, chaque tour paie donc la reconstruction. C'est un coût
  de temps, pas un défaut.

- **La garde ne filtre pas le type d'action de l'événement**, hors le cas `edited`.
  Un événement `issues` de type `closed`, `labeled` ou `reopened` dont le corps
  contient déjà `@dseek` relance un cycle complet. Le seul filtre est le `types:` de
  votre workflow — c'est une raison de plus de recopier l'exemple tel quel : un
  `on: issues` nu paierait un appel DeepSeek à chaque changement d'étiquette — tant
  qu'aucune pull request n'est ouverte sur la branche, du moins : dès qu'il y en a une,
  la garde refuse avant tout appel.

- **Un force-push sur `fix-issue-<n>` pendant un run fait échouer l'action.** Entre
  deux runs, il n'y a pas de problème : le runner est neuf, l'action rapatrie la
  branche telle qu'elle est et repart de votre histoire réécrite. Mais si la branche
  est force-poussée **après** que le run a démarré, le bail de l'action est périmé :
  son push simple est refusé en non-fast-forward, son `--force-with-lease` l'est en
  `stale info` — jamais `--force`, à dessein — et le job tombe en panne. Relancer avec
  un nouveau `@dseek` suffit.

- **`ubuntu-24.04` requis.** Sur un runner auto-hébergé, macOS ou Windows,
  `pipx` peut être absent ; l'action le signale explicitement plutôt que
  d'échouer de façon opaque.

## Développement

```bash
# syntaxe — un appel par fichier
find scripts test -name '*.js' -print0 | xargs -0 -n1 node --check

# les suites du dépôt, hors ligne, sans clé API ni réseau
for suite in test/*.test.js; do node "$suite"; done
```

La forme `find … -exec node --check {} \;` est volontairement évitée : un code
de sortie non nul de `node --check` sur un fichier cassé n'est pas remonté par
`find` comme une erreur, donc cette forme rend `0` même quand un script est
syntaxiquement invalide. `xargs -0 -n1` fait un appel par fichier et remonte
correctement l'échec. Le workflow `.github/workflows/test.yml` du dépôt utilise
la même forme `xargs` ; les deux doivent rester d'accord.

Les suites sont lancées par un glob sur `test/*.test.js`, pas par une liste de
noms : une suite ajoutée est ainsi exercée sans qu'il faille penser à la
déclarer ici.

La CI installe aussi `actionlint`, condensat épinglé, pour valider
`.github/workflows/**`. Ne **jamais** le lancer sur `action.yml` : il le lit
comme un fichier de workflow et rend des erreurs qui n'ont pas de sens pour
une action composite.

### Structure

| Chemin | Rôle |
| --- | --- |
| `action.yml` | Métadonnées, entrées, sorties et steps de l'action composite. |
| `aider.conf.yml` | Configuration d'aider maîtrisée par l'action, hors d'atteinte du modèle. |
| `aider-models.json` | Métadonnées des modèles DeepSeek pour aider. |
| `scripts/` | Garde, orchestration et compte rendu, plus leurs bibliothèques partagées. |
| `__fixtures__/` | Payloads d'événements et stubs (`aider`, `gh`) pour les tests hors ligne. |
| `test/` | Suites de test, lancées par `node test/<nom>`. Pas une par fichier : `scripts/lib/git.js` et `scripts/lib/gh.js` sont exercés à travers `test/boucle.test.js`. |
| `.github/workflows/test.yml` | CI : syntaxe, suites, montage de l'action. |
| `plan/` | Documents de conception du projet. |
