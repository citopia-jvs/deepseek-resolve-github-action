# Lot 6 — Réécriture du `README.md`

**Dépend de** : lot 4 (la liste définitive des inputs). Parallélisable avec le lot 7.

## Pourquoi une réécriture et non une mise à jour

Le `README.md` actuel est aligné sur un plan abandonné. Il décrit en détail une
architecture qui n'existera plus :

- une section « Fonctionnement » construite autour des deux prompts *réflexion* et
  *correction* et d'un JSON `{chemin: contenu}` ;
- une section « Coût et limites » dont les quatre points portent sur des défauts que le
  passage à aider supprime ;
- une section « Développement » qui documente `npm install` et une simulation `INPUT_*`
  qui ne s'appliquent pas à une composite action ;
- un tableau « Structure » listant les fichiers de `src/`, supprimés au lot 0 ;
- une section « État du projet » dont les cinq cases sont caduques.

Ne pas rapiécer : repartir d'un plan neuf.

Le dépôt s'appelle **`citopia-jvs/deepseek-resolve-github-action`**. La version
précédente de ce plan écrivait `<owner>/deepseek-resolve` dans son exemple — un agent
sans contexte aurait recopié l'erreur.

## Structure visée

### En-tête

Ce que fait l'action, en trois phrases. Dire d'emblée qu'elle **pilote aider** avec un
modèle DeepSeek : un lecteur qui cherche une action « API DeepSeek brute » doit
comprendre tout de suite que ce n'en est pas une.

Retirer l'avertissement « projet en cours de développement » quand le bout en bout du
plan maître est vert.

### Utilisation

Exemple de workflow consommateur complet, copiable tel quel.

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

Cinq points de l'exemple ont changé par rapport à la version précédente du plan, et
chacun mérite une phrase d'explication dans le README :

- **`actions/checkout@v5`**, pas `@v4`. `v4` déclare `using: node20`, et Node 20 est
  retiré des runners le 2026-09-16. Publier un README neuf sur `@v4` serait un
  contresens.
- **`persist-credentials: false`.** Avec le défaut `true`, un jeton en écriture est écrit
  dans `.git/config` et devient lisible par n'importe quel code exécuté dans le
  checkout — y compris celui que le modèle vient d'écrire. L'action authentifie son push
  elle-même, donc elle fonctionne dans les deux cas.
- **`runs-on: ubuntu-24.04`** en dur. `ubuntu-latest` basculera sur 26.04, dont le
  Python 3.14.4 est hors de la borne `<3.13` d'aider.
- **`concurrency`.** Deux `@dseek` rapprochés donnent deux jobs qui créent la même
  branche. La garde n'est pas un verrou : la PR n'existe que plusieurs minutes après le
  démarrage. `concurrency` n'existe pas dans une composite action, donc c'est
  obligatoirement ici.
- **`types: [opened]` / `[created]` seulement**, pas `edited`. Sinon rééditer un vieux
  commentaire contenant `@dseek` relance un cycle complet. L'action se défend aussi
  côté garde, mais autant ne pas déclencher le job.

À dire aussi :

- `actions/checkout` est **obligatoire** : aider travaille dans le checkout du runner.
- `timeout-minutes` est le vrai garde-fou de coût, plus fiable que `max-iterations`
  seul — qui borne le nombre d'appels, pas leur taille.
- Si `validation-command` a besoin de dépendances installées (`npm ci`, `setup-node`),
  ces steps vont **avant** l'action.
- **Ne jamais interpoler de contexte GitHub dans `validation-command`.** Un
  `npm test -- --grep "${{ github.event.issue.title }}"` est une injection de script.

### Inputs et outputs

Les treize inputs et les cinq outputs, tels qu'arrêtés au lot 4. Les comparer ligne à
ligne avec `action.yml` : c'est la divergence la plus courante entre un README et une
action.

Pour `model` :

