# Lot 3c — L'orchestration

**Dépend de** : lot 3b. **Fichier** : `scripts/resolve.js`, partie aval.
Lire [`contrat.md`](contrat.md).

## Objectif

Composer les primitives du lot 3b. **Ce lot n'écrit aucune primitive** : il n'appelle
que les sept fonctions dont le contrat fixe les signatures. S'il manque une capacité,
elle s'ajoute au lot 3b, pas ici.

## La boucle

**Réécrit après l'écriture du lot 3b.** La version précédente appelait les primitives
sans `config`, inventait un `consigneCorrection(...)` qui n'existe pas, et refaisait
ici le masquage et la troncature des logs — que le lot 3b fait désormais à la source.
Les signatures ci-dessous sont celles de `contrat.md`, sans exception.

```
consigne = construireConsigne(config)                 # lot 3b
r = appelerAider(config, consigne)
si r.codeSortie != 0 → arrêt immédiat, compte rendu d'échec technique

c = commiterTravail("Résolution de l'issue #<n>")
si !aDesCommits(preparation.shaDepart) → chemin R4, ci-dessous

pr = publierInitial(config, preparation, consigne)    # push + gh pr create

pour i de 1 à MAX_ITERATIONS :
    v = executerValidation(config)
    publierTour(config, i, {
        validationOk: v.codeSortie == 0,
        codeSortieValidation: v.codeSortie,
        premierEchec: v.premierEchec,
        refuses: c.refuses,
        derniereIteration: i == MAX_ITERATIONS,
    })
    si v.codeSortie == 0 → succès, sortir
    si i == MAX_ITERATIONS → échec, sortir

    r = appelerAider(config, construireConsigne(config, { logsEchec: v.logs }))
    si r.codeSortie != 0 → arrêt immédiat, échec technique
    c = commiterTravail("Itération <i+1> : correction")
    si c.commite → push

publierCompteRendu(config, bilan)
```

Trois points que cette réécriture fige :

- **`aDesCommits(preparation.shaDepart)`, jamais `shaBase`.** Sur une branche reprise,
  `shaBase..HEAD` est déjà non nul avant le premier appel à aider, et le contrôle R4 ne
  détecte plus rien. Cf. `contrat.md`, « Pourquoi `shaDepart` en plus de `shaBase` ».
- **Ni `masquerSecrets` ni `tronquer` ici.** `executerValidation` rend des `logs` déjà
  masqués, et `construireConsigne` tronque `logsEchec` lui-même. Les refaire au lot 3c
  donnerait deux vérités sur la même donnée.
- **`v.logs` ne part jamais dans un commentaire.** Seuls `codeSortie` et `premierEchec`
  sont publiables ; c'est la raison d'être du troisième champ rendu par
  `executerValidation`.

## Pourquoi pas `--auto-test`

aider sait faire cette boucle seul, avec `--test-cmd` et `--auto-test`. On ne l'utilise
pas :

1. Le nombre de tentatives d'`--auto-test` n'est pas documenté comme bornable.
   `max-iterations` deviendrait décoratif.
2. On veut un commentaire de PR par itération, ce qui suppose de reprendre la main entre
   chaque tour.

Et c'est le bon schéma pour ce genre d'automatisation : l'agent ne décide pas de son
propre verdict.

## Ordre des opérations

Push et `gh pr create` **juste après le premier commit**, avant la première validation.
Bénéfice : si le job est interrompu, annulé, ou tué par le `timeout-minutes` du
consommateur, le travail déjà fait est poussé et visible dans une PR ouverte au lieu
d'être perdu.

La version précédente avait d'abord envisagé de mettre les commentaires en file
d'attente jusqu'à l'ouverture de la PR. Inutilement compliqué, et l'ordre ci-dessus le
rend sans objet.

## Le code de sortie d'aider

**Contrôlé après chaque appel, et fatal.** Clé refusée (401), crédit épuisé (402),
quota, modèle rejeté, plantage Python : sans ce contrôle, la boucle enchaîne sur la
validation, échoue, relance aider qui replante, consomme `max-iterations`, et le chemin
R4 rapporte « aucune modification proposée » — diagnostic faux sur le mode de panne le
plus probable en production.

Le compte rendu doit distinguer trois issues, pas deux :

