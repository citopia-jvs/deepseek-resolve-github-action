# Plan : composite action pilotant aider

Document maître. Lire [`contrat.md`](contrat.md) juste après, avant tout lot : il
tient les noms et les versions. Chaque lot est détaillé dans son propre fichier et
rédigé pour être exécutable par un agent qui n'a pas suivi la discussion.

## Intention

Garder l'ergonomie du projet — `@dseek` dans une issue ou un commentaire → branche
→ Pull Request → boucle bornée jusqu'à ce que la validation passe, comptes rendus
en français — et **cesser d'écrire la boucle d'agent nous-mêmes**.

L'action devient une *composite action* qui pilote
[aider](https://github.com/Aider-AI/aider) en sous-processus.

Cette intention n'a pas changé depuis la première version du plan. Tout le reste,
oui.

## Pourquoi ne pas terminer le code actuel

`src/` contient une boucle d'agent maison qui ne démarre pas : `github-client.js`
exporte cinq fonctions absentes du fichier, `iteration.js` et `utils.js` sont vides.
Au-delà de l'inachèvement, trois défauts sont structurels :

| Défaut | Emplacement |
| --- | --- |
| Le contenu intégral de tous les fichiers part dans chaque prompt | `getRepoFiles` + `buildReflectionPrompt` / `buildCorrectionPrompt` |
| Les commits passent par l'API GitHub, la validation tourne sur le checkout du runner — le code testé n'est jamais le code commité | `commitChanges` vs `execCommand` |
| Le patch est extrait par `response.match(/\{[\s\S]*\}/)`, greedy, et autorise l'écriture de chemins arbitraires | `parseChanges` |

Corriger ces trois points revient à réécrire une boucle d'agent complète. aider le
fait déjà : repo map au lieu du dépôt entier, git natif dans le checkout,
application de patch par diff.

## Ce que le passage en composite supprime

Plus de `@actions/*`, plus d'`axios`, plus de `node_modules`, plus de bundling
`@vercel/ncc`, plus de `dist/` à committer, plus de `using: node16` déprécié.
Les scripts d'orchestration restent en Node — **stdlib seule** — et n'utilisent que
la CLI `gh` déjà présente sur les runners.

## Décisions actées

1. `src/` supprimé en entier. Plus de JS action.
2. La boucle de validation est pilotée par l'action, **pas** par `--auto-test`
   d'aider : `max-iterations` doit rester effectif et on veut un commentaire de PR
   par itération.
3. Garde d'autorisation obligatoire, en **deux étages** : `author_association` du
   payload comme pré-filtre gratuit, puis la permission effective par l'API.
4. **`--no-auto-commits`** : l'action commite elle-même, sur une liste de chemins
   qu'elle a validée. Voir R3 et R8.
5. **La configuration d'aider est fournie par l'action**, jamais lue depuis le dépôt
   consommateur. Voir R8.
6. Runner **`ubuntu-24.04` en dur**, Python **3.12** par `actions/setup-python`.
   Voir R11.

## Faits vérifiés

Relevés en lisant la source, le wheel PyPI ou la documentation. Chacun a été
recontrôlé lors de la révision du plan ; les dates comptent.

| Fait | Comment il a été vérifié |
| --- | --- |
| `aider-chat` dernière version = **0.86.2**, publiée **2026-02-12**. 174 releases, rien depuis six mois | `pypi.org/pypi/aider-chat/json` |
| `aider-chat 0.86.2` déclare `requires_python = "<3.13,>=3.10"` et épingle ses dépendances en `==`, dont `litellm==1.81.10` | idem |
| **`litellm 1.81.10` ne connaît aucun modèle DeepSeek V4** : sa table ne contient que `deepseek-chat`, `deepseek-reasoner`, `deepseek-coder`, `deepseek-r1`, `deepseek-v3`, `deepseek-v3.2` | wheel `litellm-1.81.10-py3-none-any.whl`, `model_prices_and_context_window_backup.json` |
| `aider/resources/model-metadata.json` de 0.86.2 ne déclare côté DeepSeek que `deepseek/deepseek-reasoner` et `deepseek/deepseek-chat` | wheel `aider_chat-0.86.2-py3-none-any.whl` |
| **`deepseek-chat` et `deepseek-reasoner` sont retirés depuis le 2026-07-24.** L'API n'expose plus que `deepseek-v4-flash` (V4-Flash-0731) et `deepseek-v4-pro` (V4-Pro-0813), 1 M de contexte, 384 K de sortie max | `api-docs.deepseek.com/updates/` et `/quick_start/pricing` |
| Tarifs `deepseek-v4-pro` : entrée cache miss 0,66 $ creux / 1,32 $ pointe par M ; sortie 1,98 $ / 3,96 $. **Heures de pointe : 01:00–04:00 et 06:00–10:00 UTC**, tout le reste est en heures creuses | page tarifs DeepSeek |
| `--model-metadata-file` existe en 0.86.2 (`args.py:127`, défaut `.aider.model.metadata.json`) | wheel aider |
| Défauts de flags en 0.86.2 : `--gitignore` **True**, `--auto-commits` **True**, `--dirty-commits` **True**, `--auto-lint` **True**, `--suggest-shell-commands` **True**, `--show-model-warnings` **True**, `--git-commit-verify` **False** | `args.py:411,440,446,543,807,207,492` |
| `--config` est cherché dans le **git root**, `--env-file` vaut `.env` du **git root** | `args.py:790,801` |
| `--yes-always` **refuse** les commandes shell suggérées par le modèle : `base_coder.py:2459` passe `explicit_yes_required=True`, et `io.py:866-867` fait `res = "n"` dans ce cas | wheel aider |
| Ubuntu 24.04 (= `ubuntu-latest` aujourd'hui) : Python **3.12.3**, pipx 1.16.6, Node 22, `gh` 2.97.0, git 2.54.0. Ubuntu 26.04 (aperçu) : Python **3.14.4** — **hors de la borne d'aider** | readmes `actions/runner-images` |
| `GITHUB_ACTION_PATH` vaut `GITHUB_WORKSPACE` quand l'action est référencée en `uses: ./`, et `_actions/<owner>/<repo>/<ref>` sinon | `ActionManager.cs:697-718`, branche `SelfAlias` |
| `shell:` est obligatoire sur chaque `run` step d'une composite ; `continue-on-error` et `working-directory` sont acceptés ; **`timeout-minutes`, `concurrency`, `pre:` et `post:` ne le sont pas** | `action_yaml.json` du runner |
| Les inputs d'une composite ne sont **pas** exposés en `INPUT_*` aux sous-processus | doc metadata-syntax + ADR 1144 |
| Une PR créée avec `GITHUB_TOKEN` produit un run `pull_request` en état « approval required » pour `opened`/`synchronize`/`reopened` uniquement. **Tout autre événement ne produit aucun run** — une CI sur `on: push` ne démarre pas du tout, sans bandeau ni bouton | doc GITHUB_TOKEN |
| `author_association` n'est **pas** une permission : `MEMBER` = membre de l'organisation propriétaire, sans accès garanti au dépôt ; `COLLABORATOR` inclut `read` et `triage`. Et GitHub ne renvoie qu'**une seule** valeur, donc un membre ayant déjà commité est rapporté `CONTRIBUTOR` | enum GraphQL `CommentAuthorAssociation` + actions/github-script#643 |
| `git rev-list --count <base>..HEAD` est exact dans un clone `--depth=1`, et `git push` depuis un clone shallow passe | reproduit en local |
| Ce dépôt n'a **aucun tag** : `git tag` est vide. Donc aucun utilisateur à migrer | `git tag` |
| Le remote est `citopia-jvs/deepseek-resolve-github-action` | `git remote -v` |

## Risques

Douze. Les quatre premiers étaient déjà là ; R2 a été **corrigé** ; les huit autres
sont apparus à la révision. Chaque lot concerné les rappelle.

### R1 — Sans identité git, aider plante · lot 3a

`aider/repo.py:291` fait `original_user_name = self.repo.git.config("--get", "user.name")`
**hors** du `try` ouvert ligne 296. `git config --get` sur une clé absente sort en
code 1, GitPython lève un `GitCommandError` non rattrapé. `actions/checkout` ne
configure ni `user.name` ni `user.email`. Le premier commit d'aider plante le job.

### R2 — Commit non maîtrisé — *portée corrigée* · lot 3b

**La version précédente de ce plan se trompait.** Elle affirmait qu'aider commite
par `git commit -a` et balaie donc tous les artefacts de test. Vérification faite,
les deux seuls appelants passent une liste de fichiers :

```python
base_coder.py:2383   self.repo.commit(fnames=edited, aider_edits=True, coder=self)
base_coder.py:2419   self.repo.commit(fnames=self.need_commit_before_edits, coder=self)
```

et `need_commit_before_edits` n'est rempli que par `check_for_dirty_commit(path)`,
appelé chemin par chemin sur les fichiers qu'aider s'apprête à éditer
(`base_coder.py:2175-2189`). La branche `cmd += ["-a"]` de `repo.py:289` est morte
dans ce flux.

Le risque réel est plus étroit, et il subsiste : `--dirty-commits` vaut `True`, donc
si la `validation-command` modifie un fichier **qu'aider s'apprête ensuite à
éditer**, les modifications des tests partent dans le commit d'aider. Cas typique :
un snapshot que les tests réécrivent et que le modèle veut corriger.

Le traitement est de toute façon le même que pour R3 : `--no-auto-commits`, et
l'action commite elle-même sur une liste de chemins validée.

### R3 — `.github/workflows/**` fait échouer le push, et restaurer ne suffit pas · lot 3b

Le `GITHUB_TOKEN` n'a pas le droit `workflows`. Message serveur :
`refusing to allow a GitHub App to create or update workflow '<fichier>' without 'workflows' permission`.

Piège de conception que le plan précédent avait : avec `--auto-commits` (défaut
`True`), le chemin fautif est **déjà commité** quand on le détecte. Le restaurer
crée un commit de plus, mais le commit fautif reste dans l'ensemble poussé, et le
refus serveur porte sur les commits poussés. Le push échoue quand même — après avoir
consommé toutes les itérations et l'argent.

D'où `--no-auto-commits` (décision 4) : on stage explicitement, donc rien d'interdit
n'entre jamais dans un commit.

### R4 — Le cas « aider ne commite rien » · lot 3c

Modèle qui refuse, rien à changer, édition échouée : `git push` ne pousse rien puis
`gh pr create` échoue sur « No commits between ». À détecter par
`git rev-list --count <base>..HEAD`.

### R5 — Dépendance amont non maîtrisée · contrat + lot 4

aider est figé depuis six mois et son litellm épinglé ignore la gamme DeepSeek
actuelle, dont l'ancienne moitié est retirée. Conséquence : **il n'existe aucun
modèle valide que la version épinglée d'aider connaisse**. Sans traitement, aider
démarre sur des métadonnées inconnues — fenêtre de contexte de repli au lieu de 1 M,
`--map-tokens` budgété contre la mauvaise borne, format d'édition non informé — voire
refuse de démarrer (`--show-model-warnings` vaut `True`).

Traitement : l'action embarque `aider-models.json` et passe
`--model-metadata-file "$GITHUB_ACTION_PATH/aider-models.json"`. Ce n'est pas un
contournement provisoire : c'est la façon prévue par aider de décrire un modèle
qu'il ne connaît pas. Corollaire de maintenance : monter `aider-version` est un acte
délibéré qui demande de revérifier ce fichier.

**Ce risque touche la prémisse du plan, pas seulement son implémentation.** L'argument
fondateur est « aider fait déjà ce travail, mieux ». Il tient aujourd'hui. Mais aider
n'a rien publié depuis six mois et son litellm épinglé ignore la gamme DeepSeek en
service : nous compensons déjà par une cale de compatibilité. Si l'amont reste figé,
d'autres cales suivront, et l'argument s'érodera. Point de contrôle à se donner : au
moment de monter `aider-version`, si la montée demande **plus** qu'une régénération
d'`aider-models.json`, rouvrir la question du choix d'aider plutôt que d'empiler.

### R6 — La garde protège le déclencheur, pas la consigne · lots 2 et 3b

**Le risque le plus important, et il était absent du plan précédent.**

La garde vérifie qui écrit `@dseek`. Or la consigne envoyée à aider contient le
**corps de l'issue**, rédigé par quelqu'un d'autre — et c'est le cas d'usage
nominal. Scénario, sans aucun contournement de la garde :

1. Un inconnu ouvre une issue crédible, avec en fin de corps un bloc
   `<!-- … -->`, invisible dans le rendu GitHub, qui donne une consigne à l'agent.
2. Un mainteneur lit l'issue rendue, la trouve légitime, commente `@dseek`.
3. `author_association` du commentaire vaut `OWNER` → la garde autorise. Elle a fait
   exactement son travail.
4. aider suit la consigne cachée. Le code produit est ensuite **exécuté** par la
   `validation-command`.

Le plan précédent écrivait que la garde était « la seule chose qui sépare l'action
d'une porte ouverte ». C'était faux, et coûteux : la phrase clôturait la réflexion.

L'injection de prompt **n'a pas de correctif**. Le lot 2 et le lot 3b réduisent la
surface (consigne prise dans le commentaire autorisé, corps de l'issue passé en
données délimitées, blocs cachés retirés, prompt exact publié dans la PR). Le
périmètre réel reste : *tout ce que le job peut faire, l'auteur du texte traité peut
le faire.*

### R7 — Les secrets du job sont accessibles au code écrit par le modèle · lots 3b et 4

`spawn(cmd, { shell: true })` hérite de `process.env`, donc de `DEEPSEEK_API_KEY` et
`GH_TOKEN`. Tous les chemins d'exécution le voient : la `validation-command`, un
`postinstall` d'un `package.json` réécrit, un `conftest.py`, un `Makefile`, un hook
`.husky/*`. Les runners GitHub n'ont aucun filtrage de trafic sortant.

Et le canal d'exfiltration le plus fiable ne demande **aucun** trafic sortant : les
logs de validation sont réinjectés dans le prompt, un extrait est publié en
commentaire de PR, et les logs du job sont publics sur un dépôt public.

`::add-mask::` ne protège pas de ça : il remplace l'occurrence littérale exacte dans
l'affichage. Il ne voit ni un base64, ni un jeton coupé en deux.

Traitement : environnement filtré explicitement pour la validation **et** pour aider
(qui n'a jamais besoin de `GH_TOKEN`) ; aucun log brut recopié en commentaire ;
filtre de motifs de secrets sur tout ce qui part en commentaire ou en prompt ; push
authentifié à la commande plutôt que par `persist-credentials`.

### R8 — Les fichiers de configuration d'aider sont écrasables par le modèle · lot 3b

`--config` est cherché dans le **git root**, `--env-file` vaut `.env` du **git
root**, `--model-metadata-file` vaut `.aider.model.metadata.json`. Le git root, c'est
le checkout du dépôt consommateur — là où aider écrit.

Un `.aider.conf.yml` créé à l'itération 1 est **chargé** à l'itération 2 : il peut
fixer `lint-cmd` (commande arbitraire, exécutée car `--auto-lint` vaut `True`), ou
via `.env` n'importe quelle option préfixée `AIDER_`, y compris une base d'API
pointant ailleurs — ce qui exfiltre d'un coup la clé, tous les prompts et la carte du
dépôt.

Traitement : `--config` et `--model-metadata-file` pointés sur des fichiers embarqués
dans l'action, `--env-file /dev/null`, `--no-auto-lint`,
`--no-suggest-shell-commands`, et ces chemins dans la liste interdite.

### R9 — Branche distante préexistante → push non-fast-forward · lot 3a

La garde refuse quand une PR est **ouverte**. Le cas non traité : `fix-issue-42`
existe **sur le remote** (PR fermée sans suppression de branche, run précédent
annulé après le push). Sur un runner neuf il n'y a aucune branche locale, donc
`git switch -c` réussit, et le push est rejeté — après avoir tout consommé.

### R10 — Concurrence · lots 2 et 6

Deux `@dseek` rapprochés : les deux gardes voient zéro PR ouverte, les deux jobs
créent `fix-issue-<n>`. La garde n'est pas un verrou — la PR n'existe que plusieurs
minutes après le démarrage. Et `concurrency` n'existe pas dans une composite action :
c'est au workflow consommateur, donc au lot 6, de le prescrire.

Variante par rejeu : `types: [edited]` fait relancer un cycle complet à chaque
édition d'un commentaire contenant déjà `@dseek`.

### R11 — `ubuntu-latest` basculera sur 26.04 · lot 4

Python 3.14.4 sur 26.04, contre `requires_python = "<3.13"` pour aider : `pipx
install aider-chat` échouera à la résolution. `ubuntu-latest` pointe encore sur 24.04
aujourd'hui, mais la migration est annoncée. Traitement : `actions/setup-python` avec
`3.12`, et `runs-on: ubuntu-24.04` en dur dans l'exemple du lot 6.

### R12 — Aucun compte rendu si le job échoue, expire ou est annulé · lot 4

Une composite action n'a **pas** de `post:`. Si `resolve.js` plante (quota DeepSeek,
clé refusée), si le `timeout-minutes` du consommateur tombe, ou si le job est annulé,
il ne reste que la réaction 👀 : aucun commentaire, aucun signal. Traitement : un
step final `if: always()`, que le schéma des composites autorise.

## Architecture cible

```
action.yml                    # using: composite, 4 steps + outputs
aider.conf.yml                # configuration d'aider, maîtrisée par l'action (R8)
aider-models.json             # métadonnées des modèles DeepSeek V4 (R5)
scripts/garde.js              # événement, autorisation, anti-rejeu — avant l'install
scripts/resolve.js            # préparation + primitives + orchestration
scripts/rendre-compte.js      # step if: always() (R12)
scripts/lib/gh.js             # wrapper CLI gh, binaire injectable par GH_CLI
scripts/lib/git.js            # wrapper git
scripts/lib/chemins.js        # liste interdite + normalisation (R3, R8)
scripts/lib/texte.js          # nettoyage du texte tiers, masquage, troncature (R6, R7)
__fixtures__/*.json           # payloads d'événement
__fixtures__/gh-stub.sh       # stub gh versionné
__fixtures__/aider-stub.sh    # stub aider versionné (rend 3b/3c testables hors ligne)
test/garde.test.js
test/boucle.test.js
.github/workflows/test.yml
README.md                     # à réécrire, aligné sur un plan abandonné
CLAUDE.md                     # à réécrire, décrit une architecture qui disparaît
.gitignore                    # absent aujourd'hui
```

## Lots

| Lot | Sujet | Dépend de |
| --- | --- | --- |
| — | [`contrat.md`](contrat.md) — noms, versions, signatures | — |
| [0](lot-0-menage.md) | Ménage : suppression de `src/`, `.gitignore` | — |
| [1](lot-1-wrappers.md) | `scripts/lib/` — 4 modules + les 2 stubs | contrat |
| [2](lot-2-garde.md) | `scripts/garde.js` + fixtures + `test/garde.test.js` | 1 |
| [3a](lot-3a-preparation.md) | Identité git, branche, R1 + R9 | 1 |
| [3b](lot-3b-primitives.md) | Primitives : aider, validation, commit, publication | 3a |
| [3c](lot-3c-orchestration.md) | La boucle qui les compose, R4, `no-publish` | 3b |
| [4](lot-4-action-yml.md) | `action.yml` composite, `rendre-compte.js` | 2, 3c |
| [5](lot-5-ci.md) | `.github/workflows/test.yml` | 2, 3c, 4 |
| [6](lot-6-readme.md) | `README.md` | 4 |
| [7](lot-7-claude-md.md) | `CLAUDE.md` | 4 |
| [8](lot-8-publication.md) | Branche de travail, tags, rollback | 5 |

Lots 0 et 1 parallélisables d'entrée. Lots 6 et 7 parallélisables après le 4.

Le découpage 3a/3b/3c a été **refait**. Auparavant, le lot « publication » (3c)
devait insérer du code *à l'intérieur* de la boucle écrite par le lot « boucle »
(3b) : couture garantie. Désormais 3b n'écrit que des fonctions aux signatures
fixées par le contrat, et 3c n'écrit que l'orchestrateur qui les appelle. Les trois
lots écrivent le même fichier `resolve.js`, ce qui interdit de les paralléliser —
c'était déjà vrai avant.

## État intermédiaire cassé — travailler sur une branche

Entre le lot 0 et le lot 4, `action.yml` déclare `main: src/index.js` sur un fichier
supprimé : l'action est totalement inutilisable. Comme il n'existe **aucun tag**,
personne ne consomme ce dépôt et il n'y a aucune conséquence externe. Travailler
malgré tout sur `feat/composite-aider`, fusionnée après le lot 5 vert : c'est ce qui
permet à la CI du lot 5 de tourner sur une PR avant d'atterrir sur `main`.

## Vérification de bout en bout

Sur un dépôt de test privé jetable, un test qui échoue volontairement lancé par
`npm test`. **Le workflow et la référence de l'action doivent être sur la branche par
défaut du dépôt de test** : un événement `issues` / `issue_comment` ne voit que
celle-là. Sans cela, « rien ne se passe » et on cherche longtemps.

Ce travail n'est rattaché à aucun lot parce qu'il ne produit aucun fichier. Il exige
une vraie `DEEPSEEK_API_KEY`. Les cas 4, 5, 8 et 9 sont aussi couverts hors ligne par
le lot 5 grâce au stub `AIDER_CLI` ; les autres non.

1. `no-publish: true` → aider produit un diff plausible dans les logs, aucune PR.
2. `no-publish: false` → branche poussée, PR ouverte, un commentaire par itération.
3. `max-iterations: 1` sur un test insoluble → un seul cycle, message d'échec.
4. Un test qui modifie un fichier qu'aider édite ensuite → il n'apparaît pas dans le
   commit (R2).
5. Une issue demandant de modifier un workflow → refus explicite, pas d'échec de
   push (R3).
6. `@dseek` depuis un compte `COLLABORATOR` en lecture seule → refus (R6, étage 2).
7. Une issue sans rien à corriger → commentaire « aucune modification », pas de PR (R4).
8. Une issue dont le corps contient un `<!-- … -->` avec une consigne → le bloc est
   absent du prompt publié dans la PR (R6).
9. Une issue demandant de créer `.aider.conf.yml` → chemin refusé (R8).
10. Une branche `fix-issue-<n>` laissée sur le remote → réutilisée, pas de rejet au
    push (R9).
11. Job tué par `timeout-minutes` → un commentaire d'échec est publié quand même (R12).

## Le but a-t-il dérivé ?

Contrôle fait après la révision, parce que le plan a doublé de volume : 9 lots et
1259 lignes avant, 12 lots plus un contrat et 2480 lignes après.

### Ce qui n'a pas changé

L'intention en tête de ce document est reprise **mot pour mot** de la version
précédente. Chaque élément survit :

| Élément du but | Où il vit |
| --- | --- |
| `@dseek` dans une issue ou un commentaire | lot 2 |
| Branche `fix-issue-<n>` | lot 3a |
| Pull Request | lot 3b, `publierInitial` |
| Boucle bornée jusqu'à ce que la validation passe | lot 3c, `MAX_ITERATIONS` |
| Comptes rendus en français | lot 3b, formulations reprises du code supprimé |
| Ne plus écrire la boucle d'agent | aider, lot 3b |

Et la décision de fond tient : nous n'écrivons **aucun** appel à une API de modèle,
aucune sélection de contexte, aucune extraction de patch, aucune application de
patch. C'étaient les trois défauts structurels de `src/`, et c'est exactement la
couche qu'aider reprend.

### Ce que le plan coûte en plus

Sept artefacts se sont ajoutés à la révision. Aucun n'est de l'agent : ce sont de
l'orchestration et des garde-fous.

| Ajout | Risque qui l'impose |
| --- | --- |
| `scripts/lib/chemins.js` | R3, R8 |
| `scripts/lib/texte.js` | R6, R7 |
| `scripts/rendre-compte.js` | R12 |
| `aider-models.json` | R5 — bloquant : sans lui, aider peut refuser de démarrer |
| `aider.conf.yml` | R8 |
| `__fixtures__/aider-stub.sh` + `test/boucle.test.js` | rendent les lots 3b et 3c vérifiables |

Verdict : pas de dérive de but. Le plan est plus lourd parce qu'il a cessé de
supposer, pas parce qu'il a changé d'objectif.

### Deux arbitrages à trancher avant d'écrire une ligne de code

Ils ne relèvent pas de l'implémentation. Ils ont surgi de la révision et ils
appartiennent au propriétaire du projet.

1. **Le code source part chez DeepSeek**, carte du dépôt et contenus de fichiers, à
   chaque appel. Sur un dépôt privé professionnel, c'est un transfert vers un tiers
   hors UE. Si la réponse est non, ni ce plan ni aucune variante ne s'applique : le
   sujet précède le choix technique.

2. **Le périmètre réel de l'action est : tout ce que le job peut faire, l'auteur du
   texte traité peut le faire.** L'injection de prompt n'a pas de correctif (R6). Les
   mesures des lots 2, 3b et 3c réduisent la probabilité, jamais la possibilité.
   Posture recommandée, à valider : dépôt privé, à faible enjeu, entre gens qui ont
   déjà le droit d'écriture, sans autre secret dans le job, sans auto-merge,
   protection de branche sur la branche par défaut. Sur un dépôt public à enjeu, ne
   pas installer cette action.

Ces deux points sont détaillés au lot 6 pour les utilisateurs. Ils sont ici parce
qu'ils conditionnent l'opportunité du projet, pas seulement sa documentation.

## Points ouverts

Il n'en reste qu'un. Les trois précédents sont clos :

- ~~version d'aider à épingler~~ → `0.86.2`, dans le contrat.
- ~~défaut de `--git-commit-verify`~~ → `False`, vérifié. aider commite donc avec
  `--no-verify` : aucun hook `pre-commit` du consommateur ne peut faire échouer son
  commit. **Effet de bord à documenter au lot 6** : les linters et scanners de
  secrets du consommateur sont contournés sur ces commits.
- ~~stratégie de neutralisation R2~~ → tranchée par `--no-auto-commits`.

**Reste ouvert** : faut-il installer aider par `pipx install "aider-chat==0.86.2"`
ou par un venv et `pip install --require-hashes -r aider-lock.txt` ? L'épinglage de
version est plus fort que le plan précédent ne le croyait — aider épingle ses
dépendances en `==`, et PyPI interdit la réutilisation d'un nom de fichier. Le
verrou hashé ne couvre qu'une compromission d'index ou de miroir, au prix d'un
fichier à régénérer à chaque montée de version. Tranché au lot 4, à l'implémentation.