| Valeur | Contexte | Entrée (cache miss) / sortie par M de jetons |
| --- | --- | --- |
| `deepseek/deepseek-v4-pro` (défaut) | 1 M | 0,66–1,32 $ / 1,98–3,96 $ |
| `deepseek/deepseek-v4-flash` | 1 M | 0,22–0,44 $ / 0,66–1,32 $ |

La fourchette vient de la tarification DeepSeek. **Les heures de pointe sont
01:00–04:00 et 06:00–10:00 UTC ; tout le reste est en heures creuses**, à la moitié du
tarif de pointe. La version précédente de ce plan avait inversé les deux.

`flash` coûte environ trois fois moins cher, mais dans une boucle autonome une itération
économisée vaut souvent plus que le rabais unitaire — d'où le défaut sur `pro`.

Mentionner que `deepseek-chat` et `deepseek-reasoner` sont **retirés depuis le
2026-07-24** : un utilisateur qui a un vieux workflow ailleurs cherchera pourquoi.

### Fonctionnement

La séquence réelle : garde (deux étages) → réaction 👀 → installation d'aider → branche
→ premier appel aider → commit maîtrisé → push et PR → boucle validation / correction →
compte rendu.

Deux points à souligner :

- La validation est lancée **par l'action**, pas par le modèle : il ne décide pas de son
  propre verdict.
- L'action commite elle-même, sur une liste de chemins qu'elle a validée. aider tourne
  avec `--no-auto-commits`.

### Sécurité

Section à part entière, pas une note en bas de page. Dire franchement ce que fait cette
action : **elle fait exécuter dans le runner du code écrit par un modèle, à partir d'un
texte que n'importe qui peut rédiger.**

#### Ce que la garde fait, et ce qu'elle ne fait pas

Elle contrôle **qui déclenche**, en deux étages : `author_association` puis la permission
effective par l'API (`write`, `maintain` ou `admin`).

Elle ne contrôle **pas** le texte de la consigne. Le corps de l'issue peut avoir été
rédigé par quelqu'un d'autre que l'auteur du `@dseek` — c'est le cas d'usage nominal. Un
inconnu peut donc glisser une consigne dans un bloc `<!-- … -->`, invisible dans le
rendu GitHub, qu'un mainteneur de bonne foi fera exécuter en commentant `@dseek`.

Ce que l'action fait contre ça : la consigne est prise dans le commentaire autorisé, le
corps de l'issue est passé en données délimitées et étiquetées non fiables, les blocs
cachés sont retirés, et le prompt exact est publié dans la PR pour que le relecteur voie
le texte injecté. **Aucune de ces mesures n'est une barrière** — elles réduisent la
probabilité, jamais la possibilité.

Ne pas ajouter `CONTRIBUTOR` à `allowed-associations`. GitHub ne renvoie qu'une seule
association, donc un mainteneur légitime qui a déjà commité est rapporté `CONTRIBUTOR` et
se fait refuser à l'étage 1. Le réflexe naturel est d'élargir la liste — et la porte
s'ouvre alors à quiconque a fait fusionner une correction de faute de frappe. La bonne
réponse à ce symptôme est l'étage 2, qui est déjà là.

#### Consignes fermes

- **Jamais `pull_request_target`** avec cette action. Elle refuse d'elle-même tout
  événement autre que `issues` et `issue_comment`, mais ne pas s'y fier.
- `permissions:` minimal, comme dans l'exemple.
- **Aucun autre secret dans l'environnement du job.** L'action retire ses propres secrets
  de l'environnement de la `validation-command`, mais elle ne peut rien pour les vôtres.
- Clé DeepSeek **dédiée**, avec **plafond de dépense** côté DeepSeek. Obligatoire, pas
  conseillé.
- `timeout-minutes` sur le job.
- `persist-credentials: false` sur le checkout.
- **Jamais d'auto-merge**, jamais d'approbation automatique. Protection de branche +
  `CODEOWNERS` + « require review from code owners » sur la branche par défaut.