| Issue | Message |
| --- | --- |
| Validation passée | succès |
| `max-iterations` atteint, validation toujours rouge | échec de résolution |
| aider a rendu un code non nul | **échec technique**, avec sa sortie tronquée et masquée |

## Risque R4 — aider ne commite rien

Trois situations : le modèle estime qu'il n'y a rien à faire, il refuse, ou toutes ses
éditions échouent. Alors `git push` ne pousse aucun commit et `gh pr create` échoue sur
`No commits between <base> and fix-issue-<n>`.

Contrôle obligatoire avant tout push : `aDesCommits(base)`. Si faux :

- publier un commentaire sur l'**issue** — la PR n'existe pas — indiquant qu'aucune
  modification n'a été proposée, avec le motif si aider en a donné un ;
- sortir en **code 0**. Ce n'est pas une panne de l'action, c'est un résultat.

Cas particulier à traiter : R4 **et** `no-publish`. Le mode interdit toute publication,
donc pas de commentaire d'issue — journalisation seule.

## Contrôle de ceinture avant push

`git log --name-only <base>..HEAD` ne doit contenir aucun chemin interdit. Le lot 3b
garantit déjà qu'aucun n'a été stagé ; ce contrôle attrape une régression ou un chemin
qui aurait échappé à la normalisation. Un push refusé pour cause de `workflows` coûte
toutes les itérations.

## `no-publish`

L'input s'appelle **`no-publish`**, pas `dry-run`. Le renommage est délibéré :
`dry-run` fait croire à un bac à sable sûr, et ce n'en est pas un.

Quand `SANS_PUBLICATION === 'true'` : toute la séquence se déroule — identité, branche,
appels aider, commits locaux, validation, boucle — mais **ni push, ni `gh pr create`,
ni aucun commentaire**. Le diff reste consultable par `git log -p <base>..HEAD` dans les
logs du job.

À écrire noir sur blanc, au lot 6 aussi : **`no-publish` n'atténue aucun risque de
sécurité.** Le code est écrit dans le checkout, aider commite en local, et la
`validation-command` s'exécute. R6, R7 et R8 sont intacts ; seule la publication
disparaît.

## Annotations de job

`::group::` par itération pour que les logs restent navigables, et `::error::` /
`::warning::` sur les refus — chemin interdit, R4, échec technique — pour qu'ils
remontent au résumé du job et non seulement dans le corps des logs.

## Renseigner les outputs de l'action

Écrire dans `GITHUB_OUTPUT` : `numero-pr`, `iterations`, `succes`. Le lot 4 les remonte
en `outputs:` d'action, et c'est ce qui donne au smoke test du lot 5 quelque chose à
contrôler.

## Vérification

Hors ligne d'abord, avec `AIDER_CLI` et `GH_CLI` stubés — c'est le gros apport par
rapport à la version précédente, qui ne pouvait rien vérifier sans clé API :

1. Stub qui écrit un fichier et une validation qui passe → un tour, succès, `iterations=1`.
2. Stub qui écrit un fichier et une validation qui échoue toujours, `MAX_ITERATIONS=2`
   → **exactement deux tours, deux appels de validation, DEUX appels d'aider**. Le
   décompte était ambigu dans la version précédente de ce fichier (« trois… soit
   deux ») : il est tranché ici, en dépliant la boucle.

   | Étape | Appel |
   | --- | --- |
   | consigne initiale | aider nº 1 |
   | tour 1 | validation nº 1 → rouge, donc aider nº 2 (correction) |
   | tour 2 | validation nº 2 → rouge, et `i == MAX_ITERATIONS` : on sort **sans** relancer aider |

   Le dernier tour ne relance jamais aider : le faire produirait un commit que rien ne
   valide jamais. C'est là qu'une erreur de borne se cache, et c'est pour ça que le test
   compte les appels au lieu de constater « ça a bouclé ».
3. Stub qui n'écrit rien → chemin R4, aucune PR, code de sortie 0.
4. Stub qui sort en code 1 → arrêt immédiat, compte rendu d'échec technique, aucune
   itération consommée.
5. `SANS_PUBLICATION=true` → aucun appel `gh` de publication dans le journal du stub,
   commits présents en local.

Puis, avec une vraie clé et un dépôt jetable, les cas 1 à 3 et 7 de la vérification de
bout en bout du plan maître.