- Ne pas installer cette action sur un dépôt qui détient des secrets qui comptent, ou
  dont la branche par défaut part en production.

#### `no-publish` n'est pas un bac à sable

En gras. Le code est écrit dans le checkout, aider commite en local, et la
`validation-command` s'exécute. Seule la publication disparaît. Aucun risque de sécurité
n'est atténué.

### Limites connues

- **La CI de la PR ne démarre pas seule, et parfois pas du tout.** Une PR créée avec
  `GITHUB_TOKEN` produit un run `pull_request` en état « approval required » pour
  `opened`/`synchronize`/`reopened` : un bandeau apparaît et un humain à droits
  d'écriture doit cliquer « Approve workflows to run ». **Tout autre événement ne produit
  aucun run** — une CI sur `on: push` ne démarrera pas, sans bandeau ni bouton.

  Et avec `max-iterations: 5`, chaque push produit un `synchronize`, donc six runs en
  attente d'approbation.

  Le contournement par PAT est à **déconseiller franchement**, avec ses trois
  conséquences : un PAT porteur du scope `workflow` rend inopérant le refus des chemins
  de workflow ; les événements produits par un PAT déclenchent les workflows, donc le
  garde-fou anti-récursion de GitHub disparaît ; et un PAT classique donne accès à tous
  les dépôts de son porteur. Si contournement il faut, un jeton d'installation de GitHub
  App restreint à ce dépôt, avec `contents:write`, `pull-requests:write`, `issues:write`
  et **sans** `workflows`.

- **Certains chemins sont hors de portée.** L'action refuse d'écrire dans les fichiers
  exécutés automatiquement : workflows, `action.yml`, `CODEOWNERS`, `package.json` et
  lockfiles, `Makefile`, `conftest.py`, `.husky/**`, configs d'autres CI, fichiers de
  configuration d'aider. La liste complète est dans le code. Elle **n'est pas
  exhaustive** et ne peut pas l'être : un backdoor dans un fichier source ordinaire reste
  un backdoor. C'est la relecture humaine qui protège.

- **Le nom du premier test en échec est publié, et c'est un canal résiduel.** Chaque
  commentaire d'itération contient le code de sortie et le nom du premier test en échec
  — jamais la sortie brute. Ce nom est masqué et borné, mais il est écrit par du code
  que le modèle vient de produire : un secret découpé en deux morceaux sur deux
  itérations échappe au masquage, qui travaille motif par motif. Deux itérations
  suffisent. C'est le prix d'un compte rendu exploitable ; il n'y a pas de correctif,
  seulement le fait de le savoir.

- **Le code exécuté par `validation-command` peut réécrire les fichiers de l'action.**
  Il tourne avec les droits du runner, donc `$GITHUB_ACTION_PATH` lui est accessible en
  écriture. La configuration d'aider est protégée — l'action la matérialise à chaque
  appel depuis une copie lue au démarrage — mais un step ultérieur du même job qui
  relit un fichier de l'action n'a pas cette garantie. Sur un dépôt où ce risque
  compte, exécuter l'action dans un job dédié, sans autre secret que le sien.

- **La carte du dépôt est reconstruite à chaque itération.** Avant chaque validation,
  l'action retire les `.aider*` non suivis de la racine du checkout, parce qu'une
  commande de test qui globe peut les ramasser. Le cache de la carte du dépôt
  (`.aider.tags.cache.*`) en fait partie : sur un gros dépôt, chaque tour paie donc la
  reconstruction. C'est un coût de temps, pas un défaut.

- **La liste ne couvre pas les fichiers ignorés par git, et aider lit la
  configuration versionnée du dépôt.** `git status` ne montre pas les fichiers
  ignorés, donc la liste de chemins interdits ne les voit pas. Pour les cibles de
  configuration d'aider, l'action compense : avant chaque appel, elle supprime un
  `.aider.conf.yml` ou un `.aider.model.metadata.json` **non suivi** à la racine du
  checkout, et déplace un `.env` **non suivi** le temps de l'appel avant de le
  remettre en place. Si votre workflow crée un `.env` avant d'appeler l'action, il
  est bien restauré pour la commande de validation.

  En revanche, un `.aider.conf.yml` ou un `.env` **versionné** dans votre dépôt est
  lu par aider : les fichiers livrés par l'action gagnent clé par clé, mais une clé
  qu'ils ne fixent pas retombe sur la vôtre. C'est votre choix versionné, l'action ne
  le défait pas.

- **Le code source part chez DeepSeek** — carte du dépôt et contenus de fichiers, à
  chaque appel. Sur un dépôt privé, c'est un transfert vers un tiers hors UE. À valider
  avant usage, et probablement disqualifiant en contexte professionnel.

- **Les logs du job sont publics sur un dépôt public**, et contiennent le prompt (donc le
  texte du tiers) et la carte du dépôt.

- **Les hooks git du consommateur sont contournés.** aider commite avec `--no-verify`
  (défaut de `--git-commit-verify`), et l'action fait de même. Un `pre-commit` qui lint ou
  qui cherche des secrets ne s'exécute pas sur ces commits.

- **Changer `aider-version` installe 301 paquets tiers** dans votre runner. C'est un
  changement de sécurité, pas une mise à jour de routine.

- **Une seule PR par issue.** Un `@dseek` sur une issue qui a déjà une PR ouverte ne fait
  rien. Une branche restée sur le remote sans PR est réutilisée.

- **La garde ne filtre pas le type d'action de l'événement**, hors le cas `edited`
  (anti-rejeu, R10). Un événement `issues` d'action `closed`, `labeled` ou `reopened`
  dont le corps contient déjà `@dseek` relance donc un cycle complet. Le seul filtre est
  le `types:` du workflow consommateur — c'est une raison de plus de recopier l'exemple
  tel quel, avec ses `types: [opened]` et `types: [created]` : un `on: issues` nu
  paierait un cycle DeepSeek à chaque changement d'étiquette. Constat remonté par
  l'exécutant du lot 2, arbitré en gardant la garde neutre : une liste blanche de valeurs
  `payload.action` en dur dans le script vieillirait moins bien que la déclaration du
  workflow.

- **Une branche `fix-issue-<n>` force-poussée à la main entre deux runs bloque la
  reprise.** L'action rapatrie la branche existante sans forcer, délibérément : elle
  échoue en non-fast-forward plutôt que d'écraser en silence le travail poussé par
  quelqu'un d'autre. Supprimer la branche, ou fermer et rouvrir l'issue avec une
  branche propre.

- **`ubuntu-24.04` requis.** Sur un runner auto-hébergé, macOS ou Windows, `pipx` peut
  être absent ; l'action le signale explicitement.

### Développement

Remplacer entièrement l'ancienne section. Plus de `npm install`, plus de dépendances,
plus de build.

```bash
# syntaxe
find scripts test -name '*.js' -exec node --check {} \;

# la garde, sans réseau ni token
node test/garde.test.js

# la boucle, sans clé API
node test/boucle.test.js
```

Et le tableau de structure : `action.yml`, `aider.conf.yml`, `aider-models.json`,
`scripts/`, `__fixtures__/`, `test/`.

## Vérification

- Aucune mention subsistante de `src/`, `npm install`, `axios`, `@actions/*`, `ncc`,
  `dist/`, `deepseek-chat`, `dry-run`, ni des prompts « réflexion / correction ».
- L'exemple de workflow passe `actionlint` et fonctionne sur un dépôt de test.
- Le tableau des inputs correspond **exactement** à `action.yml`, ligne à ligne.
- Le nom du dépôt est bien `citopia-jvs/deepseek-resolve-github-action`.
- Les heures de pointe sont bien 01:00–04:00 et 06:00–10:00 UTC.
